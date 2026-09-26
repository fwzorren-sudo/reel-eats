import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captionSummary, handleToName, noteCandidate, pinnedPlaces, ruleCandidates } from "../src/identify";
import { emptyMeta, mapApifyItem } from "../src/source";
import type { SourceMeta } from "../src/types";

const meta = (m: Partial<SourceMeta>): SourceMeta => ({ ...emptyMeta("https://www.instagram.com/reel/X/"), ...m });

describe("pinnedPlaces", () => {
  it.each([
    ["📍Tacos Del Norte, Queens NY", "Tacos Del Norte", "Queens NY"],
    ["📍 Lucali (Carroll Gardens)", "Lucali", "Carroll Gardens"],
    ["1. Joe's Pizza 📍 Broadway", "Joe's Pizza", "Broadway"],
    ["2️⃣ L'industrie 📍Williamsburg", "L'industrie", "Williamsburg"],
    ["📍: @tacosdelnorte", "tacosdelnorte", ""],
    ["Location: Katz's Delicatessen - Lower East Side", "Katz's Delicatessen", "Lower East Side"],
    ["📌 Din Tai Fung in Glendale #dumplings", "Din Tai Fung", "Glendale"],
  ])("%s", (line, name, where) => {
    expect(pinnedPlaces(`Great night out\n${line}\n#foodie`)).toEqual([{ name, where }]);
  });

  it("finds every pin in a list post and ignores other lines", () => {
    const caption = "My top 3 pizza spots 🍕\n1. Joe's Pizza 📍 Broadway\n2. L'industrie 📍 Williamsburg\n3. Lucali 📍 Carroll Gardens\nWhich is your fave?";
    expect(pinnedPlaces(caption).map((p) => p.name)).toEqual(["Joe's Pizza", "L'industrie", "Lucali"]);
  });

  it("skips pins without a usable name", () => {
    expect(pinnedPlaces("📍 🔥🔥🔥")).toEqual([]);
  });
});

describe("noteCandidate", () => {
  it("splits a name and area", () => {
    expect(noteCandidate("Lucali, Carroll Gardens")).toMatchObject({ name: "Lucali", address_hint: "Carroll Gardens", keep_unresolved: true, food_only: false });
  });
  it("treats @handles as handles", () => {
    expect(noteCandidate("@tacosdelnorte")).toMatchObject({ name: "tacosdelnorte", instagram_handle: "tacosdelnorte" });
  });
  it("ignores empty notes", () => {
    expect(noteCandidate("  ")).toBeNull();
  });
});

describe("ruleCandidates", () => {
  it("puts pins and the location tag first, accounts after", () => {
    const r = ruleCandidates(
      meta({
        author: "nycfoodie",
        authorFullName: "NYC Foodie",
        caption: "Birria heaven 🌮 @tacosdelnorte with @bestfriend\n📍 Tacos Del Norte, Queens",
        locationName: "Tacos Del Norte",
        mentions: ["tacosdelnorte", "bestfriend"],
        tagged: [{ username: "tacosdelnorte", fullName: "Tacos Del Norte" }],
      }),
      null,
    );
    expect(r.primary.map((c) => c.name)).toEqual(["Tacos Del Norte"]);
    expect(r.primary[0].address_hint).toBe("Queens");
    // The tagged account and the @mention are the same venue, so it appears once with its real name.
    expect(r.fallback.map((c) => c.name)).toEqual(["Tacos Del Norte", "bestfriend", "NYC Foodie"]);
    expect(r.fallback.every((c) => c.food_only)).toBe(true);
  });

  it("uses a city-style location tag as a hint instead of a venue", () => {
    const r = ruleCandidates(meta({ caption: "so good @lucali", locationName: "Brooklyn, New York", mentions: ["lucali"] }), null);
    expect(r.primary).toEqual([]);
    expect(r.cityHint).toBe("Brooklyn, New York");
    expect(r.fallback[0]).toMatchObject({ name: "lucali", city: "Brooklyn, New York", search_query: "lucali" });
  });

  it("reads text shared without a link, like text pulled from a screenshot", () => {
    const r = ruleCandidates(null, "Best bagels ever\n📍 Absolute Bagels, UWS");
    expect(r.primary[0]).toMatchObject({ name: "Absolute Bagels", address_hint: "UWS" });
  });
});

describe("helpers", () => {
  it("turns handles into words", () => {
    expect(handleToName("@tacos_del.norte")).toBe("tacos del norte");
  });
  it("summarises the caption without tags", () => {
    expect(captionSummary("The best birria in Queens 🌮 @tacosdelnorte. Get the consomé!\n#nyc")).toBe("The best birria in Queens 🌮.");
    expect(captionSummary("📍 Lucali\nThin, crisp and worth the line")).toBe("Thin, crisp and worth the line");
  });
});

describe("a real reel caption from Apify", () => {
  const [item] = JSON.parse(readFileSync(new URL("./fixtures/apify-rosetta.json", import.meta.url), "utf8"));
  const meta = mapApifyItem("https://www.instagram.com/reel/DdmxY_iRYKE/", item);

  it("takes the venue and address from the 📍 line and skips the 📌 save-this line", () => {
    const r = ruleCandidates(meta, null);
    expect(r.primary).toHaveLength(1);
    expect(r.primary[0]).toMatchObject({ name: "Rosetta Bakery", address_hint: "120 High Street, Dunwoody, GA" });
  });

  it("keeps the @mentions as a backup, ahead of the food blogger who posted it", () => {
    expect(ruleCandidates(meta, null).fallback.map((c) => c.instagram_handle)).toEqual(["rosettabakery", "highstreetatl", "atlfoodiesofficial"]);
  });

  it("summarises the post", () => {
    expect(captionSummary(meta.caption)).toBe("pov: you find the BEST Italian Bakery in Atlanta!");
  });
});

describe("calls to action", () => {
  it.each(["📌 Save this for your next date night", "📌 SHARE with a friend", "📍 Follow @eats for more", "📌 Tag someone"])("ignores %s", (line) => {
    expect(pinnedPlaces(line)).toEqual([]);
  });
});
