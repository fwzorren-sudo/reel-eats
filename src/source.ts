import type { SourceMeta } from "./types";

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
export function parseInstagramEmbed(html: string): Omit<SourceMeta, "url"> {
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

  return { author, caption: caption.slice(0, 4000), locationName, thumbnail };
}

/** Parse link-preview tags. Instagram's are shaped like `name on Instagram: "caption"`. */
export function parseOpenGraph(html: string): Omit<SourceMeta, "url"> {
  const title = metaTag(html, "og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "");
  const description = metaTag(html, "og:description") || metaTag(html, "description") || metaTag(html, "twitter:description");
  const thumbnail = metaTag(html, "og:image");

  let author = "";
  let caption = "";
  const igDesc = description.match(/^[\d,.KkMm]+ likes?, [\d,.KkMm]+ comments? - ([^\s]+) on [^:]+: "([\s\S]*)"\.?\s*$/);
  const igTitle = decodeEntities(title).match(/^(.*?) on Instagram: "([\s\S]*)"\s*$/);
  if (igDesc) {
    author = igDesc[1];
    caption = igDesc[2];
  } else if (igTitle) {
    author = igTitle[1];
    caption = igTitle[2];
  } else {
    caption = [decodeEntities(title), description].filter(Boolean).join("\n");
  }
  return { author: author.trim(), caption: caption.trim().slice(0, 4000), locationName: "", thumbnail };
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
export async function fetchSourceMeta(rawUrl: string): Promise<SourceMeta> {
  let url = rawUrl;
  const empty: SourceMeta = { url, author: "", caption: "", locationName: "", thumbnail: "" };

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
    let best: SourceMeta = { ...empty, url: canonical };
    try {
      const embed = await getText(`https://www.instagram.com/p/${ig.code}/embed/captioned/`, BROWSER_UA);
      if (embed.body) best = { url: canonical, ...parseInstagramEmbed(embed.body) };
    } catch {
      /* fall through */
    }
    if (!best.caption) {
      try {
        const page = await getText(canonical, PREVIEW_UA);
        if (page.body) {
          const og = parseOpenGraph(page.body);
          best = {
            url: canonical,
            author: best.author || og.author,
            caption: og.caption,
            locationName: best.locationName || parseInstagramEmbed(page.body).locationName,
            thumbnail: best.thumbnail || og.thumbnail,
          };
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
        return { url, author: j.author_unique_id || j.author_name || "", caption: j.title || "", locationName: "", thumbnail: j.thumbnail_url || "" };
      }
    } catch {
      /* fall through to generic */
    }
  }

  try {
    const page = await getText(url, BROWSER_UA);
    if (page.body) return { url, ...parseOpenGraph(page.body) };
  } catch {
    /* ignore */
  }
  return empty;
}
