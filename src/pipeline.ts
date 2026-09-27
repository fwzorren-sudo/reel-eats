import {
  candidateFields,
  claimShare,
  findPlaceByBranch,
  findUnlocatedByName,
  getHome,
  getShare,
  getUnits,
  insertPlace,
  updatePlace,
  updateShare,
} from "./db";
import { ExtractionError, extractPlaces } from "./extract";
import { candidate, captionSummary, dedupe, noteCandidate, ruleCandidates } from "./identify";
import { categoryFor, cuisineFor, PlacesClient, PlacesError, resolveBranch } from "./places";
import { fetchSourceMeta } from "./source";
import type { Engine, Env, ExtractedPlace, Home, PlaceCandidate, PlaceRow, ShareRow, SourceMeta } from "./types";
import { extractWithWorkersAI } from "./workersai";

export interface SaveResult {
  status: "done" | "failed" | "busy";
  share: ShareRow | null;
  places: PlaceRow[];
  duplicates: PlaceRow[];
  message: string;
}

export function placesClient(env: Env): PlacesClient {
  return new PlacesClient(env.GOOGLE_MAPS_API_KEY, env.PLACES_BASE_URL || undefined);
}

export function formatDistance(m: number | null | undefined, units: "mi" | "km"): string {
  if (m == null) return "";
  if (units === "km") return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  const mi = m / 1609.344;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

export function summarize(places: PlaceRow[], duplicates: PlaceRow[], units: "mi" | "km", hasHome: boolean): string {
  const describe = (p: PlaceRow) => {
    if (!p.located) return `${p.name} (location not found yet)`;
    const d = formatDistance(p.distance_m, units);
    return d && hasHome ? `${p.name}, ${d} from home` : p.city ? `${p.name} in ${p.city}` : p.name;
  };
  const parts: string[] = [];
  if (places.length === 1) parts.push(`Saved ${describe(places[0])}.`);
  else if (places.length > 1) parts.push(`Saved ${places.length} places: ${places.map((p) => p.name).join(", ")}.`);
  if (duplicates.length) parts.push(`Already on your list: ${duplicates.map((p) => p.name).join(", ")}.`);
  return parts.join(" ") || "Nothing new to save.";
}

/** Build the fields stored for one place, and pick the nearest branch when possible. */
export async function locate(
  env: Env,
  extracted: ExtractedPlace,
  home: Home | null,
): Promise<{ fields: Partial<PlaceRow>; best: PlaceCandidate | null; branches: PlaceCandidate[] }> {
  const res = await resolveBranch(placesClient(env), extracted, home);
  if (!res) return { fields: { located: 0 }, best: null, branches: [] };
  return {
    fields: {
      ...candidateFields(res.best),
      branch_count: res.branches.length,
      branches: JSON.stringify(res.branches),
    },
    best: res.best,
    branches: res.branches,
  };
}

/**
 * The name to show for a place. Chains get the words their branches share
 * ("Shake Shack" from "Shake Shack Herald Square" and "Shake Shack Grand Central").
 */
export function businessName(best: PlaceCandidate, branches: PlaceCandidate[]): string {
  if (branches.length < 2) return best.name;
  const split = branches.map((b) => b.name.split(/\s+/));
  const shared: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (split.every((words) => words[i]?.toLowerCase() === w.toLowerCase())) shared.push(w);
    else break;
  }
  const prefix = shared.join(" ").replace(/[\s,:–—-]+$/, "");
  return /\p{L}{2,}/u.test(prefix) ? prefix : best.name;
}

/** Claude when a key is set, otherwise Cloudflare Workers AI, otherwise rules only. */
export function engineFor(env: Env): Engine {
  if (env.ANTHROPIC_API_KEY) return "claude";
  if (env.AI && (env.AI_MODEL ?? "") !== "off") return "workers-ai";
  return "rules";
}

interface Plan {
  primary: ExtractedPlace[];
  fallback: ExtractedPlace[];
  reason: string;
  fromClaude: boolean;
}

/** Decide which names to look up on Google Maps, strongest signals first. */
async function plan(env: Env, share: ShareRow, meta: SourceMeta | null): Promise<Plan> {
  const engine = engineFor(env);
  if (engine === "claude") {
    const extraction = await extractPlaces(env, {
      url: share.source_url,
      meta,
      sharedText: share.shared_text,
      note: share.note,
      image: share.image_base64 && share.image_type ? { base64: share.image_base64, mediaType: share.image_type } : null,
    });
    const primary = extraction.places.map((p) => ({ ...p, food_only: false, keep_unresolved: true, category_from_google: p.category === "Other" }));
    return { primary, fallback: [], reason: extraction.reason, fromClaude: true };
  }

  const rules = ruleCandidates(meta, share.shared_text);
  if (share.note) {
    // A typed name wins. If Google can't find it, the post's own clues get a turn.
    const typed = noteCandidate(share.note);
    return { primary: typed ? [typed] : [], fallback: [...rules.primary, ...rules.fallback], reason: "", fromClaude: false };
  }

  const ai = engine === "workers-ai" ? await extractWithWorkersAI(env, meta, share.shared_text) : [];
  for (const c of ai) if (!c.city && rules.cityHint) c.city = rules.cityHint;
  const primary = dedupe([...ai, ...rules.primary]);
  // Shows up in Cloudflare's Worker logs; handy when a reel lands on the wrong place.
  console.log(
    JSON.stringify({
      share: share.id,
      via: meta?.via ?? "none",
      ai: ai.map((c) => c.name),
      rules: rules.primary.map((c) => c.name),
      fallback: rules.fallback.map((c) => c.name),
    }),
  );

  let reason = "";
  if (!meta?.caption && !share.shared_text && share.image_base64) {
    reason = "Reading screenshots needs the Claude option.";
  } else if (share.source_url && !meta?.caption && !meta?.locationName) {
    reason = "Instagram didn't return the caption for this reel.";
  }
  return { primary, fallback: rules.fallback, reason, fromClaude: false };
}

interface Located {
  place: ExtractedPlace;
  best: PlaceCandidate | null;
  fields: Partial<PlaceRow>;
  branches: PlaceCandidate[];
}

async function locateAll(env: Env, list: ExtractedPlace[], home: Home | null): Promise<Located[]> {
  const out: Located[] = [];
  for (const place of list.slice(0, 8)) {
    const r = await locate(env, place, home);
    out.push({ place, ...r });
  }
  return out;
}

export async function processShare(env: Env, shareId: string): Promise<SaveResult> {
  const db = env.DB;
  const share = await claimShare(db, shareId);
  if (!share) {
    const current = await getShare(db, shareId);
    return { status: "busy", share: current, places: [], duplicates: [], message: "Already being processed." };
  }

  try {
    let meta: SourceMeta | null = null;
    if (share.source_url) {
      meta = await fetchSourceMeta(share.source_url, env);
      await updateShare(db, share.id, {
        source_author: meta.author || null,
        source_caption: meta.caption || null,
        source_thumb: meta.thumbnail || null,
      });
    }

    const home = await getHome(db);
    const { primary, fallback, reason, fromClaude } = await plan(env, share, meta);

    // Look up the clear signals first. Only fall back to @mentions and the poster when those find nothing.
    let located = await locateAll(env, primary, home);
    if (!located.some((l) => l.best) && fallback.length) {
      located = [...located, ...(await locateAll(env, fallback, home))];
    }
    const anyFound = located.some((l) => l.best);
    const keep = located.filter((l) => l.best || l.place.keep_unresolved);

    if (!keep.length) {
      const why = reason || (fromClaude ? "" : "Couldn't find a restaurant from this post on Google Maps.") || "Couldn't tell which restaurant this is.";
      await updateShare(db, share.id, { status: "failed", error: `${why} Add the name and try again.` });
      return {
        status: "failed",
        share: await getShare(db, share.id),
        places: [],
        duplicates: [],
        message: "Couldn't identify the restaurant. Open the app to add its name.",
      };
    }

    const saved: PlaceRow[] = [];
    const duplicates: PlaceRow[] = [];
    const seenGoogle = new Set<string>();
    for (const { place: p, best, fields, branches } of keep) {
      if (best && seenGoogle.has(best.id)) continue;
      if (best) seenGoogle.add(best.id);
      if (!best && anyFound && !fromClaude) continue;
      const existing = best ? await findPlaceByBranch(db, [best.id, ...branches.map((b) => b.id)]) : await findUnlocatedByName(db, p.name);
      if (existing) {
        duplicates.push(existing);
        continue;
      }
      const category = best && p.category_from_google ? categoryFor(best, p.cuisine) : p.category;
      // Claude names the business well. Otherwise Google's name beats a handle or a location tag.
      const name = fromClaude || !best ? p.name : businessName(best, branches);
      saved.push(
        await insertPlace(db, {
          share_id: share.id,
          name,
          category,
          cuisine: p.cuisine || (best ? cuisineFor(best) : "") || null,
          summary: p.summary || captionSummary(meta?.caption || share.shared_text || "") || null,
          dishes: JSON.stringify(p.dishes),
          search_query: fromClaude || !best ? p.search_query : name,
          city_hint: p.address_hint || p.city || null,
          multi_location: p.multi_location || branches.length > 1 ? 1 : 0,
          source_url: meta?.url ?? share.source_url,
          source_author: meta?.author || null,
          source_caption: meta?.caption || share.shared_text || null,
          ...fields,
        }),
      );
    }

    // The screenshot has served its purpose; don't keep megabytes in the database.
    await updateShare(db, share.id, { status: "done", error: null, image_base64: null });
    const units = await getUnits(db);
    return {
      status: "done",
      share: await getShare(db, share.id),
      places: saved,
      duplicates,
      message: summarize(saved, duplicates, units, !!home),
    };
  } catch (err) {
    const msg =
      err instanceof ExtractionError || err instanceof PlacesError
        ? err.message
        : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
    await updateShare(db, share.id, { status: "failed", error: msg });
    return { status: "failed", share: await getShare(db, share.id), places: [], duplicates: [], message: msg };
  }
}

/** Re-run the branch search for a saved place, for example after moving house. */
export async function recheckPlace(env: Env, place: PlaceRow): Promise<PlaceRow | null> {
  const home = await getHome(env.DB);
  const extracted = candidate(place.name, {
    search_query: place.search_query || place.name,
    city: place.city_hint || "",
    multi_location: !!place.multi_location,
    food_only: false,
  });
  const { fields, best } = await locate(env, extracted, home);
  if (!best) return null;
  return updatePlace(env.DB, place.id, fields);
}
