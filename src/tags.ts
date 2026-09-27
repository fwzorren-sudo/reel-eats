import { TAGS } from "./types";

/**
 * Occasion and vibe tags from what the post says, without AI. Each pattern is narrow on
 * purpose: "share with your group chat" shouldn't tag a place as good for groups.
 */
const TAG_RULES: [RegExp, (typeof TAGS)[number]][] = [
  [/\bdate night\b|\bromantic\b|\banniversary\b/, "date night"],
  [/\bcoffee dates?\b/, "coffee date"],
  [/\bbrunch\b/, "brunch"],
  [/\bwork from\b|\bspace to work\b|\bwork[- ]friendly\b|\blaptop\b|\bremote work\b|\bstudy spot\b|\bwi-?fi\b/, "work-friendly"],
  [/\boutdoors?(?:\s+\w+){0,2}\s+(?:seating|space|patio|dining|area|tables)\b|\bpatio\b|\bterrace\b|\bbeer garden\b|\bal fresco\b/, "outdoor seating"],
  [/\broof ?top\b/, "rooftop"],
  [/\b(?:skyline|city|ocean|water|river|lake|sunset|mountain) views?\b|\bviews? of the\b|\b(?:amazing|incredible|stunning|best) views?\b/, "views"],
  [/\blate[- ]night\b|\bopen late\b|\bopen (?:till|until) \d|\bafter midnight\b|\b24\/7\b|\bopen 24 hours\b/, "late night"],
  [/\bquick (?:bite|lunch)\b|\bgrab[- ]and[- ]go\b|\bon the go\b/, "quick bite"],
  [/\bcheap eats\b|\bon a budget\b|\bunder \$\d+\b|\baffordable\b|\bbang for (?:your|the) buck\b/, "cheap eats"],
  [/\bsplurge\b|\bfine dining\b|\btasting menu\b|\bomakase\b|\bmichelin\b|\bspecial occasion\b/, "splurge"],
  [/\bkids?[- ]friendly\b|\bfamily[- ]friendly\b|\bbring the (?:kids|family)\b|\bkids'? menu\b/, "family-friendly"],
  [/\b(?:big|large) groups?\b|\bgreat for groups\b|\bgroup dinners?\b|\bbirthday dinners?\b|\bfamily[- ]style\b/, "groups"],
  [/\bdog[- ]friendly\b|\bpup(?:py)?[- ]friendly\b|\bbring (?:your|the) (?:dog|pup)\b/, "dog-friendly"],
  [/\bvegan\b|\bvegetarian\b|\bplant[- ]based\b/, "vegetarian-friendly"],
  [/\bcocktails?\b|\bmartinis?\b|\bmargaritas?\b|\bspeakeasy\b|\bmixology\b/, "cocktails"],
  [/\blive (?:music|jazz|band|dj)\b|\bjazz (?:night|bar)\b/, "live music"],
  [/\btake[- ]?out\b|\btakeaway\b|\bto[- ]go (?:orders?|only|window)\b/, "takeout"],
];

export function ruleTags(text: string): string[] {
  const hay = text.toLowerCase();
  return TAG_RULES.filter(([re]) => re.test(hay)).map(([, tag]) => tag);
}

/** Google's price level says something too. Most cafes and bakeries are "$", so it means little there. */
export function priceTags(priceLevel: string | null | undefined, category = ""): string[] {
  if (priceLevel === "$$$$") return ["splurge"];
  if (priceLevel === "$" && !/Coffee|Bakery|Bar/.test(category)) return ["cheap eats"];
  return [];
}

/** Keep only known tags, once each, in the list's order. */
export function cleanTags(...lists: (unknown[] | null | undefined)[]): string[] {
  const wanted = new Set(
    lists.flatMap((l) => l ?? []).map((t) => (typeof t === "string" ? t.trim().toLowerCase() : "")),
  );
  return TAGS.filter((t) => wanted.has(t)).slice(0, 6);
}

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const UNTIL = new RegExp(`\\b(?:until|through|thru|till|til|ends?|ending)\\s+(${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}\\/\\d{1,2})`, "i");

/**
 * A reason to go soon, when the post says the place just opened, is a pop-up, or has
 * something for a limited time. Returns "" when there's none.
 */
export function ruleGoSoon(text: string): string {
  const hay = text.toLowerCase();
  const until = text.match(UNTIL)?.[1]?.replace(/\s+/g, " ");
  const withDate = (label: string) => (until ? `${label} through ${until}` : label);
  if (/\bpop[- ]?ups?\b/.test(hay)) return withDate("Pop-up");
  if (/\blimited[- ]time\b|\bseasonal\b|\bthis (?:week|weekend|month) only\b|\bonly (?:until|through|till)\b|\bfor a limited\b|\bwhile (?:it|they) lasts?\b/.test(hay)) {
    return withDate("Limited time");
  }
  if (/\b(?:just|newly|recently) opened\b|\bbrand[- ]new\b|\bgrand opening\b|\bnow open\b|\bnew (?:location|spot|opening)\b|\bsoft[- ]open|\bjust opened\b|\bopening (?:day|week)\b/.test(hay)) {
    return "New opening";
  }
  return "";
}
