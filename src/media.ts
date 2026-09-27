import { saveMedia } from "./db";
import { currentTrace, errorText } from "./trace";

/** Reel covers are about 30 KB. Anything much bigger isn't worth a database row. */
const MAX_IMAGE_BYTES = 600_000;

/**
 * Keep a copy of a reel's cover image. Instagram's image links stop working after a few
 * days, so the link alone isn't enough. Returns the media key, or null if it couldn't be saved.
 */
export async function saveImageFromUrl(db: D1Database, url: string | null | undefined): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const t0 = Date.now();
  const log = (ok: boolean, detail?: string, error?: string) => currentTrace()?.add("cover image", Date.now() - t0, ok, detail, error);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) {
      log(false, undefined, `HTTP ${res.status}, ${type || "no type"}`);
      return null;
    }
    const length = Number(res.headers.get("Content-Length") ?? 0);
    const data = length > MAX_IMAGE_BYTES ? null : await res.arrayBuffer();
    if (!data || !data.byteLength || data.byteLength > MAX_IMAGE_BYTES) {
      log(false, undefined, `too large or empty (${length || data?.byteLength || 0} bytes)`);
      return null;
    }
    const key = await saveMedia(db, type, data);
    log(true, `${Math.round(data.byteLength / 1024)} KB ${type}`);
    return key;
  } catch (err) {
    console.warn("Couldn't save the reel's cover image", err);
    log(false, undefined, errorText(err));
    return null;
  }
}
