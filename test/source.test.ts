import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalUrl,
  extractFirstUrl,
  extractMentions,
  fetchSourceMeta,
  instagramParts,
  mapApifyItem,
  parseInstagramEmbed,
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

  it("calls the Instagram Scraper with the reel link and a bearer token", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify([item]), { status: 200 });
    });
    const m = await fetchSourceMeta("https://www.instagram.com/reels/ABC/?igsh=x", env);
    expect(m.via).toBe("apify");
    expect(seen!.url).toBe("https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?timeout=120&maxItems=1");
    expect(new Headers(seen!.init.headers).get("authorization")).toBe("Bearer apify-test");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ directUrls: ["https://www.instagram.com/reel/ABC/"], resultsType: "posts", resultsLimit: 1 });
  });

  it("falls back to Instagram's own page when Apify fails", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("apify")) return new Response('{"error":{"type":"not-enough-usage"}}', { status: 402 });
      return new Response(fixture("ig-embed.html"), { status: 200 });
    });
    const m = await fetchSourceMeta("https://www.instagram.com/reel/ABC/", env);
    expect(m.via).toBe("embed");
    expect(m.mentions).toEqual(["tacosdelnorte"]);
    expect(urls[1]).toBe("https://www.instagram.com/p/ABC/embed/captioned/");
  });
});

describe("extractMentions", () => {
  it("finds handles but not emails", () => {
    expect(extractMentions("Go to @Joes.Pizza. and @l_industrie! mail me@example.com")).toEqual(["joes.pizza", "l_industrie"]);
  });
});
