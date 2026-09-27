import { saveMedia } from "./db";

/** Reel covers are about 30 KB. Anything much bigger isn't worth a database row. */
const MAX_IMAGE_BYTES = 600_000;

/**
 * Keep a copy of a reel's cover image. Instagram's image links stop working after a few
 * days, so the link alone isn't enough. Returns the media key, or null if it couldn't be saved.
 */
export async function saveImageFromUrl(db: D1Database, url: string | null | undefined): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const length = Number(res.headers.get("Content-Length") ?? 0);
    if (length > MAX_IMAGE_BYTES) return null;
    const data = await res.arrayBuffer();
    if (!data.byteLength || data.byteLength > MAX_IMAGE_BYTES) return null;
    return await saveMedia(db, type, data);
  } catch (err) {
    console.warn("Couldn't save the reel's cover image", err);
    return null;
  }
}
