import { now, updatePlace } from "./db";
import { errorText } from "./trace";
import type { Env, PlaceRow } from "./types";

/** Menu links are looked for again after this long, in case the site changed. */
export const MENU_RECHECK_MS = 30 * 24 * 3600 * 1000;

/** Enough for a restaurant home page; the links are near the top anyway. */
const MAX_HTML_CHARS = 800_000;

// Some sites turn away requests that don't look like a browser.
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const SOCIAL = /(^|\.)(instagram|facebook|tiktok|twitter|x|yelp|tripadvisor)\.com$/i;
// A menu kept in Google Docs or Drive counts; a link to the place on Google Maps doesn't.
const GOOGLE_MAPS = (u: URL) =>
  (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && (/^maps\./i.test(u.hostname) || u.pathname.startsWith("/maps"))) || /(^|\.)goo\.gl$/i.test(u.hostname);
const DELIVERY = /(^|\.)(doordash|ubereats|grubhub|postmates|seamless)\.com$/i;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ");

const samePage = (a: URL, b: URL) => a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");

/**
 * The best link to a menu on a restaurant's home page: one labelled "Menu" wins over one
 * with "menu" only in its address, and a PDF gets a small bonus. Social sites, delivery apps
 * and links back to the same page (a "Menu" button that opens the site's navigation) don't count.
 */
export function pickMenuLink(html: string, pageUrl: string): string | null {
  const page = new URL(pageUrl);
  let best: { url: string; score: number } | null = null;
  for (const [, attrs, inner] of html.slice(0, MAX_HTML_CHARS).matchAll(ANCHOR)) {
    const m = attrs.match(HREF);
    const href = decode((m?.[1] ?? m?.[2] ?? "").trim());
    if (!href || /^(mailto|tel|javascript|sms):/i.test(href)) continue;
    const label = decode(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    const labelled = /\bmenus?\b/i.test(label) || /\baria-label\s*=\s*["'][^"']*\bmenus?\b/i.test(attrs);
    let url: URL;
    try {
      url = new URL(href, page);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const inAddress = /menu/i.test(url.pathname + url.search + url.hash);
    if (!labelled && !inAddress) continue;
    if (SOCIAL.test(url.hostname) || GOOGLE_MAPS(url)) continue;
    // "#menu" on the same page is a section worth jumping to; the page itself, or "#", is not.
    if (samePage(url, page) && url.hash.length < 2) continue;
    const score = (labelled ? 2 : 0) + (inAddress ? 1 : 0) + (/\.pdf($|\?)/i.test(url.pathname) ? 1 : 0) - (DELIVERY.test(url.hostname) ? 2 : 0);
    if (score > 0 && (!best || score > best.score)) best = { url: url.href, score };
  }
  return best?.url ?? null;
}

/** Fetch a restaurant's home page and find its menu link. Returns null when there's none, or the site won't answer. */
export async function findMenuLink(website: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(website)) return null;
  const res = await fetch(website, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(6000),
  });
  const type = res.headers.get("Content-Type") ?? "";
  if (!res.ok || !/html/i.test(type)) return null;
  const html = (await res.text()).slice(0, MAX_HTML_CHARS);
  return pickMenuLink(html, res.url || website);
}

/** Does this place's menu link need looking for: never done, a different website, or a month old? */
export function menuDue(p: Pick<PlaceRow, "website" | "menu_checked_for" | "menu_checked_at">, at = now()): boolean {
  if (!p.website) return false;
  return p.menu_checked_for !== p.website || (p.menu_checked_at ?? 0) < at - MENU_RECHECK_MS;
}

/**
 * Look for the place's menu link and save what was found, including "nothing", so the
 * site isn't asked again for a month. Running out of the Worker's outside requests isn't
 * saved, so the next run tries again.
 */
export async function refreshMenu(env: Env, place: PlaceRow): Promise<PlaceRow> {
  const website = place.website!;
  let menu: string | null = null;
  try {
    menu = await findMenuLink(website);
  } catch (err) {
    if (/subrequest/i.test(errorText(err))) throw err;
    console.warn(`Couldn't read ${website} for a menu link`, err);
  }
  const fields = { menu_url: menu, menu_checked_for: website, menu_checked_at: now() };
  return (await updatePlace(env.DB, place.id, fields)) ?? { ...place, ...fields };
}
