import type { Env, SourceMeta } from "./types";

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const PREVIEW_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

/** Instagram and Android share sheets often send "Check this out https://..." as text. */
export function extractFirstUrl(...inputs: (string | null | undefined)[]): string | null {
  for (const input of inputs) {
    if (!input) continue;
    const m = input.match(/https?:\/\/[^\s<>"']+/i);
    if (m) return m[0].replace(/[),.!?]+$/, "");
  }
  return null;
}

/** Drop tracking params so the same reel shared twice is recognised as a duplicate. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const ig = instagramParts(u.toString());
    if (ig) return `https://www.instagram.com/${ig.kind}/${ig.code}/`;
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|igsh|igshid|si$|fbclid|_r$|_t$|is_from_webapp|sender_device|share)/i.test(p)) {
        u.searchParams.delete(p);
      }
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function instagramParts(url: string): { kind: string; code: string } | null {
  const m = url.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  const kind = m[1].toLowerCase() === "reels" ? "reel" : m[1].toLowerCase();
  return { kind, code: m[2] };
}

/** @handles in a caption, without the @, in order of appearance. */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\w.@])@([A-Za-z0-9._]{2,30})/g)) {
    const handle = m[2].replace(/\.+$/, "");
    if (handle && !out.includes(handle.toLowerCase())) out.push(handle.toLowerCase());
  }
  return out;
}

type Parsed = Pick<SourceMeta, "author" | "authorFullName" | "caption" | "locationName" | "thumbnail">;

function finish(url: string, p: Parsed, via: SourceMeta["via"], extra: Partial<SourceMeta> = {}): SourceMeta {
  const mentions = [...new Set([...(extra.mentions ?? []), ...extractMentions(p.caption)])].filter(
    (h) => h !== p.author.toLowerCase(),
  );
  return { url, ...p, mentions, tagged: extra.tagged ?? [], via };
}

export function emptyMeta(url: string): SourceMeta {
  return { url, author: "", authorFullName: "", caption: "", locationName: "", thumbnail: "", mentions: [], tagged: [], via: "none" };
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function jsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export function metaTag(html: string, key: string): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, "i"));
  if (a) return decodeEntities(a[1]).trim();
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, "i"));
  return b ? decodeEntities(b[1]).trim() : "";
}

/** Parse Instagram's public embed page (…/embed/captioned/), which usually works without login. */
export function parseInstagramEmbed(html: string): Parsed {
  let author = "";
  const u = html.match(/class="CaptionUsername"[^>]*>([^<]+)</) || html.match(/class="UsernameText"[^>]*>([^<]+)</);
  if (u) author = decodeEntities(u[1]).trim();

  let caption = "";
  const block = html.match(/<div class="Caption">([\s\S]*?)<div class="CaptionComments">/);
  if (block) {
    caption = stripTags(block[1]);
    if (author && caption.startsWith(author)) caption = caption.slice(author.length).trim();
  }
  if (!caption) {
    const j = html.match(/"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (j) caption = jsonString(j[1]);
  }
  if (!author) {
    const o = html.match(/"owner"\s*:\s*\{[^{}]*?"username"\s*:\s*"([^"]+)"/);
    if (o) author = o[1];
  }

  let locationName = "";
  const loc = html.match(/"location"\s*:\s*\{[^{}]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (loc) locationName = jsonString(loc[1]);

  let thumbnail = "";
  const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || html.match(/<img[^>]+class="EmbeddedMediaImage"[^>]*>/);
  if (img && img[1]) thumbnail = decodeEntities(img[1]);

  return { author, authorFullName: "", caption: caption.slice(0, 4000), locationName, thumbnail };
}

/** Parse link-preview tags. Instagram's are shaped like `name on Instagram: "caption"`. */
export function parseOpenGraph(html: string): Parsed {
  const title = metaTag(html, "og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "");
  const description = metaTag(html, "og:description") || metaTag(html, "description") || metaTag(html, "twitter:description");
  const thumbnail = metaTag(html, "og:image");

  let author = "";
  let authorFullName = "";
  let caption = "";
  const igDesc = description.match(/^[\d,.KkMm]+ likes?, [\d,.KkMm]+ comments? - ([^\s]+) on [^:]+: "([\s\S]*)"\.?\s*$/);
  const igTitle = decodeEntities(title).match(/^(.*?) on Instagram: "([\s\S]*)"\s*$/);
  if (igDesc) {
    author = igDesc[1];
    caption = igDesc[2];
    if (igTitle) authorFullName = igTitle[1].trim();
  } else if (igTitle) {
    author = igTitle[1];
    caption = igTitle[2];
  } else {
    caption = [decodeEntities(title), description].filter(Boolean).join("\n");
  }
  if (authorFullName === author) authorFullName = "";
  return { author: author.trim(), authorFullName, caption: caption.trim().slice(0, 4000), locationName: "", thumbnail };
}

/* ---------- Apify ---------- */

interface ApifyItem {
  caption?: string;
  text?: string;
  ownerUsername?: string;
  ownerFullName?: string;
  owner?: { username?: string; fullName?: string; full_name?: string };
  locationName?: string;
  location?: { name?: string } | null;
  mentions?: string[];
  hashtags?: string[];
  taggedUsers?: { username?: string; full_name?: string; fullName?: string }[];
  coauthorProducers?: { username?: string; full_name?: string; fullName?: string }[];
  displayUrl?: string;
  error?: string;
  errorDescription?: string;
}

export function mapApifyItem(url: string, item: ApifyItem): SourceMeta {
  const people = [...(item.taggedUsers ?? []), ...(item.coauthorProducers ?? [])];
  const tagged = people
    .filter((u) => u.username)
    .map((u) => ({ username: u.username!.toLowerCase(), fullName: (u.full_name || u.fullName || "").trim() }));
  const author = item.ownerUsername || item.owner?.username || "";
  return finish(
    url,
    {
      author,
      authorFullName: item.ownerFullName || item.owner?.fullName || item.owner?.full_name || "",
      caption: (item.caption || item.text || "").slice(0, 4000),
      locationName: item.locationName || item.location?.name || "",
      thumbnail: item.displayUrl || "",
    },
    "apify",
    { mentions: (item.mentions ?? []).map((m) => m.replace(/^@/, "").toLowerCase()), tagged },
  );
}

/** Run Apify's Instagram Scraper on one reel and wait for the result. */
export async function fetchViaApify(env: Env, url: string): Promise<SourceMeta | null> {
  const base = env.APIFY_BASE_URL || "https://api.apify.com";
  const actor = env.APIFY_ACTOR || "apify~instagram-scraper";
  try {
    const res = await fetch(`${base}/v2/acts/${actor}/run-sync-get-dataset-items?timeout=120&maxItems=1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ directUrls: [url], resultsType: "posts", resultsLimit: 1, addParentData: false }),
      signal: AbortSignal.timeout(130_000),
    });
    if (!res.ok) {
      console.warn(`Apify returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const items = (await res.json()) as ApifyItem[];
    const item = Array.isArray(items) ? items.find((i) => !i.error) : null;
    return item ? mapApifyItem(url, item) : null;
  } catch (err) {
    console.warn("Apify request failed", err);
    return null;
  }
}

async function getText(url: string, ua: string): Promise<{ status: number; url: string; body: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  const body = res.ok ? await res.text() : "";
  return { status: res.status, url: res.url || url, body };
}

/**
 * Best-effort caption lookup. Instagram sometimes blocks server requests, so every
 * step is allowed to fail; the pipeline still has the link, the user's note, or a screenshot.
 */
export async function fetchSourceMeta(rawUrl: string, env?: Env): Promise<SourceMeta> {
  let url = rawUrl;

  // New-style share links (instagram.com/share/reel/…) redirect to the real reel.
  if (/instagram\.com\/share\//i.test(url)) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (r.url) url = r.url;
    } catch {
      /* keep original */
    }
  }

  const ig = instagramParts(url);
  if (ig) {
    const canonical = `https://www.instagram.com/${ig.kind}/${ig.code}/`;
    if (env?.APIFY_TOKEN) {
      const viaApify = await fetchViaApify(env, canonical);
      if (viaApify && (viaApify.caption || viaApify.locationName)) return viaApify;
    }
    let best: SourceMeta = emptyMeta(canonical);
    try {
      const embed = await getText(`https://www.instagram.com/p/${ig.code}/embed/captioned/`, BROWSER_UA);
      if (embed.body) best = finish(canonical, parseInstagramEmbed(embed.body), "embed");
    } catch {
      /* fall through */
    }
    if (!best.caption) {
      try {
        const page = await getText(canonical, PREVIEW_UA);
        if (page.body) {
          const og = parseOpenGraph(page.body);
          best = finish(
            canonical,
            {
              author: best.author || og.author,
              authorFullName: og.authorFullName,
              caption: og.caption,
              locationName: best.locationName || parseInstagramEmbed(page.body).locationName,
              thumbnail: best.thumbnail || og.thumbnail,
            },
            og.caption ? "preview" : best.via,
          );
        }
      } catch {
        /* give up quietly */
      }
    }
    return best;
  }

  if (/tiktok\.com\//i.test(url)) {
    try {
      const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = (await r.json()) as { title?: string; author_name?: string; author_unique_id?: string; thumbnail_url?: string };
        return finish(
          url,
          { author: j.author_unique_id || j.author_name || "", authorFullName: "", caption: j.title || "", locationName: "", thumbnail: j.thumbnail_url || "" },
          "preview",
        );
      }
    } catch {
      /* fall through to generic */
    }
  }

  try {
    const page = await getText(url, BROWSER_UA);
    if (page.body) return finish(url, parseOpenGraph(page.body), "preview");
  } catch {
    /* ignore */
  }
  return emptyMeta(url);
}
