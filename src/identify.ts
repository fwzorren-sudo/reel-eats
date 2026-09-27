import type { ExtractedPlace, SearchArea, SourceMeta } from "./types";

/** How far around a tagged venue, and around a tagged city, to look on Google Maps. */
export const VENUE_RADIUS_M = 1500;
export const CITY_RADIUS_M = 30000;

/**
 * Rule-based venue finding. No AI involved: it collects names the post itself points at,
 * and Google Places later confirms which ones are real food and drink businesses.
 */

export function candidate(name: string, extra: Partial<ExtractedPlace> = {}): ExtractedPlace {
  return {
    name,
    alt_names: [],
    search_query: name,
    city: "",
    address_hint: "",
    instagram_handle: "",
    category: "Other",
    cuisine: "",
    summary: "",
    dishes: [],
    multi_location: false,
    confidence: "medium",
    food_only: true,
    keep_unresolved: false,
    category_from_google: true,
    ...extra,
  };
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️⃣‍]/gu;

function tidy(s: string): string {
  return s
    .replace(/^\s*(?:\d\uFE0F?\u20E3|🔟)+/u, "")
    .replace(EMOJI, " ")
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/^\s*(?:\d{1,2}\s*[.):-]|[-–—•*·>]+)\s*/u, "")
    .replace(/^[\s:–—|-]+|[\s:,.;!–—|-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "tacos_del.norte" -> "tacos del norte" */
export function handleToName(handle: string): string {
  return handle.replace(/^@/, "").replace(/[._]+/g, " ").trim();
}

function splitNameAndPlace(text: string): { name: string; where: string } {
  const parts = text.split(/\s+[-–—|]\s+|,\s*|\s+in\s+|\s+@\s+|\s*\(\s*/i).map((p) => p.replace(/\)\s*$/, "").trim());
  return { name: parts[0] ?? "", where: parts.slice(1).filter(Boolean).join(", ") };
}

const looksLikeName = (s: string) => /\p{L}.*\p{L}/u.test(s) && s.length <= 60 && s.split(/\s+/).length <= 8;

const PIN = /📍|📌|\b(?:location|address|where|spot)\s*:/iu;
/** "📌 SAVE this for later", "📌 Follow @x": creators use pins for calls to action too. */
const CALL_TO_ACTION = /^(save|share|follow|tag|comment|like|dm|send|click|tap|link|subscribe|turn on|don'?t forget)\b/i;

/**
 * Food creators mark venues with a pin: "📍Tacos Del Norte, Queens" or
 * "1. Joe's Pizza 📍 Greenwich Village". Returns one entry per pinned line.
 */
export function pinnedPlaces(caption: string): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  for (const line of caption.split(/\n+/)) {
    const m = line.match(PIN);
    if (!m || m.index === undefined) continue;
    const before = tidy(line.slice(0, m.index));
    const after = tidy(line.slice(m.index + m[0].length));
    if (!before && CALL_TO_ACTION.test(after)) continue;
    let entry: { name: string; where: string };
    if (looksLikeName(before) && !/\b(location|address|where)\b/i.test(before)) entry = { name: before, where: after };
    else entry = splitNameAndPlace(after);
    entry.name = tidy(entry.name.replace(/^@/, ""));
    entry.where = tidy(entry.where);
    if (entry.name.includes("@")) entry.name = handleToName(entry.name.split("@").pop() ?? "");
    if (looksLikeName(entry.name)) out.push(entry);
  }
  return out;
}

/** The note typed in the app or the Shortcut: "Lucali, Carroll Gardens". */
export function noteCandidate(note: string): ExtractedPlace | null {
  const { name, where } = splitNameAndPlace(note.trim());
  const clean = tidy(name.replace(/^@/, ""));
  if (!clean) return null;
  return candidate(clean, {
    search_query: clean,
    address_hint: where,
    alt_names: note.trim().startsWith("@") ? [clean.replace(/\s+/g, "")] : [],
    instagram_handle: note.trim().startsWith("@") ? clean.replace(/\s+/g, "") : "",
    food_only: false,
    keep_unresolved: true,
    confidence: "high",
  });
}

/** "Rosetta Bakery (120 High St, Dunwoody, Georgia)" */
export function locationLine(meta: SourceMeta): string {
  const extra = [meta.location?.address, meta.location?.city].filter(Boolean).join(", ");
  return extra ? `${meta.locationName} (${extra})` : meta.locationName;
}

/** First sentence of the caption, without hashtags or @mentions, for the place's summary. */
export function captionSummary(caption: string): string {
  const firstLine =
    caption
      .split(/\n+/)
      .map((l) =>
        l
          .replace(/[@#][\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*/gu, "")
          .replace(/\s+/g, " ")
          .replace(/\s+([.,!?])/g, "$1")
          .trim(),
      )
      .find((l) => /\p{L}{3,}/u.test(l) && !PIN.test(l)) ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? "";
  return sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
}

export interface RuleCandidates {
  /** Names the post clearly marks as the place: pins and the location tag. */
  primary: ExtractedPlace[];
  /** Accounts the post points at: tagged users, @mentions, and the poster. Tried if nothing else is found. */
  fallback: ExtractedPlace[];
  /** A location tag like "Brooklyn, New York" says where, not which venue. */
  cityHint: string;
  /** The area around the location tag's coordinates, to search every name in. */
  area: SearchArea | null;
}

export function ruleCandidates(meta: SourceMeta | null, sharedText: string | null): RuleCandidates {
  const text = [meta?.caption, sharedText].filter(Boolean).join("\n");
  const primary: ExtractedPlace[] = [];
  const fallback: ExtractedPlace[] = [];
  let cityHint = "";

  for (const pin of pinnedPlaces(text)) primary.push(candidate(pin.name, { address_hint: pin.where }));

  const tag = meta?.locationName?.trim() ?? "";
  const loc = meta?.location ?? null;
  const isCity = tag.includes(",") && !loc?.address;
  if (tag) {
    if (isCity) cityHint = tag;
    else {
      primary.push(
        candidate(tag, {
          address_hint: [loc?.address, loc?.city].filter(Boolean).join(", "),
          near: loc ? { lat: loc.lat, lng: loc.lng, radius: VENUE_RADIUS_M } : null,
        }),
      );
    }
  }
  const area = loc ? { lat: loc.lat, lng: loc.lng, radius: CITY_RADIUS_M } : null;

  for (const t of meta?.tagged ?? []) {
    fallback.push(candidate(t.fullName || handleToName(t.username), { alt_names: [t.username], instagram_handle: t.username }));
  }
  for (const h of meta?.mentions ?? []) {
    fallback.push(candidate(handleToName(h), { alt_names: [h], instagram_handle: h, search_query: h }));
  }
  if (meta?.author) {
    fallback.push(
      candidate(meta.authorFullName || handleToName(meta.author), {
        alt_names: [meta.author],
        instagram_handle: meta.author,
      }),
    );
  }

  for (const c of [...primary, ...fallback]) {
    if (!c.city && !c.address_hint && cityHint) c.city = cityHint;
    c.near ??= area;
  }
  return { primary: dedupe(primary), fallback: dedupe(fallback).slice(0, 5), cityHint, area };
}

export function dedupe(list: ExtractedPlace[]): ExtractedPlace[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = c.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
