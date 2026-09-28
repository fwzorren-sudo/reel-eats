import {
  addSource,
  candidateFields,
  claimShare,
  countCreators,
  findPlaceByBranch,
  findUnlocatedByName,
  getHome,
  getSetting,
  getShare,
  getUnits,
  insertPlace,
  now,
  setSetting,
  updatePlace,
  updateShare,
} from "./db";
import { ExtractionError, extractPlaces } from "./extract";
import { namesMatch } from "./geo";
import { attachHandles, candidate, captionSummary, dedupe, noteCandidate, ruleCandidates, VENUE_RADIUS_M } from "./identify";
import { saveImageFromUrl } from "./media";
import { branchSummary, categoryFor, cuisineFor, PlacesError, placesClient, resolveBranch } from "./places";
import { emptyMeta, fetchSourceMeta, mapApifyItem } from "./source";
import { cleanTags, isEventNote, oneLocationOnly, priceTags, ruleGoSoon, ruleTags } from "./tags";
import { currentTrace, errorText, mergeAttempt, runTraced, Trace, type Attempt } from "./trace";
import type { ApifyUsage, Engine, Env, ExtractedPlace, Home, PlaceCandidate, PlaceRow, ShareRow, SourceMeta, SourceRow } from "./types";
import { extractWithWorkersAI } from "./workersai";

export { placesClient };

export interface SaveResult {
  status: "done" | "failed" | "busy";
  share: ShareRow | null;
  places: PlaceRow[];
  duplicates: PlaceRow[];
  message: string;
}

export function formatDistance(m: number | null | undefined, units: "mi" | "km"): string {
  if (m == null) return "";
  if (units === "km") return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  const mi = m / 1609.344;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

export function summarize(
  places: PlaceRow[],
  duplicates: PlaceRow[],
  units: "mi" | "km",
  hasHome: boolean,
  creators: Record<string, number> = {},
): string {
  const describe = (p: PlaceRow) => {
    if (!p.located) return `${p.name} (location not found yet)`;
    const d = formatDistance(p.distance_m, units);
    return d && hasHome ? `${p.name}, ${d} from home` : p.city ? `${p.name} in ${p.city}` : p.name;
  };
  const parts: string[] = [];
  if (places.length === 1) parts.push(`Saved ${describe(places[0])}.`);
  else if (places.length > 1) parts.push(`Saved ${places.length} places: ${places.map((p) => p.name).join(", ")}.`);
  if (duplicates.length) {
    parts.push(`Already on your list: ${duplicates.map((p) => (p.archived_at ? `${p.name} (archived)` : p.name)).join(", ")}.`);
  }
  const more = duplicates.filter((p) => (creators[p.id] ?? 0) > 1);
  if (more.length === 1) parts.push(`Added this reel to it. ${creators[more[0].id]} creators have recommended it now.`);
  else if (more.length > 1) parts.push("Added this reel to each of them.");
  return parts.join(" ") || "Nothing new to save.";
}

/** Build the fields stored for one place, and pick the nearest branch when possible. */
/** The stored fields for a place at one branch, with the full branch list. */
export function branchFields(best: PlaceCandidate, branches: PlaceCandidate[]): Partial<PlaceRow> {
  return {
    ...candidateFields(best),
    branch_count: branches.length,
    branches: JSON.stringify(branches.map(branchSummary)),
    refreshed_at: now(),
  };
}

export async function locate(
  env: Env,
  extracted: ExtractedPlace,
  home: Home | null,
): Promise<{ fields: Partial<PlaceRow>; best: PlaceCandidate | null; branches: PlaceCandidate[]; filmed: PlaceCandidate | null }> {
  const res = await resolveBranch(placesClient(env), extracted, home);
  currentTrace()?.note(
    "match",
    res
      ? `${extracted.name} → ${res.best.name}, ${res.best.address} (${res.branches.length} ${res.branches.length === 1 ? "location" : "locations"})`
      : `${extracted.name} → nothing on Google Maps${extracted.food_only ? " that serves food or drink" : ""}`,
  );
  if (!res) return { fields: { located: 0 }, best: null, branches: [], filmed: null };
  return { fields: branchFields(res.best, res.branches), best: res.best, branches: res.branches, filmed: res.filmed };
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

/** The restaurant's own Instagram account, when the post tags or mentions it. */
export function handleFor(name: string, meta: SourceMeta | null): string {
  if (!meta || !name) return "";
  const handles = [...meta.tagged.map((t) => t.username), ...meta.mentions, meta.author].filter(Boolean);
  return handles.find((h) => namesMatch(name, h)) ?? "";
}

interface Plan {
  primary: ExtractedPlace[];
  fallback: ExtractedPlace[];
  reason: string;
  fromClaude: boolean;
}

/**
 * Point each name at where the reel was filmed. A name that matches a venue-level
 * location tag is searched right at the tag; everything else in the surrounding area.
 */
function applyArea(list: ExtractedPlace[], meta: SourceMeta | null, area: ReturnType<typeof ruleCandidates>["area"]): void {
  const loc = meta?.location;
  const venueTag = loc?.address ? (meta?.locationName ?? "") : "";
  for (const c of list) {
    if (c.near) continue;
    if (venueTag && loc && namesMatch(venueTag, c.name)) c.near = { lat: loc.lat, lng: loc.lng, radius: VENUE_RADIUS_M };
    else c.near = area;
  }
}

/** Decide which names to look up on Google Maps, strongest signals first. */
async function plan(env: Env, share: ShareRow, meta: SourceMeta | null): Promise<Plan> {
  const engine = engineFor(env);
  const rules = ruleCandidates(meta, share.shared_text);

  if (engine === "claude") {
    const extraction = await extractPlaces(env, {
      url: share.source_url,
      meta,
      sharedText: share.shared_text,
      note: share.note,
      image: share.image_base64 && share.image_type ? { base64: share.image_base64, mediaType: share.image_type } : null,
    });
    const primary = extraction.places.map((p) => ({ ...p, food_only: false, keep_unresolved: true, category_from_google: p.category === "Other" }));
    applyArea(primary, meta, rules.area);
    attachHandles(primary, meta);
    currentTrace()?.note("names to look up", `Claude: ${primary.map((c) => c.name).join(", ") || `none (${extraction.reason})`}`);
    return { primary, fallback: [], reason: extraction.reason, fromClaude: true };
  }

  if (share.note) {
    // A typed name wins. If Google can't find it, the post's own clues get a turn.
    const typed = noteCandidate(share.note);
    currentTrace()?.note("names to look up", `typed: ${typed?.name ?? "none"}; backup: ${[...rules.primary, ...rules.fallback].map((c) => c.name).join(", ") || "none"}`);
    return { primary: typed ? [typed] : [], fallback: [...rules.primary, ...rules.fallback], reason: "", fromClaude: false };
  }

  const ai = engine === "workers-ai" ? await extractWithWorkersAI(env, meta, share.shared_text) : [];
  for (const c of ai) if (!c.city && rules.cityHint) c.city = rules.cityHint;
  applyArea(ai, meta, rules.area);
  attachHandles(ai, meta);
  const primary = dedupe([...ai, ...rules.primary]);
  // Shows up in Cloudflare's Worker logs; handy when a reel lands on the wrong place.
  console.log(
    JSON.stringify({
      share: share.id,
      via: meta?.via ?? "none",
      transcript: meta?.transcript?.length ?? 0,
      location: meta?.location ? `${meta.locationName} @ ${meta.location.lat},${meta.location.lng}` : meta?.locationName || "",
      ai: ai.map((c) => ({ name: c.name, tags: c.tags, go_soon: c.go_soon })),
      rules: rules.primary.map((c) => c.name),
      fallback: rules.fallback.map((c) => c.name),
    }),
  );
  currentTrace()?.note(
    "names to look up",
    [`AI: ${ai.map((c) => `${c.name}${c.instagram_handle ? ` (@${c.instagram_handle})` : ""}`).join(", ") || "none"}`, `rules: ${rules.primary.map((c) => c.name).join(", ") || "none"}`, `backup: ${rules.fallback.map((c) => c.name).join(", ") || "none"}`].join("; "),
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
  filmed: PlaceCandidate | null;
}

/** Look every name up at once; one at a time was too slow to finish in the background. */
async function locateAll(env: Env, list: ExtractedPlace[], home: Home | null): Promise<Located[]> {
  return Promise.all(list.slice(0, 8).map(async (place) => ({ place, ...(await locate(env, place, home)) })));
}

/** A share processed before already has the reel's details stored. Rebuild them instead of paying Apify again. */
export function storedMeta(share: ShareRow): SourceMeta | null {
  if (!share.source_url || (!share.raw_post && !share.source_caption)) return null;
  let meta: SourceMeta = emptyMeta(share.source_url);
  if (share.raw_post) {
    try {
      meta = mapApifyItem(share.source_url, JSON.parse(share.raw_post));
    } catch {
      /* fall back to the stored caption */
    }
  }
  if (!meta.caption) {
    meta = {
      ...meta,
      author: meta.author || share.source_author || "",
      caption: share.source_caption ?? "",
      thumbnail: meta.thumbnail || share.source_thumb || "",
      via: meta.via === "none" ? "embed" : meta.via,
    };
  }
  meta.transcript = share.transcript ?? undefined;
  meta.postedAt ??= share.posted_at;
  return meta;
}

/** Remember that Apify ran out of credit, so the app can say so. */
async function noteApifyProblem(db: D1Database, message: string): Promise<void> {
  const usage = (await getSetting<ApifyUsage>(db, "apify_usage")) ?? { used: 0, limit: 0, resetsAt: "", checkedAt: 0 };
  await setSetting(db, "apify_usage", { ...usage, blocked: message, checkedAt: now() });
}

function sourceFields(share: ShareRow, meta: SourceMeta | null): Omit<SourceRow, "id" | "place_id" | "created_at"> {
  return {
    share_id: share.id,
    source_url: meta?.url ?? share.source_url,
    source_author: meta?.author || null,
    source_caption: (meta?.caption || share.shared_text || "").slice(0, 4000) || null,
    posted_at: meta?.postedAt ?? share.posted_at ?? null,
    photo_key: share.photo_key,
    added_by: share.added_by,
  };
}

export const parseList = (s: string | null | undefined): string[] => {
  try {
    const v = s ? JSON.parse(s) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Keep the cover image as soon as it's saved, so a save that's cut short doesn't lose it. */
function keepPhoto(db: D1Database, share: ShareRow, url: string | null | undefined): Promise<string | null> {
  if (share.photo_key || !url) return Promise.resolve(share.photo_key);
  return saveImageFromUrl(db, url).then(async (key) => {
    if (key) await updateShare(db, share.id, { photo_key: key });
    return key;
  });
}

export interface ProcessOptions {
  /**
   * In the background there are 30 seconds in all. If reading the reel took longer than this,
   * stop once it's stored and leave the rest to the next scheduled run, which has minutes.
   */
  deferAfterMs?: number;
  /** What started this attempt, for the debug log: "background", "waiting", "retry", "app", "every-minute job". */
  trigger?: string;
}

/** Process a share, recording every outside call in the share's debug log. */
export async function processShare(env: Env, shareId: string, opts: ProcessOptions = {}): Promise<SaveResult> {
  const trace = new Trace(opts.trigger ?? "app");
  return runTraced(trace, () => processTraced(env, shareId, opts, trace));
}

async function processTraced(env: Env, shareId: string, opts: ProcessOptions, trace: Trace): Promise<SaveResult> {
  const db = env.DB;
  const share = await claimShare(db, shareId);
  if (!share) {
    const current = await getShare(db, shareId);
    return { status: "busy", share: current, places: [], duplicates: [], message: "Already being processed." };
  }
  const previousLog = share.debug;
  // Saved part way through too, so an attempt that's cut off still shows how far it got.
  const saveLog = async (outcome: Attempt["outcome"], error?: string) => {
    try {
      await updateShare(db, share.id, { debug: mergeAttempt(previousLog, trace.attempt(outcome, error)) });
    } catch (err) {
      console.warn("Couldn't save the debug log", err);
    }
  };
  trace.note("attempt", `number ${share.attempts}${share.note ? `, with the typed name "${share.note}"` : ""}`);

  try {
    let meta: SourceMeta | null = storedMeta(share);
    if (meta) trace.note("reel", `already stored: caption ${meta.caption.length} characters, transcript ${meta.transcript?.length ?? 0}`);
    let photo = keepPhoto(db, share, meta?.thumbnail);
    if (share.source_url && !meta) {
      meta = await fetchSourceMeta(share.source_url, env);
      trace.note(
        "reel",
        `read via ${meta.via}: caption ${meta.caption.length} characters, transcript ${meta.transcript?.length ?? 0}` +
          `${meta.locationName ? `, tagged "${meta.locationName}"` : ""}${meta.apifyError ? `; ${meta.apifyError}` : ""}`,
      );
      if (meta.apifyError) await noteApifyProblem(db, meta.apifyError);
      photo = keepPhoto(db, share, meta.thumbnail);
      await updateShare(db, share.id, {
        source_author: meta.author || null,
        source_caption: meta.caption || null,
        source_thumb: meta.thumbnail || null,
        raw_post: meta.raw ?? null,
        raw_transcript: meta.rawTranscript ?? null,
        transcript: meta.transcript || null,
        posted_at: meta.postedAt ?? null,
        source_location: meta.location ? JSON.stringify({ ...meta.location, name: meta.locationName }) : null,
        // The reel is stored now; a retry won't pay Apify again, so it can start sooner.
        claimed_at: Date.now(),
      });
      if (opts.deferAfterMs && Date.now() - trace.started > opts.deferAfterMs) {
        await photo;
        trace.note("handed over", `reading the reel took ${Math.round((Date.now() - trace.started) / 1000)} s, so the every-minute job finishes it`);
        await updateShare(db, share.id, { status: "pending", claimed_at: null });
        await saveLog("handed over");
        return { status: "busy", share: await getShare(db, share.id), places: [], duplicates: [], message: "Saved. Finding the restaurant now." };
      }
    }
    await saveLog("running");

    const home = await getHome(db);
    const { primary, fallback, reason, fromClaude } = await plan(env, share, meta);

    // Look up the clear signals first. Only fall back to @mentions and the poster when those find nothing.
    let located = await locateAll(env, primary, home);
    if (!located.some((l) => l.best) && fallback.length) {
      trace.note("backup", "nothing found from the post's own clues, so trying tagged accounts, @mentions and the poster");
      located = [...located, ...(await locateAll(env, fallback, home))];
    }
    const anyFound = located.some((l) => l.best);
    const keep = located.filter((l) => l.best || l.place.keep_unresolved);

    share.photo_key = await photo;

    if (!keep.length) {
      const why = reason || (fromClaude ? "" : "Couldn't find a restaurant from this post on Google Maps.") || "Couldn't tell which restaurant this is.";
      await updateShare(db, share.id, { status: "failed", error: `${why} Add the name and try again.` });
      await saveLog("failed", why);
      return {
        status: "failed",
        share: await getShare(db, share.id),
        places: [],
        duplicates: [],
        message: "Couldn't identify the restaurant. Open the app to add its name.",
      };
    }

    // Tags and "go soon" notes read from the whole post only fit when it's about one place.
    const postText = [meta?.caption, meta?.transcript, share.shared_text].filter(Boolean).join("\n");
    const single = new Set(keep.map((l) => l.best?.id ?? l.place.name)).size === 1;
    const postTags = single ? ruleTags(postText) : [];
    const postGoSoon = single ? ruleGoSoon(postText) : "";
    const source = sourceFields(share, meta);
    const hasSource = !!(source.source_url || source.source_caption);

    const saved: PlaceRow[] = [];
    const duplicates: PlaceRow[] = [];
    const creators: Record<string, number> = {};
    const seenGoogle = new Set<string>();
    for (const found of keep) {
      const { place: p, branches, filmed } = found;
      let { best, fields } = found;
      if (best && seenGoogle.has(best.id)) continue;
      if (best) seenGoogle.add(best.id);
      if (!best && anyFound && !fromClaude) continue;
      const category = best && p.category_from_google ? categoryFor(best, p.cuisine) : p.category;
      const tags = cleanTags(p.tags, postTags, priceTags(best?.priceLevel, category));
      // A pop-up or seasonal note from the rules is more specific than AI's "now open".
      const goSoon = (postGoSoon && postGoSoon !== "New opening" ? postGoSoon : "") || p.go_soon || postGoSoon || null;
      const handle = p.instagram_handle || handleFor(best?.name ?? p.name, meta) || null;

      // A pop-up or event happens at the branch in the reel, not at whichever one is nearest home.
      // So does something the post says is only at one location.
      let keepBranch = 0;
      const why = isEventNote(goSoon) ? `"${goSoon}" is` : single && oneLocationOnly(postText) ? "The post says it's only" : "";
      if (best && filmed && why) {
        keepBranch = 1;
        if (filmed.id !== best.id) {
          trace.note("branch", `${why} at the branch in the reel, ${filmed.address}, so that's kept instead of the one nearest home`);
          best = filmed;
          fields = branchFields(filmed, branches);
        }
      }

      const existing = best ? await findPlaceByBranch(db, [best.id, ...branches.map((b) => b.id)]) : await findUnlocatedByName(db, p.name);
      if (existing) {
        // Another reel recommending a place already saved: keep it with the place.
        if (hasSource && (await addSource(db, existing.id, source))) {
          creators[existing.id] = await countCreators(db, existing.id);
          await updatePlace(db, existing.id, {
            tags: JSON.stringify(cleanTags(parseList(existing.tags), tags)),
            go_soon: existing.go_soon || goSoon,
            photo_key: existing.photo_key || share.photo_key,
            instagram_handle: existing.instagram_handle || handle,
          });
        }
        trace.note("duplicate", `${existing.name} is already on the list${existing.archived_at ? " (archived)" : ""}`);
        duplicates.push(existing);
        continue;
      }

      // Claude names the business well. Otherwise Google's name beats a handle or a location tag.
      const name = fromClaude || !best ? p.name : businessName(best, branches);
      const place = await insertPlace(db, {
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
        instagram_handle: handle,
        posted_at: meta?.postedAt ?? null,
        tags: JSON.stringify(tags),
        go_soon: goSoon,
        photo_key: share.photo_key,
        added_by: share.added_by,
        keep_branch: keepBranch,
        ...fields,
      });
      if (hasSource) await addSource(db, place.id, source);
      trace.note("saved", `${place.name}${place.located ? `, ${place.address}` : ", without a location"}`);
      saved.push(place);
    }

    // The screenshot has served its purpose; don't keep megabytes in the database.
    await updateShare(db, share.id, { status: "done", error: null, image_base64: null });
    await saveLog("done");
    const units = await getUnits(db);
    return {
      status: "done",
      share: await getShare(db, share.id),
      places: saved,
      duplicates,
      message: summarize(saved, duplicates, units, !!home, creators),
    };
  } catch (err) {
    const msg =
      err instanceof ExtractionError || err instanceof PlacesError
        ? err.message
        : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
    trace.add("error", 0, false, undefined, errorText(err));
    await updateShare(db, share.id, { status: "failed", error: msg });
    await saveLog("failed", msg);
    return { status: "failed", share: await getShare(db, share.id), places: [], duplicates: [], message: msg };
  }
}

/**
 * Run a saved reel through the current readers again and fill in what its places are missing:
 * dishes, summary, cover image, Instagram account, post date, tags and "go soon". The places
 * themselves aren't looked up again. The stored Apify results are reused, so it's free, unless
 * `fresh` is set or nothing was stored; reels saved before raw results were kept need `fresh`.
 */
export async function rereadShare(
  env: Env,
  share: ShareRow,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<{ via: string; transcript: boolean; places: PlaceRow[] }> {
  const db = env.DB;
  if (!share.source_url) return { via: "none", transcript: false, places: [] };
  const stored = !fresh && share.raw_post ? storedMeta(share) : null;
  const meta = stored ?? (await fetchSourceMeta(share.source_url, env));
  if (meta.apifyError) await noteApifyProblem(db, meta.apifyError);
  const photoKey = share.photo_key || (await saveImageFromUrl(db, meta.thumbnail || share.source_thumb));
  if (!stored) {
    await updateShare(db, share.id, {
      source_author: meta.author || share.source_author,
      source_caption: meta.caption || share.source_caption,
      source_thumb: meta.thumbnail || share.source_thumb,
      raw_post: meta.raw ?? share.raw_post,
      raw_transcript: meta.rawTranscript ?? share.raw_transcript,
      transcript: meta.transcript || share.transcript,
      posted_at: meta.postedAt ?? share.posted_at,
      source_location: meta.location ? JSON.stringify({ ...meta.location, name: meta.locationName }) : share.source_location,
    });
  }
  if (photoKey !== share.photo_key) await updateShare(db, share.id, { photo_key: photoKey });
  const current = { ...share, photo_key: photoKey, posted_at: meta.postedAt ?? share.posted_at };

  const { results: places } = await db.prepare("SELECT * FROM places WHERE share_id = ?").bind(share.id).all<PlaceRow>();
  const text = [meta.caption, meta.transcript, share.shared_text].filter(Boolean).join("\n");
  const single = places.length === 1;
  const ai = engineFor(env) === "workers-ai" ? await extractWithWorkersAI(env, meta, share.shared_text) : [];
  const source = sourceFields(current, meta);
  const ruled = single ? ruleGoSoon(text) : "";
  const updated: PlaceRow[] = [];
  for (const p of places) {
    const match = ai.find((a) => namesMatch(p.name, a.name) || namesMatch(a.name, p.name));
    const tags = cleanTags(parseList(p.tags), match?.tags, single ? ruleTags(text) : [], priceTags(p.price_level, p.category));
    const dishes = parseList(p.dishes);
    const row = await updatePlace(db, p.id, {
      tags: JSON.stringify(tags),
      go_soon: (ruled && ruled !== "New opening" ? ruled : "") || p.go_soon || match?.go_soon || ruled || null,
      instagram_handle: p.instagram_handle || match?.instagram_handle || handleFor(p.name, meta) || null,
      posted_at: p.posted_at ?? source.posted_at,
      photo_key: p.photo_key || photoKey,
      dishes: JSON.stringify(dishes.length ? dishes : (match?.dishes ?? [])),
      // The caption's first line stands in when AI had nothing; AI's summary is better.
      summary: (match?.summary && (!p.summary || p.summary === captionSummary(meta.caption)) ? match.summary : p.summary) || null,
      cuisine: p.cuisine || match?.cuisine || null,
    });
    if (source.source_url || source.source_caption) {
      await addSource(db, p.id, source);
      await db
        .prepare(
          `UPDATE place_sources SET photo_key = coalesce(photo_key, ?), posted_at = coalesce(posted_at, ?), source_author = coalesce(source_author, ?)
           WHERE place_id = ? AND source_url = ?`,
        )
        .bind(source.photo_key, source.posted_at, source.source_author, p.id, source.source_url)
        .run();
    }
    if (row) updated.push(row);
  }
  return { via: stored ? "stored" : meta.via, transcript: !!meta.transcript, places: updated };
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
  // A pop-up at a particular branch, or a branch picked by hand, stays where it is.
  if (place.keep_branch) return place;
  const { fields, best } = await locate(env, extracted, home);
  if (!best) return null;
  return updatePlace(env.DB, place.id, fields);
}
