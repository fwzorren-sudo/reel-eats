import {
  candidateFields,
  findMemberByHash,
  findShareByUrl,
  getHome,
  getMedia,
  getPlace,
  getSetting,
  getShare,
  getShareLink,
  getUnits,
  insertMember,
  insertShare,
  insertShareLink,
  listMembers,
  listOpenShares,
  listPlaces,
  listShareLinks,
  listSources,
  now,
  revokeMember,
  revokeShareLink,
  setSetting,
  staleCutoffs,
  STUCK_SQL,
  updatePlace,
  updateShare,
} from "./db";
import { distanceMeters } from "./geo";
import { isSupportedImageType } from "./extract";
import { engineFor, placesClient, processShare, recheckPlace, rereadShare, summarize } from "./pipeline";
import { geocodeHome, PlacesError, type PlaceExtras } from "./places";
import { canonicalUrl, extractFirstUrl } from "./source";
import { cleanTags } from "./tags";
import { errorText, mergeAttempt, runTraced, Trace } from "./trace";
import { backfillMenus, backfillPhotos, checkApifyUsage, DAILY_CRON, refreshPlaces, runDailyUpkeep } from "./upkeep";
import { menuDue, refreshMenu } from "./menu";
import {
  ARCHIVE_REASONS,
  CATEGORIES,
  type ApifyUsage,
  type ArchiveReason,
  type Env,
  type Home,
  type PlaceCandidate,
  type PlaceRow,
  type ShareLinkScope,
  type SourceRow,
  type Viewer,
} from "./types";

/** A share still pending this long after it was made is picked up by the every-minute job. */
const BACKGROUND_GRACE_MS = 20_000;
/**
 * Background work gets 30 seconds after the reply. If reading the reel took longer than this,
 * the rest is left for the every-minute job instead of being cut off halfway.
 */
const DEFER_AFTER_MS = 17_000;

/**
 * Process a share and wait for it. It also runs as background work, so it carries on for a while
 * if the phone disconnects, for example when the share menu closes before the Shortcut finishes.
 */
function processNow(env: Env, ctx: ExecutionContext, id: string, trigger: string) {
  const job = processShare(env, id, { trigger });
  ctx.waitUntil(job.catch(() => undefined));
  return job;
}

/** D1 rows top out at 2 MB, so screenshots are capped a little below that. */
const MAX_IMAGE_BASE64 = 1_900_000;
/** The app's Apify credit warning is refreshed this often when the app is open. */
const APIFY_CHECK_MS = 6 * 3600 * 1000;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

type GoogleExtras = PlaceExtras & { limited?: boolean; error?: string };

/**
 * Review summaries are billed per request, with 1,000 free a month. A daily cap
 * (GOOGLE_EXTRAS_PER_DAY, default 30) keeps a busy month inside that.
 */
async function googleExtras(env: Env, placeId: string): Promise<GoogleExtras> {
  const n = Number.parseInt(env.GOOGLE_EXTRAS_PER_DAY ?? "", 10);
  const limit = Number.isFinite(n) ? n : 30;
  const day = new Date().toISOString().slice(0, 10);
  const used = await getSetting<{ day: string; count: number }>(env.DB, "google_extras");
  const count = used?.day === day ? used.count : 0;
  if (count >= limit) return { summary: null, features: [], limited: true };
  await setSetting(env.DB, "google_extras", { day, count: count + 1 });
  try {
    return await placesClient(env).extras(placeId);
  } catch (err) {
    console.warn("Google review summary failed", err);
    return { summary: null, features: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** The owner signs in with APP_TOKEN. A partner signs in with a code the owner made in Settings. */
async function checkAuth(req: Request, env: Env): Promise<Viewer> {
  if (!env.APP_TOKEN) throw new HttpError(500, "APP_TOKEN is not set on the Worker. See README.");
  const header = req.headers.get("Authorization") ?? "";
  const given = header.replace(/^Bearer\s+/i, "").trim() || req.headers.get("X-App-Token")?.trim() || "";
  if (!given) throw new HttpError(401, "Wrong or missing access code.");
  const [a, b] = await Promise.all([sha256(given), sha256(env.APP_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff === 0) return { role: "owner", name: null };
  const member = await findMemberByHash(env.DB, hex(a));
  if (member) return { role: "member", name: member.name };
  throw new HttpError(401, "Wrong or missing access code.");
}

function requireOwner(viewer: Viewer): void {
  if (viewer.role !== "owner") throw new HttpError(403, "Only the list's owner can change this.");
}

/** Random, URL-safe and hard to guess. */
function randomToken(bytes = 18): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** "k7qm-3xda-p9wz-r2hc": easy to read aloud and to type into the Shortcut. */
function memberCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...b].map((n) => alphabet[n % alphabet.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function sniffImageType(b64: string): string {
  const head = atob(b64.slice(0, 24));
  const code = (i: number) => head.charCodeAt(i);
  if (code(0) === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (code(0) === 0xff && code(1) === 0xd8) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.slice(4, 12).includes("ftyp")) return "image/heic";
  return "";
}

interface ShareInput {
  url?: string;
  text?: string;
  title?: string;
  note?: string;
  image_base64?: string;
  image_type?: string;
}

async function readShareInput(req: Request): Promise<ShareInput> {
  const type = req.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) return ((await req.json().catch(() => ({}))) ?? {}) as ShareInput;
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const out: ShareInput = {};
    for (const key of ["url", "text", "title", "note", "image_base64", "image_type"] as const) {
      const v = form.get(key);
      if (typeof v === "string" && v.trim()) out[key] = v;
    }
    const file = form.get("image");
    if (file && typeof file !== "string" && file.size > 0) {
      out.image_base64 = toBase64(await file.arrayBuffer());
      out.image_type = file.type;
    }
    return out;
  }
  const text = await req.text();
  return { text };
}

async function handleShare(req: Request, env: Env, ctx: ExecutionContext, url: URL, viewer: Viewer): Promise<Response> {
  const input = await readShareInput(req);
  const wait = url.searchParams.get("wait") === "1";
  const asText = url.searchParams.get("format") === "text";
  const reply = (data: { message: string } & Record<string, unknown>, status = 200) =>
    asText ? new Response(data.message, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }) : json(data, status);

  const link = extractFirstUrl(input.url, input.text, input.title);
  const sourceUrl = link ? canonicalUrl(link) : null;
  let sharedText = [input.title, input.text].filter(Boolean).join("\n").trim();
  if (link) sharedText = sharedText.replace(link, "").trim();
  const note = input.note?.trim().slice(0, 500) || null;

  let imageBase64 = input.image_base64?.replace(/^data:[^,]+,/, "").replace(/\s+/g, "") || null;
  let imageType: string | null = null;
  if (imageBase64) {
    if (imageBase64.length > MAX_IMAGE_BASE64) {
      return reply({ status: "error", message: "That screenshot is too large. Resize it below about 1.4 MB and try again." }, 413);
    }
    imageType = sniffImageType(imageBase64) || input.image_type || "";
    if (!isSupportedImageType(imageType)) {
      return reply({ status: "error", message: "Send screenshots as JPEG or PNG. HEIC photos need converting first." }, 415);
    }
  }

  if (imageBase64 && engineFor(env) !== "claude") {
    // Without Claude nothing can read the picture, so don't store it.
    imageBase64 = null;
    imageType = null;
    if (!sourceUrl && !note && !sharedText) {
      return reply(
        {
          status: "error",
          message: "Reading screenshots needs the Claude option. Type the restaurant's name instead, or use the iPhone screenshot shortcut, which reads the text on your phone.",
        },
        422,
      );
    }
  }

  if (!sourceUrl && !note && !imageBase64 && !sharedText) {
    return reply({ status: "error", message: "Nothing to save. Share a reel link, a screenshot, or type a name." }, 400);
  }

  // The same reel shared twice: report what it produced instead of paying for it again.
  if (sourceUrl && !note && !imageBase64) {
    const previous = await findShareByUrl(env.DB, sourceUrl);
    if (previous?.status === "done") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM places WHERE share_id = ? OR id IN (SELECT place_id FROM place_sources WHERE share_id = ?)",
      )
        .bind(previous.id, previous.id)
        .all<PlaceRow>();
      const units = await getUnits(env.DB);
      const home = await getHome(env.DB);
      const msg = results.length ? summarize([], results, units, !!home) : "You already shared this one.";
      return reply({ status: "duplicate", message: msg, share_id: previous.id, places: [], duplicates: results });
    }
    if (previous && previous.status !== "processing") {
      if (wait) {
        const r = await processNow(env, ctx, previous.id, "waiting");
        return reply({ ...r, share_id: previous.id });
      }
      ctx.waitUntil(processShare(env, previous.id, { deferAfterMs: DEFER_AFTER_MS, trigger: "background" }).catch(() => undefined));
      return reply({ status: "queued", message: "Saved. Finding the restaurant now.", share_id: previous.id });
    }
    if (previous) return reply({ status: "queued", message: "Already working on this one.", share_id: previous.id });
  }

  const share = await insertShare(env.DB, {
    source_url: sourceUrl,
    shared_text: sharedText || null,
    note,
    image_base64: imageBase64,
    image_type: imageType,
    added_by: viewer.name,
  });

  if (wait) {
    const r = await processNow(env, ctx, share.id, "waiting");
    return reply({ ...r, share_id: share.id });
  }
  ctx.waitUntil(processShare(env, share.id, { deferAfterMs: DEFER_AFTER_MS, trigger: "background" }).catch(() => undefined));
  return reply({ status: "queued", message: "Saved. Finding the restaurant now.", share_id: share.id }, 202);
}

function withDistance(c: PlaceCandidate, home: Home | null): PlaceCandidate {
  return { ...c, distanceM: home ? Math.round(distanceMeters(home.lat, home.lng, c.lat, c.lng)) : null };
}

/**
 * After the home address changes, refresh distances and switch to the closest stored branch,
 * except where the branch is kept: a pop-up at the branch in the reel, or one picked by hand.
 */
async function refreshDistances(env: Env, home: Home): Promise<void> {
  const places = await listPlaces(env.DB);
  const stmts: D1PreparedStatement[] = [];
  for (const p of places) {
    if (!p.located) continue;
    let branches: PlaceCandidate[] = [];
    try {
      branches = JSON.parse(p.branches || "[]");
    } catch {
      branches = [];
    }
    branches = branches.map((b) => withDistance(b, home)).sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
    const nearest = branches[0];
    // Stored branches don't carry hours, so a switched place gets fresh details from the daily job.
    const fields: Partial<PlaceRow> =
      nearest && nearest.id !== p.google_place_id && !p.keep_branch
        ? { ...candidateFields(nearest), branches: JSON.stringify(branches), refreshed_at: null }
        : {
            distance_m: Math.round(distanceMeters(home.lat, home.lng, p.lat!, p.lng!)),
            branches: JSON.stringify(branches),
          };
    const keys = Object.keys(fields) as (keyof PlaceRow)[];
    stmts.push(
      env.DB.prepare(`UPDATE places SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(
        ...keys.map((k) => fields[k] ?? null),
        p.id,
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

async function patchPlace(env: Env, place: PlaceRow, body: Record<string, unknown>): Promise<PlaceRow | null> {
  const f: Partial<PlaceRow> = {};
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  if (body.name !== undefined) {
    const n = text(body.name, 120);
    if (!n) throw new HttpError(400, "Name can't be empty.");
    f.name = n;
  }
  if (body.category !== undefined) {
    if (!(CATEGORIES as readonly string[]).includes(body.category as string)) throw new HttpError(400, "Unknown category.");
    f.category = body.category as string;
  }
  if (body.cuisine !== undefined) f.cuisine = text(body.cuisine, 80) || null;
  if (body.summary !== undefined) f.summary = text(body.summary, 300) || null;
  if (body.notes !== undefined) f.notes = text(body.notes, 2000) || null;
  if (body.go_soon !== undefined) f.go_soon = text(body.go_soon, 80) || null;
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) throw new HttpError(400, "Tags must be a list.");
    f.tags = JSON.stringify(cleanTags(body.tags));
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") throw new HttpError(400, "archived must be true or false.");
    const reason = body.archive_reason ?? null;
    if (reason !== null && !(ARCHIVE_REASONS as readonly unknown[]).includes(reason)) throw new HttpError(400, "Unknown archive reason.");
    f.archived_at = body.archived ? place.archived_at ?? Date.now() : null;
    f.archive_reason = body.archived ? (reason as ArchiveReason | null) : null;
  }
  if (body.visit_status !== undefined) {
    if (body.visit_status !== "want" && body.visit_status !== "visited") throw new HttpError(400, "Bad visit status.");
    f.visit_status = body.visit_status;
    f.visited_at = body.visit_status === "visited" ? place.visited_at ?? Date.now() : null;
  }
  if (body.my_rating !== undefined) {
    const r = body.my_rating === null ? null : Number(body.my_rating);
    if (r !== null && !(Number.isInteger(r) && r >= 1 && r <= 5)) throw new HttpError(400, "Rating must be 1 to 5.");
    f.my_rating = r;
  }
  // Picking a branch by hand keeps it, even after moving house. keep_branch: false goes back
  // to the branch nearest home.
  if (body.branch_id !== undefined || body.keep_branch === false) {
    const home = await getHome(env.DB);
    const branches = (JSON.parse(place.branches || "[]") as PlaceCandidate[]).map((b) => withDistance(b, home));
    const chosen =
      body.branch_id !== undefined
        ? branches.find((b) => b.id === body.branch_id)
        : [...branches].sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity))[0];
    if (!chosen) throw new HttpError(400, "That branch isn't in the saved list.");
    // Fresh details bring that branch's own hours. The stored copy is the fallback.
    const fresh = await placesClient(env)
      .details(chosen.id, home)
      .catch(() => null);
    Object.assign(f, candidateFields(fresh ?? chosen), {
      refreshed_at: fresh ? now() : null,
      keep_branch: body.branch_id !== undefined ? 1 : 0,
    });
  }
  return updatePlace(env.DB, place.id, f);
}

const SCOPE_STATUSES = ["want", "visited", "all"] as const;

/** What a read-only link shows. Notes, your home, distances and who added what stay private. */
function publicPlace(p: PlaceRow) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    cuisine: p.cuisine,
    summary: p.summary,
    dishes: p.dishes,
    located: p.located,
    address: p.address,
    city: p.city,
    city_hint: p.city_hint,
    lat: p.lat,
    lng: p.lng,
    maps_url: p.maps_url,
    website: p.website,
    phone: p.phone,
    rating: p.rating,
    rating_count: p.rating_count,
    price_level: p.price_level,
    price_range: p.price_range,
    menu_url: p.menu_checked_for === p.website ? p.menu_url : null,
    business_status: p.business_status,
    branch_count: p.branch_count,
    visit_status: p.visit_status,
    my_rating: p.my_rating,
    instagram_handle: p.instagram_handle,
    tags: p.tags,
    go_soon: p.go_soon,
    hours: p.hours,
    time_zone: p.time_zone,
    utc_offset: p.utc_offset,
    photo_key: p.photo_key,
    source_url: p.source_url,
    source_author: p.source_author,
    posted_at: p.posted_at,
    created_at: p.created_at,
  };
}

const publicSource = (s: SourceRow) => ({
  place_id: s.place_id,
  source_url: s.source_url,
  source_author: s.source_author,
  posted_at: s.posted_at,
  photo_key: s.photo_key,
  created_at: s.created_at,
});

function inScope(p: PlaceRow, scope: ShareLinkScope): boolean {
  if (p.archived_at) return false;
  return (scope.status === "all" || p.visit_status === scope.status) && (!scope.category || p.category === scope.category);
}

async function handlePublic(env: Env, path: string): Promise<Response | null> {
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/media\/([0-9a-f-]{36})$/))) {
    const media = await getMedia(env.DB, m[1]);
    if (!media) return json({ error: "Not found." }, 404);
    return new Response(media.bytes, {
      headers: { "Content-Type": media.contentType, "Cache-Control": "public, max-age=31536000, immutable" },
    });
  }
  if ((m = path.match(/^\/api\/public\/([\w-]{16,64})$/))) {
    const link = await getShareLink(env.DB, m[1]);
    if (!link) return json({ error: "This link was turned off or never existed." }, 404);
    const places = (await listPlaces(env.DB)).filter((p) => inScope(p, link.scope));
    const ids = new Set(places.map((p) => p.id));
    const sources = (await listSources(env.DB)).filter((s) => ids.has(s.place_id));
    return json({
      label: link.label,
      scope: link.scope,
      units: await getUnits(env.DB),
      places: places.map(publicPlace),
      sources: sources.map(publicSource),
      categories: CATEGORIES,
    });
  }
  return null;
}

async function handleApi(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method.toUpperCase();
  if (method === "GET") {
    const open = await handlePublic(env, path);
    if (open) return open;
  }

  const viewer = await checkAuth(req, env);
  const db = env.DB;
  let m: RegExpMatchArray | null;

  if (path === "/api/ping") return json({ ok: true, viewer });

  if (path === "/api/state" && method === "GET") {
    const [home, units, places, shares, sources, apify] = await Promise.all([
      getHome(db),
      getUnits(db),
      listPlaces(db),
      listOpenShares(db),
      listSources(db),
      getSetting<ApifyUsage>(db, "apify_usage"),
    ]);
    if (env.APIFY_TOKEN && (!apify || now() - apify.checkedAt > APIFY_CHECK_MS)) {
      ctx.waitUntil(checkApifyUsage(env).catch(() => undefined));
    }
    const engine = engineFor(env);
    const features = {
      engine,
      screenshots: engine === "claude",
      apify: !!env.APIFY_TOKEN,
      transcripts: !!env.APIFY_TOKEN && (env.APIFY_TRANSCRIPTS ?? "on") !== "off",
    };
    return json({ home, units, places, shares, sources, categories: CATEGORIES, features, viewer, apify: env.APIFY_TOKEN ? apify : null });
  }

  if (path === "/api/share" && method === "POST") return handleShare(req, env, ctx, url, viewer);

  if ((m = path.match(/^\/api\/shares\/([\w-]+)\/(process|retry)$/)) && method === "POST") {
    const share = await getShare(db, m[1]);
    if (!share) throw new HttpError(404, "Share not found.");
    if (m[2] === "retry") {
      const body = (await req.json().catch(() => ({}))) as { note?: string };
      const note = body.note?.trim().slice(0, 500);
      await updateShare(db, share.id, { status: "pending", error: null, ...(note ? { note } : {}) });
    }
    return json(await processNow(env, ctx, share.id, m[2] === "retry" ? "retry" : "app"));
  }

  // The debug log for a share, or for every share behind a place. Owner only.
  if ((m = path.match(/^\/api\/(shares|places)\/([\w-]+)\/debug$/)) && method === "GET") {
    requireOwner(viewer);
    let ids = [m[2]];
    if (m[1] === "places") {
      const place = await getPlace(db, m[2]);
      if (!place) throw new HttpError(404, "Place not found.");
      const { results } = await db.prepare("SELECT share_id FROM place_sources WHERE place_id = ? AND share_id IS NOT NULL").bind(place.id).all<{ share_id: string }>();
      ids = [...new Set([place.share_id, ...results.map((r) => r.share_id)].filter((x): x is string => !!x))];
    }
    const shares = [];
    for (const id of ids) {
      const s = await getShare(db, id);
      if (!s) continue;
      let attempts: unknown[] = [];
      try {
        attempts = s.debug ? JSON.parse(s.debug) : [];
      } catch {
        attempts = [];
      }
      shares.push({
        id: s.id,
        status: s.status,
        source_url: s.source_url,
        note: s.note,
        error: s.error,
        attempts_count: s.attempts,
        created_at: s.created_at,
        updated_at: s.updated_at,
        stored: { raw_post: s.raw_post?.length ?? 0, raw_transcript: s.raw_transcript?.length ?? 0, transcript: s.transcript?.length ?? 0 },
        attempts,
      });
    }
    return json({ shares });
  }

  if ((m = path.match(/^\/api\/shares\/([\w-]+)\/reread$/)) && method === "POST") {
    requireOwner(viewer);
    const share = await getShare(db, m[1]);
    if (!share) throw new HttpError(404, "Share not found.");
    const body = (await req.json().catch(() => ({}))) as { fresh?: boolean };
    const trace = new Trace(body.fresh ? "re-read from Apify" : "re-read");
    try {
      const result = await runTraced(trace, () => rereadShare(env, share, { fresh: body.fresh === true }));
      trace.note("filled in", result.places.map((p) => p.name).join(", ") || "no places");
      await updateShare(db, share.id, { debug: mergeAttempt(share.debug, trace.attempt("done")) });
      return json(result);
    } catch (err) {
      await updateShare(db, share.id, { debug: mergeAttempt(share.debug, trace.attempt("failed", errorText(err))) });
      throw err;
    }
  }

  if ((m = path.match(/^\/api\/shares\/([\w-]+)$/)) && method === "DELETE") {
    await db.prepare("DELETE FROM shares WHERE id = ? AND status != 'done'").bind(m[1]).run();
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/places\/([\w-]+)$/))) {
    const place = await getPlace(db, m[1]);
    if (!place) throw new HttpError(404, "Place not found.");
    if (method === "PATCH") return json({ place: await patchPlace(env, place, (await req.json()) as Record<string, unknown>) });
    if (method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM place_sources WHERE place_id = ?").bind(place.id),
        db.prepare("DELETE FROM places WHERE id = ?").bind(place.id),
      ]);
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/places\/([\w-]+)\/(recheck|select)$/)) && method === "POST") {
    const place = await getPlace(db, m[1]);
    if (!place) throw new HttpError(404, "Place not found.");
    if (m[2] === "recheck") {
      const updated = await recheckPlace(env, place);
      return json({ found: !!updated, place: updated ?? place });
    }
    const body = (await req.json().catch(() => ({}))) as { place_id?: string };
    if (!body.place_id) throw new HttpError(400, "place_id is required.");
    const home = await getHome(db);
    const chosen = await placesClient(env).details(body.place_id, home);
    if (!chosen) throw new HttpError(404, "Google couldn't find that place.");
    const fields: Partial<PlaceRow> = { ...candidateFields(chosen), refreshed_at: now() };
    if (!place.located) fields.name = chosen.name;
    return json({ place: await updatePlace(db, place.id, fields) });
  }

  // Opening a place: Google's review summary and features (fetched each time, never stored),
  // and the menu link, looked for on the restaurant's website the first time.
  if ((m = path.match(/^\/api\/places\/([\w-]+)\/google$/)) && method === "GET") {
    const place = await getPlace(db, m[1]);
    if (!place) throw new HttpError(404, "Place not found.");
    const menu = menuDue(place) ? refreshMenu(env, place).catch(() => place) : Promise.resolve(place);
    const extras: Promise<GoogleExtras> = place.google_place_id ? googleExtras(env, place.google_place_id) : Promise.resolve({ summary: null, features: [] });
    const [withMenu, got] = await Promise.all([menu, extras]);
    return json({ ...got, menu_url: withMenu.menu_url, menu_checked_for: withMenu.menu_checked_for });
  }

  if (path === "/api/search" && method === "GET") {
    const q = url.searchParams.get("q")?.trim();
    if (!q) throw new HttpError(400, "Type something to search for.");
    const home = await getHome(db);
    return json({ results: await placesClient(env).textSearch(q, { bias: home, home, pageSize: 10 }) });
  }

  if (path === "/api/home" && method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { address?: string };
    const address = body.address?.trim();
    if (!address) throw new HttpError(400, "Enter your home address.");
    const home = await geocodeHome(placesClient(env), address);
    if (!home) throw new HttpError(404, "Google couldn't find that address.");
    await setSetting(db, "home", home);
    await refreshDistances(env, home);
    return json({ home });
  }

  if (path === "/api/settings" && method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { units?: string };
    if (body.units === "mi" || body.units === "km") await setSetting(db, "units", body.units);
    return json({ units: await getUnits(db) });
  }

  /* ----- owner only: partner codes, read-only links, upkeep ----- */

  if (path === "/api/members") {
    requireOwner(viewer);
    if (method === "GET") return json({ members: await listMembers(db) });
    if (method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = body.name?.trim().slice(0, 40);
      if (!name) throw new HttpError(400, "Give the code a name, like the person who'll use it.");
      const code = memberCode();
      const id = await insertMember(db, name, hex(await sha256(code)));
      // The code is shown once. Only its hash is stored.
      return json({ member: { id, name, created_at: now() }, code });
    }
  }
  if ((m = path.match(/^\/api\/members\/([\w-]+)$/)) && method === "DELETE") {
    requireOwner(viewer);
    if (!(await revokeMember(db, m[1]))) throw new HttpError(404, "That code doesn't exist.");
    return json({ ok: true });
  }

  if (path === "/api/links") {
    requireOwner(viewer);
    if (method === "GET") return json({ links: await listShareLinks(db) });
    if (method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { label?: string; status?: string; category?: string };
      const status = (SCOPE_STATUSES as readonly string[]).includes(body.status ?? "") ? (body.status as ShareLinkScope["status"]) : "want";
      const category = body.category && (CATEGORIES as readonly string[]).includes(body.category) ? body.category : null;
      const label = body.label?.trim().slice(0, 60) || null;
      const token = randomToken();
      await insertShareLink(db, token, label, { status, category });
      return json({ link: { token, label, scope: { status, category }, created_at: now() } });
    }
  }
  if ((m = path.match(/^\/api\/links\/([\w-]+)$/)) && method === "DELETE") {
    requireOwner(viewer);
    if (!(await revokeShareLink(db, m[1]))) throw new HttpError(404, "That link doesn't exist.");
    return json({ ok: true });
  }

  if (path === "/api/maintenance/refresh" && method === "POST") {
    requireOwner(viewer);
    const body = (await req.json().catch(() => ({}))) as { all?: boolean };
    const apify = await checkApifyUsage(env);
    const photos = await backfillPhotos(env);
    const { checked, closed } = await refreshPlaces(env, 35, body.all ? now() : undefined);
    const menus = await backfillMenus(env, body.all ? 10 : undefined);
    return json({ checked, closed, photos, menus, apify });
  }

  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, ctx, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof PlacesError) return json({ error: err.message }, 502);
      console.error(err);
      return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
    }
  },

  /**
   * Every minute: finish a share whose background job was cut short or handed over.
   * One per run, since the free plan allows 50 outside requests per run.
   * Once a day: re-check places with Google, keep cover images, and check Apify credit.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === DAILY_CRON) {
      const report = await runDailyUpkeep(env);
      console.log(JSON.stringify({ upkeep: report }));
      return;
    }
    const t = Date.now();
    const next = await env.DB.prepare(
      `SELECT id FROM shares WHERE (status = 'pending' AND created_at < ?) OR ${STUCK_SQL}
       ORDER BY created_at LIMIT 1`,
    )
      .bind(t - BACKGROUND_GRACE_MS, ...staleCutoffs(t))
      .first<{ id: string }>();
    if (next) await processShare(env, next.id, { trigger: "every-minute job" });
  },
} satisfies ExportedHandler<Env>;
