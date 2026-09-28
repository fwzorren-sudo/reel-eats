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

/** Loose evidence for each tag. A tag from AI is kept only when the post has one of these words. */
const TAG_EVIDENCE: Record<string, RegExp> = {
  "date night": /\bdate|romantic|anniversary|intimate|candle/,
  "coffee date": /coffee|latte|espresso|matcha/,
  brunch: /brunch/,
  "work-friendly": /\bwork|laptop|wi-?fi|study/,
  "outdoor seating": /outdoor|outside|patio|terrace|garden|al fresco/,
  rooftop: /roof/,
  views: /\bviews?\b|skyline|overlook/,
  "late night": /late|midnight|after dark|\b24\/7|\b[1-4] ?am\b/,
  "quick bite": /quick (?:bite|lunch|stop|meal)|grab[- ]and[- ]go|on the go|counter[- ]service|fast[- ]casual/,
  "cheap eats": /cheap|budget|affordable|under \$\d|inexpensive/,
  splurge: /splurge|fine dining|tasting menu|omakase|michelin|pricey|expensive|special occasion|treat yourself/,
  "family-friendly": /kid|family|children|stroller/,
  groups: /group|party|parties|crowd|birthday|friends/,
  "dog-friendly": /\bdogs?\b|pup|pet/,
  "vegetarian-friendly": /vegan|vegetarian|plant/,
  cocktails: /cocktail|drinks?\b|martini|margarita|speakeasy|mixolog|spritz|\bbar\b/,
  "live music": /music|\bband\b|jazz|\bdj\b|concert/,
  takeout: /take-?out|takeaway|to-?go|pick-?up|delivery/,
};

export function supportedTags(tags: string[], text: string): string[] {
  const hay = text.toLowerCase();
  return tags.filter((t) => TAG_EVIDENCE[t]?.test(hay) ?? false);
}

/**
 * Google's price level, only at the top end. Its "$" covers too much, a $40 brunch buffet
 * included, so "cheap eats" needs the post's own words.
 */
export function priceTags(priceLevel: string | null | undefined): string[] {
  return priceLevel === "$$$$" ? ["splurge"] : [];
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
const UNTIL_MONTH = new RegExp(`\\b(?:until|through|thru|till|ends?|ending)\\s+(?:the\\s+end\\s+of\\s+)?(${MONTH})(?![a-z])`, "i");

/** A pop-up, seasonal or limited-time note: tied to one branch and a window of time, unlike "New opening". */
export function isEventNote(note: string | null | undefined): boolean {
  if (!note || /^new opening$/i.test(note.trim())) return false;
  return /pop-?up|take ?over|taken over|limited|seasonal|through|until|only|halloween|christmas|holiday|this weekend|event/i.test(note);
}

/**
 * "New location just opened", "Now open" and "Brand new spot" all mean the same, so they read
 * "New opening". A soft opening, a date or an event note says more and is kept as it is.
 */
export function tidyGoSoon(note: string): string {
  const text = note.trim();
  if (!text || isEventNote(text) || /\d|\bsoon\b/i.test(text)) return text;
  if (/\bsoft[- ]?open/i.test(text)) return "Soft opening";
  if (
    /\b(?:just|newly|recently|now|finally)\s+open(?:ed)?\b|\bopen(?:ed|ing)\b|\bbrand[- ]new\b|\bnew (?:location|spot|place|restaurant|cafe|café|bar|bakery|shop)\b/i.test(text)
  ) {
    return "New opening";
  }
  return text;
}

/** The post says what it shows is only at one branch: "This is only at their new Dunwoody location!" */
export function oneLocationOnly(text: string): boolean {
  return /\b(?:only|exclusively) (?:at|available at|served at|offered at|happening at|found at) (?:their|the|our|this|that)\b[^.!?\n]{0,40}\blocations?\b|\bexclusive to (?:their|the|our|this)\b[^.!?\n]{0,40}\blocation\b|\b(?:this|that|one) location only\b|\bonly (?:this|one) location\b/i.test(
    text,
  );
}

/**
 * A reason to go soon, when the post says the place just opened, is a pop-up, or has
 * something for a limited time. Returns "" when there's none.
 */
export function ruleGoSoon(text: string): string {
  const hay = text.toLowerCase();
  const month = text.match(UNTIL_MONTH)?.[1];
  const until = text.match(UNTIL)?.[1]?.replace(/\s+/g, " ") ?? (month ? month[0].toUpperCase() + month.slice(1).toLowerCase() : undefined);
  const withDate = (label: string) => (until ? `${label} through ${until}` : label);
  if (/\bpop\s*-?\s*ups?\b|\btake ?overs?\b|\btaken over\b/.test(hay)) return withDate("Pop-up");
  if (/\bhalloween\b|\bspooky season\b|\bchristmas\b|\bholiday (?:season|menu|pop)|\bvalentine/.test(hay)) return withDate("Seasonal");
  if (/\blimited[- ]time\b|\b(?:available|served|offered|here|running) (?:only )?(?:until|through|thru|till)\b|\bthis (?:week|weekend|month) only\b|\bonly (?:until|through|till)\b|\bfor a limited\b|\bwhile (?:it|they) lasts?\b/.test(hay)) {
    return withDate("Limited time");
  }
  if (/\b(?:just|newly|recently) opened\b|\bbrand[- ]new\b|\bgrand opening\b|\bnow open\b|\bnew (?:location|spot|opening)\b|\bsoft[- ]open|\bjust opened\b|\bopening (?:day|week)\b|\bopens? (?:today|tomorrow|this week(?:end)?)\b/.test(hay)) {
    return "New opening";
  }
  return "";
}
