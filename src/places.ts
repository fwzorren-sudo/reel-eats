import { distanceMeters, matchesAny, websiteHost } from "./geo";
import type { Category, Env, ExtractedPlace, GeoPoint, Home, OpeningHours, PlaceCandidate, SearchArea } from "./types";

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
  "primaryType",
  "types",
  "addressComponents",
  "regularOpeningHours",
  "utcOffsetMinutes",
  "timeZone",
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
  primaryType?: string;
  types?: string[];
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  regularOpeningHours?: { periods?: OpeningHours["periods"]; weekdayDescriptions?: string[] };
  utcOffsetMinutes?: number;
  timeZone?: { id?: string };
}

export class PlacesError extends Error {}

export function placesClient(env: Pick<Env, "GOOGLE_MAPS_API_KEY" | "PLACES_BASE_URL">): PlacesClient {
  return new PlacesClient(env.GOOGLE_MAPS_API_KEY, env.PLACES_BASE_URL || undefined);
}

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

  /**
   * `bias` is where to look; `home` is what distances are measured from.
   * They differ when searching around the spot a reel was filmed.
   */
  async textSearch(
    textQuery: string,
    opts: { bias?: GeoPoint | SearchArea | null; home?: GeoPoint | null; pageSize?: number } = {},
  ): Promise<PlaceCandidate[]> {
    const body: Record<string, unknown> = { textQuery, pageSize: opts.pageSize ?? 20 };
    if (opts.bias) {
      const radius = Math.min("radius" in opts.bias ? opts.bias.radius : BIAS_RADIUS_M, BIAS_RADIUS_M);
      body.locationBias = { circle: { center: { latitude: opts.bias.lat, longitude: opts.bias.lng }, radius } };
    }
    const json = (await this.call(
      "/v1/places:searchText",
      { method: "POST", body: JSON.stringify(body) },
      FIELDS.map((f) => `places.${f}`).join(","),
    )) as { places?: RawPlace[] };
    return (json.places ?? []).filter((p) => p.location).map((p) => toCandidate(p, opts.home ?? null));
  }

  async details(placeId: string, home: GeoPoint | null): Promise<PlaceCandidate | null> {
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

export function toCandidate(p: RawPlace, home: GeoPoint | null): PlaceCandidate {
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
    primaryType: p.primaryType ?? "",
    types: p.types ?? [],
    hours: p.regularOpeningHours?.periods
      ? { periods: p.regularOpeningHours.periods, weekdayDescriptions: p.regularOpeningHours.weekdayDescriptions ?? [] }
      : null,
    timeZone: p.timeZone?.id ?? "",
    utcOffset: p.utcOffsetMinutes ?? null,
  };
}

/** Branch lists are stored with each place, so leave out the bulky hours. */
export function branchSummary(c: PlaceCandidate): PlaceCandidate {
  return { ...c, hours: null };
}

const FOOD_TYPES = new Set([
  "restaurant", "food", "cafe", "coffee_shop", "bakery", "bar", "pub", "meal_takeaway", "meal_delivery",
  "ice_cream_shop", "dessert_shop", "donut_shop", "bagel_shop", "sandwich_shop", "deli", "juice_shop",
  "tea_house", "food_court", "confectionery", "chocolate_shop", "candy_store", "cafeteria", "diner",
  "bistro", "brewpub", "beer_garden", "brewery", "winery", "cat_cafe", "dog_cafe", "acai_shop",
  "food_truck", "night_club", "steak_house", "bar_and_grill", "chocolate_factory", "coffee_roastery",
  "coffee_stand", "tea_store", "pastry_shop", "cake_shop", "cupcake_shop",
]);

/**
 * Is this Google result a food or drink business, as opposed to a city, park, person or shop?
 * Only restaurant, bar and cafe types match by suffix; "_shop" would also match barber_shop.
 */
export function isFoodPlace(c: Pick<PlaceCandidate, "primaryType" | "types">): boolean {
  return [c.primaryType, ...c.types].some((t) => t && (FOOD_TYPES.has(t) || /_(restaurant|bar|cafe)$/.test(t)));
}

const CATEGORY_RULES: [RegExp, Category][] = [
  [/vegan|vegetarian/, "Vegetarian & Vegan"],
  [/pizz/, "Pizza"],
  [/burger/, "Burgers"],
  [/sandwich|deli\b|delicatessen|hoagie|sub shop/, "Sandwiches & Deli"],
  [/mexican|taco|tex mex|burrito|taqueria|birria/, "Tacos & Mexican"],
  [/seafood|oyster|fish|lobster|crab/, "Seafood"],
  [/steak/, "Steakhouse"],
  [/ramen|noodle|udon|pho\b/, "Ramen & Noodles"],
  [/sushi|japanese|izakaya|omakase/, "Japanese & Sushi"],
  [/italian|pasta|trattoria/, "Italian"],
  [/chinese|dim sum|dumpling|cantonese|sichuan|szechuan|hunan/, "Chinese"],
  [/korean/, "Korean"],
  [/thai/, "Thai"],
  [/vietnamese|banh mi/, "Vietnamese"],
  [/indian|pakistani|nepal|bangladeshi|sri lankan|curry/, "Indian"],
  [/mediterranean|middle eastern|greek|lebanese|turkish|israeli|persian|afghan|falafel|shawarma|kebab/, "Middle Eastern & Mediterranean"],
  [/latin|brazilian|peruvian|caribbean|cuban|colombian|argentin|venezuelan|salvadoran|puerto rican|dominican|jamaican|arepa|empanada/, "Latin & Caribbean"],
  [/barbecue|bbq|smokehouse/, "BBQ"],
  [/breakfast|brunch|pancake|waffle/, "Breakfast & Brunch"],
  [/bakery|dessert|ice cream|gelato|donut|doughnut|bagel|confection|chocolate|pastry|patisserie|cake|cookie|candy|acai/, "Bakery & Desserts"],
  [/coffee|cafe|espresso|tea house|matcha/, "Coffee & Cafe"],
  [/\bbar\b|pub|brew|wine|beer|cocktail|lounge|night club|speakeasy|winery|tavern/, "Bar & Drinks"],
  [/american|fast food|chicken|diner|hot dog|soul food|southern|wings|comfort/, "American & Comfort"],
];

/** Pick a category from Google place types and any cuisine words we have. */
export function guessCategory(texts: (string | null | undefined)[]): Category {
  const hay = texts
    .filter(Boolean)
    .map((t) => t!.toLowerCase().replace(/_/g, " "))
    .join(" | ");
  for (const [re, cat] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return "Other";
}

export function categoryFor(c: PlaceCandidate, cuisine = ""): Category {
  const fromPrimary = guessCategory([c.primaryType, c.typeLabel]);
  if (fromPrimary !== "Other") return fromPrimary;
  return guessCategory([cuisine, c.name, ...c.types]);
}

export function cuisineFor(c: PlaceCandidate): string {
  const label = c.typeLabel.replace(/\s*restaurant$/i, "").trim();
  return /^(restaurant|food|point of interest|establishment)$/i.test(label) ? "" : label;
}

export async function geocodeHome(client: PlacesClient, address: string): Promise<{ address: string; lat: number; lng: number } | null> {
  const results = await client.textSearch(address, { pageSize: 1 });
  const top = results[0];
  if (!top) return null;
  return { address: top.address || address, lat: top.lat, lng: top.lng };
}

/** "Shake Shack Madison Square Park" -> "Shake Shack". Short names are left alone. */
export function brandQuery(name: string): string {
  const words = name.replace(/\s*[-|@(].*$/, "").trim().split(/\s+/);
  return words.length >= 3 ? words.slice(0, 2).join(" ") : "";
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
 * where the reel was filmed (the city or address from the post, or around the location
 * tag's coordinates). A local result is only treated as the same business when the
 * post says it has several locations or it shares a website with the filmed place, so a
 * same-named local spot isn't mistaken for the one in the reel.
 */
export async function resolveBranch(client: PlacesClient, place: ExtractedPlace, home: Home | GeoPoint | null): Promise<Resolution | null> {
  const names = [place.name, ...place.alt_names].filter(Boolean);
  const query = place.search_query || place.name;
  const where = place.address_hint || place.city;
  const filmed = place.near ?? null;

  const [near, hinted, plain] = await Promise.all([
    home ? client.textSearch(query, { bias: home, home }) : Promise.resolve([]),
    where || filmed
      ? client.textSearch(where ? `${query} ${where}` : query, { bias: filmed ?? home, home, pageSize: 10 })
      : Promise.resolve([]),
    !home && !where && !filmed ? client.textSearch(query, { pageSize: 10 }) : Promise.resolve([]),
  ]);

  const open = (c: PlaceCandidate) => c.businessStatus !== "CLOSED_PERMANENTLY" && matchesAny(c.name, names);
  // Prefer food and drink businesses. With food_only, nothing else is accepted.
  const foodFirst = (list: PlaceCandidate[]) => {
    const matched = list.filter(open);
    const food = matched.filter(isFoodPlace);
    return food.length || place.food_only ? food : matched;
  };
  const nearMatches = foodFirst(near);
  const hintMatches = foodFirst(hinted);
  const plainMatches = foodFirst(plain);

  let pool: PlaceCandidate[];
  if (hintMatches.length) {
    const hosts = new Set(hintMatches.map((h) => websiteHost(h.website)).filter(Boolean));
    const sameBrand = nearMatches.filter((n) => place.multi_location || hosts.has(websiteHost(n.website)));
    pool = [...hintMatches, ...sameBrand];
  } else {
    pool = [...nearMatches, ...plainMatches];
  }

  if (!pool.length) return null;

  // Chains: a location tag like "Shake Shack Madison Square Park" names one branch.
  // Search the brand near home and keep results that share the same website.
  const host = websiteHost(pool[0].website);
  const brand = brandQuery(pool[0].name);
  if (home && host && brand && brand.toLowerCase() !== query.toLowerCase()) {
    try {
      const siblings = await client.textSearch(brand, { bias: home, home });
      pool.push(...siblings.filter((c) => c.businessStatus !== "CLOSED_PERMANENTLY" && websiteHost(c.website) === host));
    } catch {
      /* the branch we already have is still good */
    }
  }

  const seen = new Set<string>();
  pool = pool.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  if (home) pool.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  return { best: pool[0], branches: pool.slice(0, 12) };
}
