import {
  candidateFields,
  findShareByUrl,
  getHome,
  getPlace,
  getShare,
  getUnits,
  insertShare,
  listOpenShares,
  listPlaces,
  setSetting,
  STALE_CLAIM_MS,
  updatePlace,
  updateShare,
} from "./db";
import { distanceMeters } from "./geo";
import { isSupportedImageType } from "./extract";
import { engineFor, placesClient, processShare, recheckPlace, summarize } from "./pipeline";
import { geocodeHome, PlacesError } from "./places";
import { canonicalUrl, extractFirstUrl } from "./source";
import { CATEGORIES, type Env, type Home, type PlaceCandidate, type PlaceRow } from "./types";

/** D1 rows top out at 2 MB, so screenshots are capped a little below that. */
const MAX_IMAGE_BASE64 = 1_900_000;

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

async function checkAuth(req: Request, env: Env): Promise<void> {
  if (!env.APP_TOKEN) throw new HttpError(500, "APP_TOKEN is not set on the Worker. See README.");
  const header = req.headers.get("Authorization") ?? "";
  const given = header.replace(/^Bearer\s+/i, "").trim() || req.headers.get("X-App-Token")?.trim() || "";
  const [a, b] = await Promise.all([sha256(given), sha256(env.APP_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0 || !given) throw new HttpError(401, "Wrong or missing access code.");
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

async function handleShare(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
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
      const { results } = await env.DB.prepare("SELECT * FROM places WHERE share_id = ?").bind(previous.id).all<PlaceRow>();
      const units = await getUnits(env.DB);
      const home = await getHome(env.DB);
      const msg = results.length ? summarize([], results, units, !!home) : "You already shared this one.";
      return reply({ status: "duplicate", message: msg, share_id: previous.id, places: [], duplicates: results });
    }
    if (previous && previous.status !== "processing") {
      if (wait) {
        const r = await processShare(env, previous.id);
        return reply({ ...r, share_id: previous.id });
      }
      ctx.waitUntil(processShare(env, previous.id).catch(() => undefined));
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
  });

  if (wait) {
    const r = await processShare(env, share.id);
    return reply({ ...r, share_id: share.id });
  }
  ctx.waitUntil(processShare(env, share.id).catch(() => undefined));
  return reply({ status: "queued", message: "Saved. Finding the restaurant now.", share_id: share.id }, 202);
}

function withDistance(c: PlaceCandidate, home: Home | null): PlaceCandidate {
  return { ...c, distanceM: home ? Math.round(distanceMeters(home.lat, home.lng, c.lat, c.lng)) : null };
}

/** After the home address changes, refresh distances and switch to the closest stored branch. */
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
    const fields: Partial<PlaceRow> =
      nearest && nearest.id !== p.google_place_id
        ? { ...candidateFields(nearest), branches: JSON.stringify(branches) }
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
  if (body.branch_id !== undefined) {
    const branches: PlaceCandidate[] = JSON.parse(place.branches || "[]");
    const chosen = branches.find((b) => b.id === body.branch_id);
    if (!chosen) throw new HttpError(400, "That branch isn't in the saved list.");
    Object.assign(f, candidateFields(withDistance(chosen, await getHome(env.DB))));
  }
  return updatePlace(env.DB, place.id, f);
}

async function handleApi(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  await checkAuth(req, env);
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method.toUpperCase();
  const db = env.DB;
  let m: RegExpMatchArray | null;

  if (path === "/api/ping") return json({ ok: true });

  if (path === "/api/state" && method === "GET") {
    const [home, units, places, shares] = await Promise.all([getHome(db), getUnits(db), listPlaces(db), listOpenShares(db)]);
    const engine = engineFor(env);
    const features = { engine, screenshots: engine === "claude", apify: !!env.APIFY_TOKEN };
    return json({ home, units, places, shares, categories: CATEGORIES, features });
  }

  if (path === "/api/share" && method === "POST") return handleShare(req, env, ctx, url);

  if ((m = path.match(/^\/api\/shares\/([\w-]+)\/(process|retry)$/)) && method === "POST") {
    const share = await getShare(db, m[1]);
    if (!share) throw new HttpError(404, "Share not found.");
    if (m[2] === "retry") {
      const body = (await req.json().catch(() => ({}))) as { note?: string };
      const note = body.note?.trim().slice(0, 500);
      await updateShare(db, share.id, { status: "pending", error: null, ...(note ? { note } : {}) });
    }
    return json(await processShare(env, share.id));
  }

  if ((m = path.match(/^\/api\/shares\/([\w-]+)$/)) && method === "DELETE") {
    await db.prepare("DELETE FROM shares WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/places\/([\w-]+)$/))) {
    const place = await getPlace(db, m[1]);
    if (!place) throw new HttpError(404, "Place not found.");
    if (method === "PATCH") return json({ place: await patchPlace(env, place, (await req.json()) as Record<string, unknown>) });
    if (method === "DELETE") {
      await db.prepare("DELETE FROM places WHERE id = ?").bind(place.id).run();
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
    const fields: Partial<PlaceRow> = { ...candidateFields(chosen) };
    if (!place.located) fields.name = chosen.name;
    return json({ place: await updatePlace(db, place.id, fields) });
  }

  if (path === "/api/search" && method === "GET") {
    const q = url.searchParams.get("q")?.trim();
    if (!q) throw new HttpError(400, "Type something to search for.");
    const home = await getHome(db);
    return json({ results: await placesClient(env).textSearch(q, { bias: home, pageSize: 10 }) });
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

  /** Every few minutes, finish shares whose background job was cut short. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const t = Date.now();
    const { results } = await env.DB.prepare(
      `SELECT id FROM shares
       WHERE (status = 'pending' AND created_at < ?) OR (status = 'processing' AND claimed_at < ?)
       ORDER BY created_at LIMIT 3`,
    )
      .bind(t - 60_000, t - STALE_CLAIM_MS)
      .all<{ id: string }>();
    for (const { id } of results) await processShare(env, id);
  },
} satisfies ExportedHandler<Env>;
