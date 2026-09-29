import { now } from "./db";
import type { PlaceRow } from "./types";

/**
 * Pick: swipe through a short list with whoever's going out.
 * relay ("Pass it along"): each person swipes what's left, and a place anyone drops is gone.
 * vote ("Everyone votes"): everyone swipes the whole set, and places are ranked by keeps.
 */
export const PICK_MODES = ["relay", "vote"] as const;
export type PickMode = (typeof PICK_MODES)[number];

/** A pick is for tonight or tomorrow, so its link stops working after a day. */
export const PICK_TTL_MS = 24 * 3600 * 1000;
export const MAX_PICK_PLACES = 40;
export const MAX_PICK_PEOPLE = 12;
export const MAX_PICK_NAME = 24;

export interface PickRow {
  token: string;
  mode: PickMode;
  label: string | null;
  place_ids: string;
  created_at: number;
  expires_at: number;
}

export interface PickPerson {
  voter_id: string;
  name: string;
  joined_at: number;
}

export interface PickVote {
  voter_id: string;
  place_id: string;
  keep: number;
}

export interface PickTally {
  /** Still in the running, in card order. relay: nobody dropped it. vote: everything. */
  left: string[];
  /** Cards this person hasn't swiped yet. */
  todo: string[];
  /** This person's swipes: true kept, false dropped. */
  mine: Record<string, boolean>;
  /** Everyone who joined, in the order they joined. Their ids stay private. */
  people: { name: string; me: boolean; done: boolean; todo: number }[];
  /** Every place, most kept first. */
  ranking: { place_id: string; kept_by: string[]; dropped_by: string[] }[];
  /** Places still in the running that everyone kept, once two or more people have joined. */
  agreed: string[];
  /** Everyone has swiped every card they have. */
  all_done: boolean;
}

/** Who kept and dropped what, and what's left for this person to swipe. */
export function tallyPick(mode: PickMode, placeIds: string[], people: PickPerson[], votes: PickVote[], voterId: string | null): PickTally {
  const names = new Map(people.map((p) => [p.voter_id, p.name]));
  const known = new Set(placeIds);
  const counted = votes.filter((v) => names.has(v.voter_id) && known.has(v.place_id));
  const dropped = new Set(counted.filter((v) => !v.keep).map((v) => v.place_id));
  const left = mode === "relay" ? placeIds.filter((id) => !dropped.has(id)) : [...placeIds];
  const swiped = (who: string) => new Set(counted.filter((v) => v.voter_id === who).map((v) => v.place_id));
  const todoFor = (who: string) => {
    const done = swiped(who);
    return left.filter((id) => !done.has(id));
  };

  const mine: Record<string, boolean> = {};
  for (const v of counted) if (v.voter_id === voterId) mine[v.place_id] = !!v.keep;

  const order = new Map(placeIds.map((id, i) => [id, i]));
  const ranking = placeIds
    .map((place_id) => ({
      place_id,
      kept_by: counted.filter((v) => v.place_id === place_id && v.keep).map((v) => names.get(v.voter_id)!),
      dropped_by: counted.filter((v) => v.place_id === place_id && !v.keep).map((v) => names.get(v.voter_id)!),
    }))
    .sort((a, b) => b.kept_by.length - a.kept_by.length || a.dropped_by.length - b.dropped_by.length || order.get(a.place_id)! - order.get(b.place_id)!);

  const tallied = people.map((p) => ({ name: p.name, me: p.voter_id === voterId, done: todoFor(p.voter_id).length === 0, todo: todoFor(p.voter_id).length }));
  const agreed =
    people.length >= 2 ? left.filter((id) => people.every((p) => counted.some((v) => v.voter_id === p.voter_id && v.place_id === id && v.keep))) : [];

  return {
    left,
    todo: voterId && names.has(voterId) ? todoFor(voterId) : [...left],
    mine,
    people: tallied,
    ranking,
    agreed,
    all_done: tallied.length > 0 && tallied.every((p) => p.done),
  };
}

/** A name to show next to someone's swipes: trimmed, one line, not too long. */
export function pickName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.replace(/\s+/g, " ").trim().slice(0, MAX_PICK_NAME);
  return name || null;
}

/** Made on the phone and kept there, so the same person keeps their swipes. */
export const validVoterId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{8,64}$/.test(v);

/* ---------- storage ---------- */

export async function insertPick(db: D1Database, pick: PickRow): Promise<void> {
  await db
    .prepare("INSERT INTO picks (token, mode, label, place_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(pick.token, pick.mode, pick.label, pick.place_ids, pick.created_at, pick.expires_at)
    .run();
}

export async function getPick(db: D1Database, token: string): Promise<PickRow | null> {
  return db.prepare("SELECT * FROM picks WHERE token = ?").bind(token).first<PickRow>();
}

/** Picks whose links still work, newest first, with who's in each. */
export async function listPicks(db: D1Database, at = now()): Promise<(PickRow & { people: string[] })[]> {
  const [picks, people] = await db.batch([
    db.prepare("SELECT * FROM picks WHERE expires_at > ? ORDER BY created_at DESC LIMIT 10").bind(at),
    db.prepare("SELECT token, name FROM pick_people WHERE token IN (SELECT token FROM picks WHERE expires_at > ?) ORDER BY joined_at").bind(at),
  ]);
  const byToken = new Map<string, string[]>();
  for (const p of people.results as { token: string; name: string }[]) byToken.set(p.token, [...(byToken.get(p.token) ?? []), p.name]);
  return (picks.results as PickRow[]).map((p) => ({ ...p, people: byToken.get(p.token) ?? [] }));
}

export async function pickVotesAndPeople(db: D1Database, token: string): Promise<{ people: PickPerson[]; votes: PickVote[] }> {
  const [people, votes] = await db.batch([
    db.prepare("SELECT voter_id, name, joined_at FROM pick_people WHERE token = ? ORDER BY joined_at").bind(token),
    db.prepare("SELECT voter_id, place_id, keep FROM pick_votes WHERE token = ?").bind(token),
  ]);
  return { people: people.results as PickPerson[], votes: votes.results as PickVote[] };
}

/** Places in a pick, as they are now. Deleted and archived ones drop out. */
export async function pickPlaces(db: D1Database, ids: string[]): Promise<PlaceRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM places WHERE archived_at IS NULL AND id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<PlaceRow>();
  const byId = new Map(results.map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter((p): p is PlaceRow => !!p);
}

/** Join, or change the name you joined with. Returns false when the pick is full. */
export async function joinPick(db: D1Database, token: string, voterId: string, name: string): Promise<boolean> {
  const renamed = await db.prepare("UPDATE pick_people SET name = ? WHERE token = ? AND voter_id = ?").bind(name, token, voterId).run();
  if ((renamed.meta.changes ?? 0) > 0) return true;
  const added = await db
    .prepare(
      `INSERT INTO pick_people (token, voter_id, name, joined_at)
       SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM pick_people WHERE token = ?) < ?`,
    )
    .bind(token, voterId, name, now(), token, MAX_PICK_PEOPLE)
    .run();
  return (added.meta.changes ?? 0) > 0;
}

export async function isInPick(db: D1Database, token: string, voterId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM pick_people WHERE token = ? AND voter_id = ?").bind(token, voterId).first());
}

/** Keep or drop a place; null takes the swipe back. */
export async function castVote(db: D1Database, token: string, voterId: string, placeId: string, keep: boolean | null): Promise<void> {
  if (keep === null) {
    await db.prepare("DELETE FROM pick_votes WHERE token = ? AND voter_id = ? AND place_id = ?").bind(token, voterId, placeId).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO pick_votes (token, voter_id, place_id, keep, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (token, voter_id, place_id) DO UPDATE SET keep = excluded.keep, created_at = excluded.created_at`,
    )
    .bind(token, voterId, placeId, keep ? 1 : 0, now())
    .run();
}

/** Ends a pick now: its link stops working. */
export async function endPick(db: D1Database, token: string): Promise<boolean> {
  const r = await db.prepare("UPDATE picks SET expires_at = ? WHERE token = ? AND expires_at > ?").bind(now(), token, now()).run();
  return (r.meta.changes ?? 0) > 0;
}

/** The daily job clears picks a week after they stopped working. */
export async function deleteOldPicks(db: D1Database, before = now() - 7 * 24 * 3600 * 1000): Promise<number> {
  const old = "SELECT token FROM picks WHERE expires_at < ?";
  const [, , picks] = await db.batch([
    db.prepare(`DELETE FROM pick_votes WHERE token IN (${old})`).bind(before),
    db.prepare(`DELETE FROM pick_people WHERE token IN (${old})`).bind(before),
    db.prepare("DELETE FROM picks WHERE expires_at < ?").bind(before),
  ]);
  return picks.meta.changes ?? 0;
}
