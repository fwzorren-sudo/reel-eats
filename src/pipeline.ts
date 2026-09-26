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
import { PlacesClient, PlacesError, resolveBranch } from "./places";
import { fetchSourceMeta } from "./source";
import type { Env, ExtractedPlace, Home, PlaceCandidate, PlaceRow, ShareRow, SourceMeta } from "./types";

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
      meta = await fetchSourceMeta(share.source_url);
      await updateShare(db, share.id, {
        source_author: meta.author || null,
        source_caption: meta.caption || null,
        source_thumb: meta.thumbnail || null,
      });
    }

    const extraction = await extractPlaces(env, {
      url: share.source_url,
      meta,
      sharedText: share.shared_text,
      note: share.note,
      image: share.image_base64 && share.image_type ? { base64: share.image_base64, mediaType: share.image_type } : null,
    });

    if (!extraction.places.length) {
      const why = extraction.reason || "Couldn't tell which restaurant this is.";
      await updateShare(db, share.id, { status: "failed", error: `${why} Add the name and try again.` });
      return {
        status: "failed",
        share: await getShare(db, share.id),
        places: [],
        duplicates: [],
        message: "Couldn't identify the restaurant. Open the app to add its name.",
      };
    }

    const home = await getHome(db);
    const saved: PlaceRow[] = [];
    const duplicates: PlaceRow[] = [];

    for (const p of extraction.places) {
      const { fields, best, branches } = await locate(env, p, home);
      const existing = best
        ? await findPlaceByBranch(db, [best.id, ...branches.map((b) => b.id)])
        : await findUnlocatedByName(db, p.name);
      if (existing) {
        duplicates.push(existing);
        continue;
      }
      saved.push(
        await insertPlace(db, {
          share_id: share.id,
          name: p.name,
          category: p.category,
          cuisine: p.cuisine || null,
          summary: p.summary || null,
          dishes: JSON.stringify(p.dishes),
          search_query: p.search_query,
          city_hint: p.address_hint || p.city || null,
          multi_location: p.multi_location ? 1 : 0,
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
  const extracted: ExtractedPlace = {
    name: place.name,
    alt_names: [],
    search_query: place.search_query || place.name,
    city: place.city_hint || "",
    address_hint: "",
    instagram_handle: "",
    category: "Other",
    cuisine: "",
    summary: "",
    dishes: [],
    multi_location: !!place.multi_location,
    confidence: "medium",
  };
  const { fields, best } = await locate(env, extracted, home);
  if (!best) return null;
  return updatePlace(env.DB, place.id, fields);
}
