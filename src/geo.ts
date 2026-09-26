/** Great-circle distance in meters. */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const STOPWORDS = new Set([
  "the", "and", "of", "a", "an", "restaurant", "restaurants", "restaurante", "ristorante",
  "llc", "inc", "co",
]);

function normalize(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(name: string): string[] {
  const all = normalize(name).split(" ").filter(Boolean);
  const kept = all.filter((t) => !STOPWORDS.has(t));
  return kept.length ? kept : all;
}

function tokenEq(a: string, b: string): boolean {
  if (a === b) return true;
  // "deli" vs "delicatessen", "bros" vs "brothers"
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Does a Google Places name refer to the same business as the name from the reel?
 * Branch names often add a neighborhood ("Joe's Pizza Broadway"), so the reel's
 * name should be mostly contained in the place name.
 */
export function namesMatch(placeName: string, wanted: string): boolean {
  const compactA = normalize(placeName).replace(/ /g, "");
  const compactB = normalize(wanted).replace(/ /g, "");
  if (!compactA || !compactB) return false;
  if (compactA === compactB) return true;
  const [cShort, cLong] = compactA.length <= compactB.length ? [compactA, compactB] : [compactB, compactA];
  if (cShort.length >= 6 && cLong.startsWith(cShort)) return true;

  const placeTokens = tokens(placeName);
  const wantedTokens = tokens(wanted);
  if (!placeTokens.length || !wantedTokens.length) return false;
  const hits = wantedTokens.filter((w) => placeTokens.some((p) => tokenEq(p, w))).length;
  return hits / wantedTokens.length >= 0.66 && hits / placeTokens.length >= 0.34;
}

export function matchesAny(placeName: string, names: string[]): boolean {
  return names.some((n) => n && namesMatch(placeName, n));
}

// Hosts shared by unrelated businesses, so they say nothing about being the same chain.
const GENERIC_HOSTS = [
  "instagram.com", "facebook.com", "linktr.ee", "linkin.bio", "toasttab.com", "square.site",
  "squareup.com", "business.site", "yelp.com", "google.com", "doordash.com", "ubereats.com",
  "grubhub.com", "order.online", "resy.com", "opentable.com", "wixsite.com", "clover.com",
  "tiktok.com", "x.com", "twitter.com", "menufy.com", "chownow.com", "tock.com", "exploretock.com",
];

export function websiteHost(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (GENERIC_HOSTS.some((g) => host === g || host.endsWith("." + g))) return "";
    return host;
  } catch {
    return "";
  }
}
