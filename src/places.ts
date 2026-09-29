import { compact, distanceMeters, matchesAny, siteMatchesHandle, websiteHost } from "./geo";
import { currentTrace, errorText } from "./trace";
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
  // Same price tier as priceLevel, so it costs nothing extra.
  "priceRange",
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

const CURRENCY: Record<string, string> = { USD: "$", CAD: "CA$", AUD: "A$", NZD: "NZ$", MXN: "MX$", EUR: "€", GBP: "£", JPY: "¥" };

interface Money {
  currencyCode?: string;
  units?: string;
}

/** "$20–30" from Google's price range per person, "$100+" when it has no top end. */
export function formatPriceRange(range: { startPrice?: Money; endPrice?: Money } | undefined): string {
  const start = range?.startPrice?.units;
  const end = range?.endPrice?.units;
  if (!start && !end) return "";
  const code = range?.startPrice?.currencyCode ?? range?.endPrice?.currencyCode ?? "USD";
  const sign = CURRENCY[code] ?? `${code} `;
  if (start && end) return `${sign}${start}–${end}`;
  return start ? `${sign}${start}+` : `Up to ${sign}${end}`;
}

/**
 * Google's yes/no features worth showing, in this order. Asked for only when a place is opened:
 * they, and the review summary, are in Google's pricier Atmosphere tier.
 */
const FEATURES: [string, string][] = [
  ["outdoorSeating", "Outdoor seating"],
  ["liveMusic", "Live music"],
  ["goodForGroups", "Good for groups"],
  ["goodForChildren", "Good for kids"],
  ["allowsDogs", "Dogs allowed"],
  ["servesVegetarianFood", "Vegetarian options"],
  ["servesCocktails", "Cocktails"],
  ["servesBrunch", "Brunch"],
  ["reservable", "Takes reservations"],
  ["takeout", "Takeout"],
  ["delivery", "Delivery"],
];

export interface ReviewSummary {
  text: string;
  /** "Summarized with Gemini", in the reader's language. Shown under the summary, unchanged. */
  disclosure: string;
  flagUri: string;
  reviewsUri: string;
}

export interface PlaceExtras {
  summary: ReviewSummary | null;
  features: string[];
}

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
  priceRange?: { startPrice?: Money; endPrice?: Money };
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

  private async call(path: string, init: RequestInit, fieldMask: string, label: string): Promise<unknown> {
    if (!this.apiKey) throw new PlacesError("GOOGLE_MAPS_API_KEY is not set on the Worker.");
    const t0 = Date.now();
    const step = path.includes("searchText") ? "google search" : "google details";
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": fieldMask,
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      currentTrace()?.add(step, Date.now() - t0, false, label, errorText(err));
      throw err;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; places?: unknown[] };
    if (!res.ok) {
      const message = `Google Places error ${res.status}: ${body.error?.message ?? "unknown error"}`;
      currentTrace()?.add(step, Date.now() - t0, false, label, message);
      throw new PlacesError(message);
    }
    const n = body.places?.length ?? 0;
    const found = step === "google search" ? `${n} ${n === 1 ? "result" : "results"}` : "found";
    currentTrace()?.add(step, Date.now() - t0, true, `${label} → ${found}`);
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
    // The log names home rather than its coordinates.
    const nearHome = opts.bias && opts.home && opts.bias.lat === opts.home.lat && opts.bias.lng === opts.home.lng;
    const radius = opts.bias && "radius" in opts.bias ? ` within ${Math.round(opts.bias.radius / 1000)} km of` : " near";
    const where = !opts.bias ? "" : nearHome ? " near home" : `${radius} ${opts.bias.lat.toFixed(4)},${opts.bias.lng.toFixed(4)}`;
    const json = (await this.call(
      "/v1/places:searchText",
      { method: "POST", body: JSON.stringify(body) },
      FIELDS.map((f) => `places.${f}`).join(","),
      `"${textQuery}"${where}`,
    )) as { places?: RawPlace[] };
    return (json.places ?? []).filter((p) => p.location).map((p) => toCandidate(p, opts.home ?? null));
  }

  /** Google's review summary and features for a place. Never stored: Google's terms don't allow keeping them. */
  async extras(placeId: string): Promise<PlaceExtras> {
    const mask = ["reviewSummary", "googleMapsLinks", ...FEATURES.map(([f]) => f)].join(",");
    const json = (await this.call(`/v1/places/${encodeURIComponent(placeId)}`, { method: "GET" }, mask, `${placeId} (review summary)`)) as Record<
      string,
      unknown
    > & {
      reviewSummary?: { text?: { text?: string }; disclosureText?: { text?: string }; flagContentUri?: string; reviewsUri?: string };
      googleMapsLinks?: { reviewsUri?: string };
    };
    const r = json.reviewSummary;
    const text = r?.text?.text?.trim() ?? "";
    return {
      summary: text
        ? {
            text,
            disclosure: r?.disclosureText?.text?.trim() || "Summarized with Gemini",
            flagUri: r?.flagContentUri ?? "",
            reviewsUri: r?.reviewsUri || json.googleMapsLinks?.reviewsUri || "",
          }
        : null,
      features: FEATURES.filter(([f]) => json[f] === true).map(([, label]) => label),
    };
  }

  async details(placeId: string, home: GeoPoint | null): Promise<PlaceCandidate | null> {
    const json = (await this.call(`/v1/places/${encodeURIComponent(placeId)}`, { method: "GET" }, FIELDS.join(","), placeId)) as RawPlace;
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
    priceRange: formatPriceRange(p.priceRange),
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

/** When nothing else says what a place is, the post's own tags. */
const TAG_CATEGORIES: [string, Category][] = [
  ["cocktails", "Bar & Drinks"],
  ["coffee date", "Coffee & Cafe"],
  ["brunch", "Breakfast & Brunch"],
];

/**
 * Google's type first. When it only says "restaurant", the cuisine and dishes from the post,
 * then the name, then the post's opening line ("Wizardry Themed Pop-Up Bar"), and last the
 * post's tags: Google calls The Drunken Laboratory a restaurant, but the reel is about drinks.
 */
export function categoryFor(c: PlaceCandidate, cuisine = "", dishes: string[] = [], postOpening = "", tags: string[] = []): Category {
  for (const texts of [[c.primaryType, c.typeLabel], [cuisine, ...dishes], [c.name, ...c.types], [postOpening]]) {
    const guess = guessCategory(texts);
    if (guess !== "Other") return guess;
  }
  return TAG_CATEGORIES.find(([tag]) => tags.includes(tag))?.[1] ?? "Other";
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

/**
 * When the post names a city but the search there finds nothing by that name, a same-named
 * place from the search near home has to be about this close to that city. Wide enough for
 * a metro area and its suburbs.
 */
export const HINT_AREA_M = 60_000;

export interface Resolution {
  best: PlaceCandidate;
  /** Every matching branch, nearest to home first (includes `best`). */
  branches: PlaceCandidate[];
  /** The branch the reel was filmed at, when the post says where. Kept for pop-ups and events. */
  filmed: PlaceCandidate | null;
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

  // An Instagram handle is the venue's own spelling. A result whose website or name matches it
  // is the venue, even when Google's name differs ("CT Cantina & Taqueria" for @cttacos).
  const handles = [place.instagram_handle, ...place.alt_names].filter((h) => h && !/\s/.test(h));
  const byHandle = (c: PlaceCandidate) => handles.some((h) => siteMatchesHandle(c.website, h) || compact(c.name) === compact(h));
  const open = (c: PlaceCandidate) => c.businessStatus !== "CLOSED_PERMANENTLY" && (matchesAny(c.name, names) || byHandle(c));
  // Prefer food and drink businesses. With food_only, nothing else is accepted.
  const foodFirst = (list: PlaceCandidate[]) => {
    const matched = list.filter(open);
    const food = matched.filter(isFoodPlace);
    return food.length || place.food_only ? food : matched;
  };

  // When any result matches the handle, drop look-alikes that only share a similar name
  // ("Lalo's Cafe" when the reel tags @laylocafe), keeping other branches of the same business.
  const strong = [...near, ...hinted, ...plain].filter((c) => open(c) && byHandle(c));
  const strongHosts = new Set(strong.map((c) => websiteHost(c.website)).filter(Boolean));
  const pick = (list: PlaceCandidate[]) => {
    const matched = foodFirst(list);
    return strong.length ? matched.filter((c) => byHandle(c) || strongHosts.has(websiteHost(c.website))) : matched;
  };
  const nearMatches = pick(near);
  const hintMatches = pick(hinted);
  const plainMatches = pick(plain);

  let pool: PlaceCandidate[];
  if (hintMatches.length) {
    const hosts = new Set(hintMatches.map((h) => websiteHost(h.website)).filter(Boolean));
    const sameBrand = nearMatches.filter((n) => place.multi_location || hosts.has(websiteHost(n.website)));
    pool = [...hintMatches, ...sameBrand];
  } else if (where || filmed) {
    // Nothing by that name where the post says. A same-named place near home only counts when
    // it's in that area too, so "The 44 Club" in Boise isn't taken for the Atlanta speakeasy.
    // Whatever the city search did find (a neighbor, the building's other venue) shows where the
    // city is. When it found nothing at all, there's no telling, so the near-home match stands.
    const anchors: GeoPoint[] = [...hinted, ...(filmed ? [filmed] : [])];
    const town = where.split(",")[0].trim().toLowerCase();
    const inArea = (c: PlaceCandidate) =>
      !anchors.length ||
      anchors.some((a) => distanceMeters(a.lat, a.lng, c.lat, c.lng) <= HINT_AREA_M) ||
      (town.length > 2 && c.address.toLowerCase().includes(town));
    const far = nearMatches.filter((c) => !inArea(c));
    if (far.length) currentTrace()?.note("far away", `${far.map((c) => `${c.name}, ${c.address}`).join("; ")}: not near ${where || "the location tag"}`);
    pool = [...nearMatches.filter(inArea), ...plainMatches];
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

  // With coordinates from the location tag, the filmed branch is the match closest to them.
  const byFilmed = (c: PlaceCandidate) => (filmed ? distanceMeters(filmed.lat, filmed.lng, c.lat, c.lng) : 0);
  const filmedBranch = hintMatches.length ? [...hintMatches].sort((a, b) => byFilmed(a) - byFilmed(b))[0] : null;
  const branches = pool.slice(0, 12);
  const kept = filmedBranch ? branches.find((b) => b.id === filmedBranch.id) : null;
  if (filmedBranch && !kept) branches[branches.length - 1] = filmedBranch;
  return { best: pool[0], branches, filmed: filmedBranch ? (kept ?? filmedBranch) : null };
}
