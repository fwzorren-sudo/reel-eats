import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalUrl, extractFirstUrl, instagramParts, parseInstagramEmbed, parseOpenGraph } from "../src/source";

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
