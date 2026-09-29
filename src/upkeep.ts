import { getHome, getSetting, now, placesDueForRefresh, setSetting, updatePlace } from "./db";
import { saveImageFromUrl } from "./media";
import { MENU_RECHECK_MS, refreshMenu } from "./menu";
import { PlacesError, placesClient } from "./places";
import { fetchApifyUsage } from "./source";
import type { ApifyUsage, Env, PlaceRow } from "./types";

/** The daily job. Its time is also in wrangler.jsonc. */
export const DAILY_CRON = "17 8 * * *";
/** Google details for a place are refreshed about once a month. */
export const REFRESH_AFTER_MS = 30 * 24 * 3600 * 1000;
/** The free Workers plan allows 50 outside requests per run, so each run does a slice. */
const PLACES_PER_RUN = 35;
const PHOTOS_PER_RUN = 8;
// Last in the run, so a site that redirects a lot can only use up what's left.
const MENUS_PER_RUN = 4;

export interface UpkeepReport {
  checked: number;
  closed: string[];
  photos: number;
  menus: number;
  apify: ApifyUsage | null;
}

/**
 * Re-check places with Google: permanent closures, hours, rating. Only business
 * details are updated; the name, location and your own fields are left alone.
 */
export async function refreshPlaces(env: Env, limit = PLACES_PER_RUN, olderThan = now() - REFRESH_AFTER_MS): Promise<{ checked: number; closed: string[] }> {
  const db = env.DB;
  const home = await getHome(db);
  const client = placesClient(env);
  const due = await placesDueForRefresh(db, olderThan, limit);
  const closed: string[] = [];
  let checked = 0;
  for (const p of due) {
    try {
      const c = await client.details(p.google_place_id!, home);
      checked++;
      if (!c) {
        await updatePlace(db, p.id, { refreshed_at: now() });
        continue;
      }
      if (c.businessStatus === "CLOSED_PERMANENTLY" && p.business_status !== "CLOSED_PERMANENTLY") closed.push(p.name);
      const fields: Partial<PlaceRow> = {
        business_status: c.businessStatus || p.business_status,
        rating: c.rating ?? p.rating,
        rating_count: c.ratingCount ?? p.rating_count,
        price_level: c.priceLevel || p.price_level,
        price_range: c.priceRange || p.price_range,
        hours: c.hours ? JSON.stringify(c.hours) : null,
        time_zone: c.timeZone || p.time_zone,
        utc_offset: c.utcOffset ?? p.utc_offset,
        website: c.website || p.website,
        phone: c.phone || p.phone,
        maps_url: c.mapsUrl || p.maps_url,
        refreshed_at: now(),
      };
      await updatePlace(db, p.id, fields);
    } catch (err) {
      // A place Google no longer knows keeps its old details; it's retried next month.
      if (err instanceof PlacesError && /\b404\b/.test(err.message)) {
        await updatePlace(db, p.id, { refreshed_at: now() });
        continue;
      }
      console.warn(`Refreshing ${p.name} failed`, err);
      break;
    }
  }
  if (closed.length) console.log(`Closed permanently: ${closed.join(", ")}`);
  return { checked, closed };
}

/** Places saved before cover images were kept: save the image while its link still works. */
export async function backfillPhotos(env: Env, limit = PHOTOS_PER_RUN): Promise<number> {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT places.id AS place_id, shares.id AS share_id, shares.source_thumb AS thumb
       FROM places JOIN shares ON shares.id = places.share_id
       WHERE places.photo_key IS NULL AND shares.source_thumb IS NOT NULL LIMIT ?`,
    )
    .bind(limit)
    .all<{ place_id: string; share_id: string; thumb: string }>();
  let saved = 0;
  for (const r of results) {
    const key = await saveImageFromUrl(db, r.thumb);
    if (!key) {
      // The link has expired. Stop trying it.
      await db.prepare("UPDATE shares SET source_thumb = NULL WHERE id = ?").bind(r.share_id).run();
      continue;
    }
    saved++;
    await db.batch([
      db.prepare("UPDATE places SET photo_key = ? WHERE id = ? AND photo_key IS NULL").bind(key, r.place_id),
      db.prepare("UPDATE shares SET photo_key = ? WHERE id = ?").bind(key, r.share_id),
      db.prepare("UPDATE place_sources SET photo_key = ? WHERE share_id = ? AND photo_key IS NULL").bind(key, r.share_id),
    ]);
  }
  return saved;
}

/**
 * Look for menu links on restaurants' websites: places never searched, whose website
 * changed, or last searched a month ago. Places are also searched when opened in the app.
 */
export async function backfillMenus(env: Env, limit = MENUS_PER_RUN): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM places WHERE archived_at IS NULL AND website IS NOT NULL AND website != ''
       AND (menu_checked_for IS NULL OR menu_checked_for != website OR coalesce(menu_checked_at, 0) < ?)
     ORDER BY coalesce(menu_checked_at, 0), created_at LIMIT ?`,
  )
    .bind(now() - MENU_RECHECK_MS, limit)
    .all<PlaceRow>();
  let searched = 0;
  for (const p of results) {
    try {
      await refreshMenu(env, p);
      searched++;
    } catch (err) {
      console.warn("Out of outside requests for menu links; the next run continues", err);
      break;
    }
  }
  return searched;
}

/** Check this month's Apify credit and keep the result for the app. */
export async function checkApifyUsage(env: Env): Promise<ApifyUsage | null> {
  const usage = await fetchApifyUsage(env);
  if (!usage) return getSetting<ApifyUsage>(env.DB, "apify_usage");
  const previous = await getSetting<ApifyUsage>(env.DB, "apify_usage");
  // A refusal for lack of credit stops mattering once there's credit again.
  const blocked = previous?.blocked && usage.limit && usage.used >= usage.limit - 0.05 ? previous.blocked : null;
  const next: ApifyUsage = { ...usage, blocked, checkedAt: now() };
  await setSetting(env.DB, "apify_usage", next);
  return next;
}

export async function runDailyUpkeep(env: Env): Promise<UpkeepReport> {
  const apify = await checkApifyUsage(env);
  const photos = await backfillPhotos(env);
  const { checked, closed } = await refreshPlaces(env);
  const menus = await backfillMenus(env);
  return { checked, closed, photos, menus, apify };
}
