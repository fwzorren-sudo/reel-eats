import type { ApifyUsage, Env, SourceMeta } from "./types";

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

export const POST_ACTOR = "data-slayer~instagram-post-details";
export const FALLBACK_ACTOR = "apify~instagram-scraper";
export const TRANSCRIPT_ACTOR = "apple_yang~instagram-transcripts-scraper";

interface ApifyUser {
  username?: string;
  full_name?: string;
  fullName?: string;
}

/**
 * One result from an Apify Instagram actor. The official scraper returns flat fields
 * (ownerUsername, locationName); Post Details returns Instagram's own media object
 * (user.username, caption.text, location with coordinates).
 */
interface ApifyItem {
  url?: string;
  inputUrl?: string;
  shortCode?: string;
  shortcode?: string;
  code?: string;
  caption?: string | { text?: string; mentions?: string[] } | null;
  caption_text?: string;
  text?: string;
  ownerUsername?: string;
  owner_username?: string;
  ownerFullName?: string;
  owner_full_name?: string;
  owner?: { username?: string; fullName?: string; full_name?: string };
  user?: ApifyUser;
  locationName?: string;
  location_name?: string;
  location?: { name?: string; lat?: number; lng?: number; address?: string; city?: string } | null;
  mentions?: string[];
  hashtags?: string[];
  taggedUsers?: (ApifyUser & { user?: ApifyUser })[];
  tagged_users?: (ApifyUser & { user?: ApifyUser })[];
  coauthorProducers?: ApifyUser[];
  coauthor_producers?: ApifyUser[];
  displayUrl?: string;
  thumbnail_url?: string;
  timestamp?: string;
  taken_at?: number;
  error?: string;
  errorDescription?: string;
}

/** One result from the transcript actor. `title` is the caption. */
interface TranscriptItem {
  url?: string;
  code?: string;
  title?: string;
  text?: string;
  createTime?: number;
  userName?: string;
  userFullName?: string;
  errMsg?: string;
  error?: string;
}

const people = (list: (ApifyUser & { user?: ApifyUser })[] | undefined) =>
  (list ?? [])
    .map((u) => u.user ?? u)
    .filter((u) => u.username)
    .map((u) => ({ username: u.username!.toLowerCase(), fullName: (u.full_name || u.fullName || "").trim() }));

export function mapApifyItem(url: string, item: ApifyItem): SourceMeta {
  const tagged = [...people(item.taggedUsers ?? item.tagged_users), ...people(item.coauthorProducers ?? item.coauthor_producers)];
  const author = item.ownerUsername || item.owner_username || item.owner?.username || item.user?.username || "";
  const captionObj = item.caption && typeof item.caption === "object" ? item.caption : null;
  const caption = (typeof item.caption === "string" ? item.caption : captionObj?.text) || item.caption_text || item.text || "";
  const loc = item.location;
  const location =
    loc && typeof loc.lat === "number" && typeof loc.lng === "number"
      ? { name: loc.name ?? "", lat: loc.lat, lng: loc.lng, address: loc.address ?? "", city: loc.city ?? "" }
      : null;
  const postedAt = item.taken_at ? item.taken_at * 1000 : item.timestamp ? Date.parse(item.timestamp) || null : null;
  const meta = finish(
    url,
    {
      author,
      authorFullName:
        item.ownerFullName || item.owner_full_name || item.owner?.fullName || item.owner?.full_name || item.user?.full_name || "",
      caption: caption.slice(0, 4000),
      locationName: item.locationName || item.location_name || loc?.name || "",
      thumbnail: item.thumbnail_url || item.displayUrl || "",
    },
    "apify",
    { mentions: [...(item.mentions ?? []), ...(captionObj?.mentions ?? [])].map((m) => m.replace(/^@/, "").toLowerCase()), tagged },
  );
  return { ...meta, location, postedAt, raw: JSON.stringify(item) };
}

const codeOf = (i: ApifyItem & TranscriptItem) =>
  i.shortCode || i.shortcode || i.code || instagramParts(i.url ?? "")?.code || instagramParts(i.inputUrl ?? "")?.code || "";

/**
 * Some scrapers treat a link as "this account" and return its newest reel instead.
 * Only accept a result that is the reel that was shared, when the result says which one it is.
 */
export function pickApifyItem<T extends ApifyItem | TranscriptItem>(items: unknown, url: string): T | null {
  if (!Array.isArray(items)) return null;
  const code = instagramParts(url)?.code;
  const usable = (items as T[]).filter((i) => i && !i.error && !(i as TranscriptItem).errMsg);
  const match = usable.find((i) => code && codeOf(i) === code);
  if (match) return match;
  return usable.find((i) => !codeOf(i)) ?? null;
}

export function apifyInput(actor: string, url: string): Record<string, unknown> {
  if (/post-details/i.test(actor)) return { postUrls: [url] };
  if (/transcript/i.test(actor)) return { bulkUrls: [url] };
  // Apify's Reel Scraper takes `username`; the Instagram Scraper and most others take `directUrls`.
  if (/reel-scraper/i.test(actor)) return { username: [url], directUrls: [url], resultsLimit: 1 };
  return { directUrls: [url], resultsType: "posts", resultsLimit: 1, addParentData: false };
}

export interface ActorRun {
  items: unknown;
  /** Set when Apify refused the run because the account is out of credit. */
  creditError?: string;
}

/** Run one Apify actor and wait for its results. Each run has a spending cap. */
export async function runActor(env: Env, actor: string, url: string, maxChargeUsd: number): Promise<ActorRun | null> {
  const base = env.APIFY_BASE_URL || "https://api.apify.com";
  const id = actor.replace("/", "~");
  try {
    const res = await fetch(
      `${base}/v2/acts/${id}/run-sync-get-dataset-items?timeout=120&maxItems=3&maxTotalChargeUsd=${maxChargeUsd}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(apifyInput(id, url)),
        signal: AbortSignal.timeout(130_000),
      },
    );
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      console.warn(`Apify ${id} returned ${res.status}: ${body}`);
      if (res.status === 402 || /usage|credit|insufficient|payment/i.test(body)) {
        return { items: [], creditError: `Apify refused to run ${id}: out of monthly credit.` };
      }
      return null;
    }
    return { items: await res.json() };
  } catch (err) {
    console.warn(`Apify ${id} request failed`, err);
    return null;
  }
}

/**
 * Read a reel through Apify. Post Details and the transcript run side by side;
 * the official Instagram Scraper is the fallback when Post Details fails.
 */
export async function fetchViaApify(env: Env, url: string): Promise<SourceMeta | null> {
  const postActor = env.APIFY_POST_ACTOR || POST_ACTOR;
  const fallbackActor = env.APIFY_ACTOR || FALLBACK_ACTOR;
  const transcripts = (env.APIFY_TRANSCRIPTS ?? "on") !== "off";

  const transcriptRun = transcripts ? runActor(env, env.APIFY_TRANSCRIPT_ACTOR || TRANSCRIPT_ACTOR, url, 0.03) : Promise.resolve(null);
  let creditError: string | undefined;

  let item: ApifyItem | null = null;
  if (postActor !== "off") {
    const run = await runActor(env, postActor, url, 0.02);
    creditError = run?.creditError;
    item = run ? pickApifyItem<ApifyItem>(run.items, url) : null;
  }
  if (!item && !creditError) {
    const run = await runActor(env, fallbackActor, url, 0.02);
    creditError = run?.creditError;
    item = run ? pickApifyItem<ApifyItem>(run.items, url) : null;
  }

  const tRun = await transcriptRun;
  creditError ||= tRun?.creditError;
  const t = tRun ? pickApifyItem<TranscriptItem>(tRun.items, url) : null;

  // The transcript result also carries the caption, so it can stand in for a failed post read.
  const meta = item
    ? mapApifyItem(url, item)
    : t?.title
      ? { ...mapApifyItem(url, { caption: t.title, ownerUsername: t.userName, ownerFullName: t.userFullName }), raw: null, postedAt: t.createTime ? t.createTime * 1000 : null }
      : null;
  if (!meta) {
    if (!item) console.warn(`Apify didn't return ${url}; falling back to Instagram's page`);
    return creditError ? { ...emptyMeta(url), apifyError: creditError } : null;
  }
  if (t?.text?.trim()) {
    meta.transcript = t.text.trim().slice(0, 6000);
    meta.rawTranscript = JSON.stringify(t);
  }
  if (creditError) meta.apifyError = creditError;
  return meta;
}

/** How much of this month's Apify credit is used. */
export async function fetchApifyUsage(env: Env): Promise<Omit<ApifyUsage, "checkedAt" | "blocked"> | null> {
  if (!env.APIFY_TOKEN) return null;
  const base = env.APIFY_BASE_URL || "https://api.apify.com";
  try {
    const res = await fetch(`${base}/v2/users/me/limits`, {
      headers: { Authorization: `Bearer ${env.APIFY_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const { data } = (await res.json()) as {
      data?: { monthlyUsageCycle?: { endAt?: string }; limits?: { maxMonthlyUsageUsd?: number }; current?: { monthlyUsageUsd?: number } };
    };
    if (typeof data?.current?.monthlyUsageUsd !== "number") return null;
    return {
      used: Math.round(data.current.monthlyUsageUsd * 1000) / 1000,
      limit: data.limits?.maxMonthlyUsageUsd ?? 0,
      resetsAt: data.monthlyUsageCycle?.endAt ?? "",
    };
  } catch {
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

/** Instagram's own pages: the embed page first, then the link-preview tags. */
async function readInstagramPage(canonical: string, code: string): Promise<SourceMeta> {
  let best: SourceMeta = emptyMeta(canonical);
  try {
    const embed = await getText(`https://www.instagram.com/p/${code}/embed/captioned/`, BROWSER_UA);
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
    let viaApify: SourceMeta | null = null;
    if (env?.APIFY_TOKEN) {
      viaApify = await fetchViaApify(env, canonical);
      if (viaApify && (viaApify.caption || viaApify.locationName)) return viaApify;
    }
    const best = await readInstagramPage(canonical, ig.code);
    // Keep what Apify did get, such as the transcript, alongside the page's caption.
    return viaApify
      ? { ...best, transcript: viaApify.transcript, rawTranscript: viaApify.rawTranscript, apifyError: viaApify.apifyError }
      : best;
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
