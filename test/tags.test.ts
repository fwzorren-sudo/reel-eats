import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanTags, isEventNote, oneLocationOnly, priceTags, ruleGoSoon, ruleTags, supportedTags } from "../src/tags";

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

describe("the two reels from Sep 27", () => {
  it("reads a Halloween takeover as a pop-up, not a new opening", () => {
    const tinLizzys = "Atlanta’s longtime Halloween favorite is BACK 👻🐷\n\nThe Wicked Pig has officially taken over Tin Lizzy’s Midtown with over-the-top Halloween decor, spooky cocktails\n🗓️ Now open starting September 18";
    expect(ruleGoSoon(tinLizzys)).toBe("Pop-up");
    expect(ruleGoSoon("Our Halloween menu is back")).toBe("Seasonal");
  });
  it("reads 'opens today' as a new opening", () => {
    expect(ruleGoSoon("🍸@lacuevaatl opens TODAY! 🎉")).toBe("New opening");
  });
  it("keeps an AI tag only when the post's words support it", () => {
    const laCueva = "speakeasy ... the bar even glows ... cave walls, a glowing bar, and even live music. Their drinks were incredible";
    expect(supportedTags(["splurge", "cocktails", "live music", "date night"], laCueva)).toEqual(["cocktails", "live music"]);
  });
});

describe("pop-ups and events", () => {
  it("are tied to one branch; a new opening isn't", () => {
    for (const n of ["Pop-up", "Pop-up through Oct 12", "Seasonal", "Limited time through 11/30", "Halloween takeover"]) expect(isEventNote(n)).toBe(true);
    for (const n of ["New opening", "Now open starting September 18", "", null]) expect(isEventNote(n)).toBe(false);
  });
});

describe("offers at one location", () => {
  it("are spotted", () => {
    expect(oneLocationOnly("with tons of indoor and patio seating. This is only at their new Dunwoody location!")).toBe(true);
    expect(oneLocationOnly("Exclusive to the Midtown location")).toBe(true);
    expect(oneLocationOnly("Available at this location only")).toBe(true);
  });
  it("aren't read into ordinary captions", () => {
    expect(oneLocationOnly("They have locations all over Atlanta")).toBe(false);
    expect(oneLocationOnly("The only thing better than the tacos is the location")).toBe(false);
  });
});

describe("cheap eats", () => {
  it("needs the post to say it's cheap, not just mention a price", () => {
    expect(supportedTags(["cheap eats"], "For just $40, enjoy an all-you-can-eat spread. Mimosas are just $5")).toEqual([]);
    expect(supportedTags(["cheap eats"], "Tacos under $5, the best cheap eats in town")).toEqual(["cheap eats"]);
  });
});
