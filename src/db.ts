import type { Home, PlaceCandidate, PlaceRow, ShareLinkScope, ShareRow, SourceRow } from "./types";

export const now = () => Date.now();
export const newId = () => crypto.randomUUID();

/** A share stuck in "processing" this long is assumed dead and can be claimed again. */
export const STALE_CLAIM_MS = 120_000;

export async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function setSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

export const getHome = (db: D1Database) => getSetting<Home>(db, "home");
export async function getUnits(db: D1Database): Promise<"mi" | "km"> {
  return (await getSetting<"mi" | "km">(db, "units")) ?? "mi";
}

export async function getShare(db: D1Database, id: string): Promise<ShareRow | null> {
  return db.prepare("SELECT * FROM shares WHERE id = ?").bind(id).first<ShareRow>();
}

export async function findShareByUrl(db: D1Database, url: string): Promise<ShareRow | null> {
  return db.prepare("SELECT * FROM shares WHERE source_url = ? ORDER BY created_at DESC LIMIT 1").bind(url).first<ShareRow>();
}

export async function insertShare(
  db: D1Database,
  s: Pick<ShareRow, "source_url" | "shared_text" | "note" | "image_base64" | "image_type" | "added_by">,
): Promise<ShareRow> {
  const t = now();
  const id = newId();
  await db
    .prepare(
      `INSERT INTO shares (id, status, source_url, shared_text, note, image_base64, image_type, added_by, created_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, s.source_url, s.shared_text, s.note, s.image_base64, s.image_type, s.added_by, t, t)
    .run();
  return (await getShare(db, id))!;
}

/** Atomically take ownership of a share so two workers never process it at once. */
export async function claimShare(db: D1Database, id: string): Promise<ShareRow | null> {
  const t = now();
  return db
    .prepare(
      `UPDATE shares SET status = 'processing', claimed_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND claimed_at < ?))
       RETURNING *`,
    )
    .bind(t, t, id, t - STALE_CLAIM_MS)
    .first<ShareRow>();
}

export async function updateShare(db: D1Database, id: string, fields: Partial<ShareRow>): Promise<void> {
  const keys = Object.keys(fields) as (keyof ShareRow)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await db
    .prepare(`UPDATE shares SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), now(), id)
    .run();
}

export async function getPlace(db: D1Database, id: string): Promise<PlaceRow | null> {
  return db.prepare("SELECT * FROM places WHERE id = ?").bind(id).first<PlaceRow>();
}

export async function findPlaceByGoogleId(db: D1Database, googleId: string): Promise<PlaceRow | null> {
  return db.prepare("SELECT * FROM places WHERE google_place_id = ? LIMIT 1").bind(googleId).first<PlaceRow>();
}

/** Also matches any stored branch, so saving another branch of a chain isn't a duplicate. */
export async function findPlaceByBranch(db: D1Database, googleIds: string[]): Promise<PlaceRow | null> {
  for (const gid of googleIds) {
    const direct = await findPlaceByGoogleId(db, gid);
    if (direct) return direct;
    const viaBranch = await db
      .prepare("SELECT * FROM places WHERE branches LIKE ? ESCAPE '\\' LIMIT 1")
      .bind(`%"id":${JSON.stringify(gid).replace(/[\\%_]/g, (c) => "\\" + c)}%`)
      .first<PlaceRow>();
    if (viaBranch) return viaBranch;
  }
  return null;
}

export async function findUnlocatedByName(db: D1Database, name: string): Promise<PlaceRow | null> {
  return db
    .prepare("SELECT * FROM places WHERE located = 0 AND lower(name) = lower(?) LIMIT 1")
    .bind(name)
    .first<PlaceRow>();
}

export function candidateFields(c: PlaceCandidate): Partial<PlaceRow> {
  return {
    hours: c.hours ? JSON.stringify(c.hours) : null,
    time_zone: c.timeZone || null,
    utc_offset: c.utcOffset,
    located: 1,
    google_place_id: c.id,
    address: c.address,
    city: c.city,
    lat: c.lat,
    lng: c.lng,
    distance_m: c.distanceM,
    maps_url: c.mapsUrl,
    website: c.website,
    phone: c.phone,
    rating: c.rating,
    rating_count: c.ratingCount,
    price_level: c.priceLevel,
    business_status: c.businessStatus,
  };
}

export async function insertPlace(db: D1Database, fields: Partial<PlaceRow> & { name: string }): Promise<PlaceRow> {
  const t = now();
  const row: Partial<PlaceRow> = { id: newId(), created_at: t, updated_at: t, ...fields };
  const keys = Object.keys(row) as (keyof PlaceRow)[];
  await db
    .prepare(`INSERT INTO places (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .bind(...keys.map((k) => row[k] ?? null))
    .run();
  return (await getPlace(db, row.id!))!;
}

export async function updatePlace(db: D1Database, id: string, fields: Partial<PlaceRow>): Promise<PlaceRow | null> {
  const keys = Object.keys(fields) as (keyof PlaceRow)[];
  if (keys.length) {
    await db
      .prepare(`UPDATE places SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => fields[k] ?? null), now(), id)
      .run();
  }
  return getPlace(db, id);
}

export async function listPlaces(db: D1Database): Promise<PlaceRow[]> {
  const { results } = await db.prepare("SELECT * FROM places ORDER BY created_at DESC").all<PlaceRow>();
  return results;
}

export type OpenShare = Pick<
  ShareRow,
  | "id" | "status" | "source_url" | "shared_text" | "note" | "source_author" | "source_caption" | "error"
  | "attempts" | "claimed_at" | "created_at" | "updated_at" | "photo_key" | "added_by" | "posted_at"
>;

export async function listOpenShares(db: D1Database): Promise<OpenShare[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status, source_url, shared_text, note, source_author, source_caption, error, attempts,
              claimed_at, created_at, updated_at, photo_key, added_by, posted_at
       FROM shares WHERE status != 'done' ORDER BY created_at DESC`,
    )
    .all<OpenShare>();
  return results;
}

/* ---------- reels that recommended each place ---------- */

/** Record that a reel recommended a place. Returns false when that reel was already recorded. */
export async function addSource(db: D1Database, placeId: string, s: Omit<SourceRow, "id" | "place_id" | "created_at">): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO place_sources (id, place_id, share_id, source_url, source_author, source_caption, posted_at, photo_key, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), placeId, s.share_id, s.source_url, s.source_author, s.source_caption, s.posted_at, s.photo_key, s.added_by, now())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function listSources(db: D1Database): Promise<SourceRow[]> {
  const { results } = await db.prepare("SELECT * FROM place_sources ORDER BY created_at").all<SourceRow>();
  return results;
}

export async function countCreators(db: D1Database, placeId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(DISTINCT coalesce(lower(source_author), source_url, id)) AS n FROM place_sources WHERE place_id = ?")
    .bind(placeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/* ---------- images ---------- */

export async function saveMedia(db: D1Database, contentType: string, data: ArrayBuffer): Promise<string> {
  const key = newId();
  await db
    .prepare("INSERT INTO media (key, content_type, data, created_at) VALUES (?, ?, ?, ?)")
    .bind(key, contentType, data, now())
    .run();
  return key;
}

export async function getMedia(db: D1Database, key: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const row = await db.prepare("SELECT content_type, data FROM media WHERE key = ?").bind(key).first<{ content_type: string; data: unknown }>();
  if (!row) return null;
  const d = row.data;
  // D1 hands BLOBs back as an array of byte values.
  const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : Uint8Array.from(d as number[]);
  return { contentType: row.content_type, bytes };
}

/* ---------- partner access codes ---------- */

export interface MemberRow {
  id: string;
  name: string;
  code_hash: string;
  created_at: number;
  revoked_at: number | null;
}

export async function listMembers(db: D1Database): Promise<Omit<MemberRow, "code_hash">[]> {
  const { results } = await db
    .prepare("SELECT id, name, created_at, revoked_at FROM members WHERE revoked_at IS NULL ORDER BY created_at")
    .all<Omit<MemberRow, "code_hash">>();
  return results;
}

export async function insertMember(db: D1Database, name: string, codeHash: string): Promise<string> {
  const id = newId();
  await db.prepare("INSERT INTO members (id, name, code_hash, created_at) VALUES (?, ?, ?, ?)").bind(id, name, codeHash, now()).run();
  return id;
}

export async function revokeMember(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("UPDATE members SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), id).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function findMemberByHash(db: D1Database, codeHash: string): Promise<MemberRow | null> {
  return db.prepare("SELECT * FROM members WHERE code_hash = ? AND revoked_at IS NULL").bind(codeHash).first<MemberRow>();
}

/* ---------- read-only share links ---------- */

export interface ShareLinkRow {
  token: string;
  label: string | null;
  scope: ShareLinkScope;
  created_at: number;
}

export async function listShareLinks(db: D1Database): Promise<ShareLinkRow[]> {
  const { results } = await db
    .prepare("SELECT token, label, scope, created_at FROM share_links WHERE revoked_at IS NULL ORDER BY created_at DESC")
    .all<Omit<ShareLinkRow, "scope"> & { scope: string }>();
  return results.map((r) => ({ ...r, scope: JSON.parse(r.scope) as ShareLinkScope }));
}

export async function insertShareLink(db: D1Database, token: string, label: string | null, scope: ShareLinkScope): Promise<void> {
  await db
    .prepare("INSERT INTO share_links (token, label, scope, created_at) VALUES (?, ?, ?, ?)")
    .bind(token, label, JSON.stringify(scope), now())
    .run();
}

export async function revokeShareLink(db: D1Database, token: string): Promise<boolean> {
  const r = await db.prepare("UPDATE share_links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL").bind(now(), token).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function getShareLink(db: D1Database, token: string): Promise<ShareLinkRow | null> {
  const row = await db
    .prepare("SELECT token, label, scope, created_at FROM share_links WHERE token = ? AND revoked_at IS NULL")
    .bind(token)
    .first<Omit<ShareLinkRow, "scope"> & { scope: string }>();
  return row ? { ...row, scope: JSON.parse(row.scope) as ShareLinkScope } : null;
}

/* ---------- upkeep ---------- */

/** Located places whose Google details are oldest, for the daily refresh. */
export async function placesDueForRefresh(db: D1Database, olderThan: number, limit: number): Promise<PlaceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM places WHERE located = 1 AND google_place_id IS NOT NULL AND coalesce(refreshed_at, 0) < ?
       ORDER BY coalesce(refreshed_at, 0), created_at LIMIT ?`,
    )
    .bind(olderThan, limit)
    .all<PlaceRow>();
  return results;
}
