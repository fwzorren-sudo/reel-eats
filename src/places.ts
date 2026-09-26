import { distanceMeters, matchesAny, websiteHost } from "./geo";
import type { ExtractedPlace, Home, PlaceCandidate } from "./types";

const FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "googleMapsUri",
  "websiteUri",
  "nationalPhoneNumber",
  "rating",
  "userRatingCount",
  "priceLevel",
  "businessStatus",
  "primaryTypeDisplayName",
  "addressComponents",
];

const PRICE: Record<string, string> = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

/** Google's bias circle can't be larger than 50 km. */
const BIAS_RADIUS_M = 50000;

interface RawPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  googleMapsUri?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  businessStatus?: string;
  primaryTypeDisplayName?: { text?: string };
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
}

export class PlacesError extends Error {}

export class PlacesClient {
  constructor(
    private apiKey: string,
    private base = "https://places.googleapis.com",
  ) {}

  private async call(path: string, init: RequestInit, fieldMask: string): Promise<unknown> {
    if (!this.apiKey) throw new PlacesError("GOOGLE_MAPS_API_KEY is not set on the Worker.");
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      signal: AbortSignal.timeout(10000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) {
      throw new PlacesError(`Google Places error ${res.status}: ${body.error?.message ?? "unknown error"}`);
    }
    return body;
  }

  async textSearch(textQuery: string, opts: { bias?: Home | null; pageSize?: number } = {}): Promise<PlaceCandidate[]> {
    const body: Record<string, unknown> = { textQuery, pageSize: opts.pageSize ?? 20 };
    if (opts.bias) {
      body.locationBias = {
        circle: { center: { latitude: opts.bias.lat, longitude: opts.bias.lng }, radius: BIAS_RADIUS_M },
      };
    }
    const json = (await this.call(
      "/v1/places:searchText",
      { method: "POST", body: JSON.stringify(body) },
      FIELDS.map((f) => `places.${f}`).join(","),
    )) as { places?: RawPlace[] };
    return (json.places ?? []).filter((p) => p.location).map((p) => toCandidate(p, opts.bias ?? null));
  }

  async details(placeId: string, home: Home | null): Promise<PlaceCandidate | null> {
    const json = (await this.call(`/v1/places/${encodeURIComponent(placeId)}`, { method: "GET" }, FIELDS.join(","))) as RawPlace;
    return json.location ? toCandidate(json, home) : null;
  }
}

function cityOf(p: RawPlace): string {
  const comps = p.addressComponents ?? [];
  const find = (t: string) => comps.find((c) => c.types?.includes(t));
  const town = find("locality") ?? find("postal_town") ?? find("sublocality") ?? find("administrative_area_level_2");
  const region = find("administrative_area_level_1");
  return [town?.longText, region?.shortText].filter(Boolean).join(", ");
}

export function toCandidate(p: RawPlace, home: Home | null): PlaceCandidate {
  const lat = p.location!.latitude;
  const lng = p.location!.longitude;
  return {
    id: p.id,
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? "",
    city: cityOf(p),
    lat,
    lng,
    mapsUrl: p.googleMapsUri ?? "",
    website: p.websiteUri ?? "",
    phone: p.nationalPhoneNumber ?? "",
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    priceLevel: PRICE[p.priceLevel ?? ""] ?? "",
    businessStatus: p.businessStatus ?? "",
    typeLabel: p.primaryTypeDisplayName?.text ?? "",
    distanceM: home ? Math.round(distanceMeters(home.lat, home.lng, lat, lng)) : null,
  };
}

export async function geocodeHome(client: PlacesClient, address: string): Promise<Home | null> {
  const results = await client.textSearch(address, { pageSize: 1 });
  const top = results[0];
  if (!top) return null;
  return { address: top.address || address, lat: top.lat, lng: top.lng };
}

export interface Resolution {
  best: PlaceCandidate;
  /** Every matching branch, nearest to home first (includes `best`). */
  branches: PlaceCandidate[];
}

/**
 * Find the restaurant on Google Maps and pick the branch closest to home.
 *
 * Two searches run: the name near home (finds local branches of chains) and the name
 * in the city from the reel (finds the exact place that was filmed). A local result is
 * only treated as the same business when Claude said it has several locations or it
 * shares a website with the filmed place, so a same-named local spot isn't mistaken
 * for the one in the reel.
 */
export async function resolveBranch(client: PlacesClient, place: ExtractedPlace, home: Home | null): Promise<Resolution | null> {
  const names = [place.name, ...place.alt_names].filter(Boolean);
  const query = place.search_query || place.name;
  const where = place.address_hint || place.city;

  const [near, hinted, plain] = await Promise.all([
    home ? client.textSearch(query, { bias: home }) : Promise.resolve([]),
    where ? client.textSearch(`${query} ${where}`, { bias: home, pageSize: 10 }) : Promise.resolve([]),
    !home && !where ? client.textSearch(query, { pageSize: 10 }) : Promise.resolve([]),
  ]);

  const open = (c: PlaceCandidate) => c.businessStatus !== "CLOSED_PERMANENTLY" && matchesAny(c.name, names);
  const nearMatches = near.filter(open);
  const hintMatches = hinted.filter(open);
  const plainMatches = plain.filter(open);

  let pool: PlaceCandidate[];
  if (hintMatches.length) {
    const hosts = new Set(hintMatches.map((h) => websiteHost(h.website)).filter(Boolean));
    const sameBrand = nearMatches.filter((n) => place.multi_location || hosts.has(websiteHost(n.website)));
    pool = [...hintMatches, ...sameBrand];
  } else {
    pool = [...nearMatches, ...plainMatches];
  }

  const seen = new Set<string>();
  pool = pool.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  if (!pool.length) return null;

  if (home) pool.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  return { best: pool[0], branches: pool.slice(0, 12) };
}
