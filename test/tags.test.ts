import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanTags, priceTags, ruleGoSoon, ruleTags } from "../src/tags";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))[0];

describe("tags from the post", () => {
  const post = fixture("apify-post-details-rosetta.json");
  const transcript = fixture("apify-transcript-rosetta.json");
  const text = `${post.caption.text}\n${transcript.text}`;

  it("finds the occasions the Rosetta reel describes", () => {
    expect(ruleTags(text)).toEqual(["coffee date", "work-friendly", "outdoor seating"]);
  });

  it("doesn't read 'share with your group chat' as good for groups", () => {
    expect(ruleTags("SHARE with your group chat")).toEqual([]);
    expect(ruleTags("Great for groups and birthday dinners")).toEqual(["groups"]);
  });

  it("finds a few others", () => {
    expect(ruleTags("Rooftop cocktails with skyline views, open late till 2am")).toEqual(["rooftop", "views", "late night", "cocktails"]);
    expect(ruleTags("Omakase for a special occasion")).toEqual(["splurge"]);
  });

  it("keeps known tags only, once each, in a fixed order", () => {
    expect(cleanTags(["Rooftop", "made up", "brunch"], ["brunch", 3, null])).toEqual(["brunch", "rooftop"]);
    expect(cleanTags(undefined, null)).toEqual([]);
  });

  it("reads Google's price level, except for cafes and bakeries", () => {
    expect(priceTags("$$$$")).toEqual(["splurge"]);
    expect(priceTags("$", "Tacos & Mexican")).toEqual(["cheap eats"]);
    expect(priceTags("$", "Coffee & Cafe")).toEqual([]);
    expect(priceTags("$$")).toEqual([]);
  });
});

describe("reasons to go soon", () => {
  it("spots a new opening", () => {
    expect(ruleGoSoon(fixture("apify-post-details-rosetta.json").caption.text)).toBe("New opening");
  });

  it("spots pop-ups and limited-time items, with the end date when given", () => {
    expect(ruleGoSoon("This pop-up is here through Oct 12 only")).toBe("Pop-up through Oct 12");
    expect(ruleGoSoon("Seasonal pumpkin latte, available until 11/30")).toBe("Limited time through 11/30");
  });

  it("stays quiet otherwise", () => {
    expect(ruleGoSoon("Best tacos in Queens, been going for years")).toBe("");
  });
});
