import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalUrl,
  extractFirstUrl,
  extractMentions,
  fetchSourceMeta,
  instagramParts,
  apifyInput,
  mapApifyItem,
  parseInstagramEmbed,
  pickApifyItem,
  parseOpenGraph,
} from "../src/source";

afterEach(() => vi.unstubAllGlobals());

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("share text", () => {
  it("pulls the link out of Android share text", () => {
    expect(extractFirstUrl(null, "Check this out! https://www.instagram.com/reel/C9abc_12-X/?igsh=MWx4 so good")).toBe(
      "https://www.instagram.com/reel/C9abc_12-X/?igsh=MWx4",
    );
    expect(extractFirstUrl("", "no links here")).toBeNull();
  });

  it("canonicalises reel links so duplicates are caught", () => {
    expect(canonicalUrl("https://instagram.com/reels/C9abc_12-X/?igsh=MWx4&utm_source=ig")).toBe(
      "https://www.instagram.com/reel/C9abc_12-X/",
    );
    expect(canonicalUrl("https://www.instagram.com/someuser/reel/C9abc_12-X/")).toBe("https://www.instagram.com/reel/C9abc_12-X/");
    expect(canonicalUrl("https://www.tiktok.com/@eats/video/123?_r=1&_t=abc&lang=en")).toBe(
      "https://www.tiktok.com/@eats/video/123?lang=en",
    );
  });

  it("recognises reel, post and tv links", () => {
    expect(instagramParts("https://www.instagram.com/p/ABC123/")).toEqual({ kind: "p", code: "ABC123" });
    expect(instagramParts("https://www.instagram.com/tv/ABC123")).toEqual({ kind: "tv", code: "ABC123" });
    expect(instagramParts("https://example.com/reel/ABC123")).toBeNull();
  });
});

describe("parseInstagramEmbed", () => {
  it("reads the caption, author and location from the embed page", () => {
    const meta = parseInstagramEmbed(fixture("ig-embed.html"));
    expect(meta.author).toBe("nycfoodie");
    expect(meta.caption).toContain("best birria tacos");
    expect(meta.caption).toContain("@tacosdelnorte");
    expect(meta.caption).not.toMatch(/^nycfoodie/);
    expect(meta.caption).not.toContain("<");
    expect(meta.locationName).toBe("Tacos Del Norte");
    expect(meta.thumbnail).toBe("https://scontent.cdninstagram.com/v/t51/thumb.jpg?x=1&y=2");
  });

  it("falls back to the embedded JSON caption", () => {
    const meta = parseInstagramEmbed(fixture("ig-embed-json.html"));
    expect(meta.caption).toBe("Omakase night at Sushi Yasuda 🍣\nWorth every penny");
    expect(meta.author).toBe("sushilover");
  });
});

describe("parseOpenGraph", () => {
  it("parses Instagram's link preview tags", () => {
    const meta = parseOpenGraph(fixture("ig-og.html"));
    expect(meta.author).toBe("chicagoeats");
    expect(meta.caption).toBe("Deep dish at Lou Malnati's & it's still the GOAT 🍕");
  });

  it("uses title and description for other sites", () => {
    const meta = parseOpenGraph(
      '<html><head><meta property="og:title" content="Best Ramen in LA"><meta name="description" content="Tsujita on Sawtelle"></head></html>',
    );
    expect(meta.caption).toBe("Best Ramen in LA\nTsujita on Sawtelle");
  });
});

describe("Apify", () => {
  const env = { APIFY_TOKEN: "apify-test" } as unknown as import("../src/types").Env;
  const item = {
    caption: "Birria heaven 🌮 @TacosDelNorte. Thanks @nycfoodie",
    ownerUsername: "nycfoodie",
    ownerFullName: "NYC Foodie",
    locationName: "Tacos Del Norte",
    mentions: ["tacosdelnorte"],
    taggedUsers: [{ username: "TacosDelNorte", full_name: "Tacos Del Norte" }],
    displayUrl: "https://scontent.example/thumb.jpg",
  };

  it("maps a scraper result and drops the poster from mentions", () => {
    const m = mapApifyItem("https://www.instagram.com/reel/ABC/", item);
    expect(m).toMatchObject({
      via: "apify",
      author: "nycfoodie",
      authorFullName: "NYC Foodie",
      locationName: "Tacos Del Norte",
      mentions: ["tacosdelnorte"],
      tagged: [{ username: "tacosdelnorte", fullName: "Tacos Del Norte" }],
    });
  });

  /** A fake Apify: each actor answers from `answers`, and every call is recorded. */
  function fakeApify(answers: Record<string, () => Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const actor = Object.keys(answers).find((a) => url.includes(`/acts/${a}/`));
      if (actor) return answers[actor]();
      if (url.includes("instagram.com")) return new Response(fixture("ig-embed.html"), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    return calls;
  }
  const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
  const transcript = [{ code: "ABC", title: item.caption, text: "Tacos Del Norte in Queens has the best birria.", userName: "nycfoodie" }];

  it("reads post details and the transcript side by side, with a bearer token and a spending cap", async () => {
    const calls = fakeApify({
      "data-slayer~instagram-post-details": ok([{ code: "ABC", caption: { text: item.caption }, user: { username: "nycfoodie" } }]),
      "apple_yang~instagram-transcripts-scraper": ok(transcript),
    });
    const m = await fetchSourceMeta("https://www.instagram.com/reels/ABC/?igsh=x", env);
    expect(m.via).toBe("apify");
    expect(m.author).toBe("nycfoodie");
    expect(m.transcript).toBe("Tacos Del Norte in Queens has the best birria.");
    expect(JSON.parse(m.rawTranscript!)).toMatchObject({ code: "ABC" });
    expect(calls.map((c) => c.url.replace(/\?.*/, "")).sort()).toEqual([
      "https://api.apify.com/v2/acts/apple_yang~instagram-transcripts-scraper/run-sync-get-dataset-items",
      "https://api.apify.com/v2/acts/data-slayer~instagram-post-details/run-sync-get-dataset-items",
    ]);
    const post = calls.find((c) => c.url.includes("post-details"))!;
    expect(post.url).toContain("maxTotalChargeUsd=0.02");
    expect(new Headers(post.init.headers).get("authorization")).toBe("Bearer apify-test");
    expect(JSON.parse(String(post.init.body))).toEqual({ postUrls: ["https://www.instagram.com/reel/ABC/"] });
    const t = calls.find((c) => c.url.includes("transcripts"))!;
    expect(JSON.parse(String(t.init.body))).toEqual({ bulkUrls: ["https://www.instagram.com/reel/ABC/"] });
  });

  it("falls back to the official Instagram Scraper when Post Details fails", async () => {
    const calls = fakeApify({
      "data-slayer~instagram-post-details": () => new Response("boom", { status: 500 }),
      "apify~instagram-scraper": ok([{ ...item, url: "https://www.instagram.com/p/ABC/" }]),
      "apple_yang~instagram-transcripts-scraper": ok([]),
    });
    const m = await fetchSourceMeta("https://www.instagram.com/reel/ABC/", env);
    expect(m).toMatchObject({ via: "apify", locationName: "Tacos Del Norte", author: "nycfoodie" });
    const official = calls.find((c) => c.url.includes("apify~instagram-scraper"))!;
    expect(JSON.parse(String(official.init.body))).toMatchObject({ directUrls: ["https://www.instagram.com/reel/ABC/"], resultsType: "posts", resultsLimit: 1 });
    expect(m.transcript).toBeUndefined();
  });

  it("uses the transcript's copy of the caption when both post readers fail", async () => {
    fakeApify({
      "data-slayer~instagram-post-details": ok([]),
      "apify~instagram-scraper": ok([]),
      "apple_yang~instagram-transcripts-scraper": ok(transcript),
    });
    const m = await fetchSourceMeta("https://www.instagram.com/reel/ABC/", env);
    expect(m.caption).toBe(item.caption);
    expect(m.mentions).toEqual(["tacosdelnorte"]);
    expect(m.transcript).toContain("birria");
  });

  it("skips the transcript when it's turned off", async () => {
    const calls = fakeApify({ "data-slayer~instagram-post-details": ok([{ code: "ABC", caption: { text: "x" } }]) });
    await fetchSourceMeta("https://www.instagram.com/reel/ABC/", { ...env, APIFY_TRANSCRIPTS: "off" });
    expect(calls.map((c) => c.url)).toHaveLength(1);
  });

  it("falls back to Instagram's own page and reports when Apify is out of credit", async () => {
    const calls = fakeApify({
      "data-slayer~instagram-post-details": () => new Response('{"error":{"type":"not-enough-usage-to-run-paid-actor"}}', { status: 402 }),
      "apple_yang~instagram-transcripts-scraper": () => new Response('{"error":{"type":"not-enough-usage-to-run-paid-actor"}}', { status: 402 }),
    });
    const m = await fetchSourceMeta("https://www.instagram.com/reel/ABC/", env);
    expect(m.via).toBe("embed");
    expect(m.mentions).toEqual(["tacosdelnorte"]);
    expect(m.apifyError).toMatch(/out of monthly credit/);
    // Out of credit: the official scraper isn't tried, since it would be refused too.
    expect(calls.some((c) => c.url.includes("apify~instagram-scraper"))).toBe(false);
    expect(calls.some((c) => c.url === "https://www.instagram.com/p/ABC/embed/captioned/")).toBe(true);
  });
});

describe("Apify Post Details, a real result", () => {
  const items = JSON.parse(fixture("apify-post-details-rosetta.json"));
  const shared = "https://www.instagram.com/reel/DdmxY_iRYKE/";

  it("is matched to the shared reel by its code", () => {
    expect(pickApifyItem(items, shared)).toBe(items[0]);
    expect(pickApifyItem(items, "https://www.instagram.com/reel/OTHER/")).toBeNull();
  });

  it("maps the caption, poster, collaborator, location with coordinates, date and cover image", () => {
    const m = mapApifyItem(shared, items[0]);
    expect(m.author).toBe("atlfoodiesofficial");
    expect(m.authorFullName).toBe("Atlanta Food & Lifestyle Influencers | Adam & Cole");
    expect(m.caption).toContain("📍 Rosetta Bakery - 120 High Street, Dunwoody, GA");
    expect(m.mentions).toEqual(["rosettabakery", "highstreetatl"]);
    expect(m.tagged).toEqual([{ username: "highstreetatl", fullName: "High Street Atlanta" }]);
    expect(m.locationName).toBe("Atlanta, Georgia");
    expect(m.location).toEqual({ name: "Atlanta, Georgia", lat: 33.7566, lng: -84.3889, address: "", city: "" });
    expect(new Date(m.postedAt!).toISOString()).toBe("2026-09-22T22:08:57.000Z");
    expect(m.thumbnail).toMatch(/^https:\/\/scontent.*\.jpg/);
    expect(JSON.parse(m.raw!)).toMatchObject({ code: "DdmxY_iRYKE" });
  });

  it("pairs with the transcript result for the same reel", () => {
    const t = JSON.parse(fixture("apify-transcript-rosetta.json"));
    expect(pickApifyItem(t, shared)).toBe(t[0]);
    expect(t[0].text).toContain("Rosetta Bakery");
  });
});

describe("extractMentions", () => {
  it("finds handles but not emails", () => {
    expect(extractMentions("Go to @Joes.Pizza. and @l_industrie! mail me@example.com")).toEqual(["joes.pizza", "l_industrie"]);
  });
});

describe("a real Apify result", () => {
  const items = JSON.parse(fixture("apify-rosetta.json"));
  const shared = "https://www.instagram.com/reel/DdmxY_iRYKE/";

  it("is accepted for the reel that was shared, even though Apify links it as /p/", () => {
    expect(pickApifyItem(items, shared)).toBe(items[0]);
  });

  it("is rejected when a scraper returns a different reel", () => {
    expect(pickApifyItem(items, "https://www.instagram.com/reel/SOMETHINGELSE/")).toBeNull();
  });

  it("maps the caption, poster and mentions", () => {
    const m = mapApifyItem(shared, items[0]);
    expect(m.author).toBe("atlfoodiesofficial");
    expect(m.authorFullName).toBe("Atlanta Food & Lifestyle Influencers | Adam & Cole");
    expect(m.mentions).toEqual(["rosettabakery", "highstreetatl"]);
    expect(m.locationName).toBe("");
    expect(m.caption).toContain("📍 Rosetta Bakery - 120 High Street, Dunwoody, GA");
  });

  it("reads the post date", () => {
    expect(new Date(mapApifyItem(shared, items[0]).postedAt!).toISOString()).toBe("2026-09-22T22:08:57.000Z");
  });

  it("sends each actor the input it expects", () => {
    expect(apifyInput("apify~instagram-reel-scraper", shared)).toMatchObject({ username: [shared], resultsLimit: 1 });
    expect(apifyInput("apify~instagram-scraper", shared)).toMatchObject({ directUrls: [shared], resultsType: "posts" });
    expect(apifyInput("data-slayer~instagram-post-details", shared)).toEqual({ postUrls: [shared] });
    expect(apifyInput("apple_yang~instagram-transcripts-scraper", shared)).toEqual({ bulkUrls: [shared] });
  });
});
