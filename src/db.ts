import type { Home, PlaceCandidate, PlaceRow, ShareRow } from "./types";

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
  s: Pick<ShareRow, "source_url" | "shared_text" | "note" | "image_base64" | "image_type">,
): Promise<ShareRow> {
  const t = now();
  const id = newId();
  await db
    .prepare(
      `INSERT INTO shares (id, status, source_url, shared_text, note, image_base64, image_type, created_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, s.source_url, s.shared_text, s.note, s.image_base64, s.image_type, t, t)
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

export async function listOpenShares(db: D1Database): Promise<Omit<ShareRow, "image_base64">[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status, source_url, shared_text, note, image_type, source_author, source_caption, source_thumb,
              error, attempts, claimed_at, created_at, updated_at
       FROM shares WHERE status != 'done' ORDER BY created_at DESC`,
    )
    .all<Omit<ShareRow, "image_base64">>();
  return results;
}
