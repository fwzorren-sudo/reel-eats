import { afterEach, describe, expect, it, vi } from "vitest";
import { brandQuery, categoryFor, cuisineFor, guessCategory, isFoodPlace, PlacesClient, resolveBranch, toCandidate } from "../src/places";
import { businessName } from "../src/pipeline";
import { ruleCandidates } from "../src/identify";
import { mapApifyItem } from "../src/source";
import { readFileSync } from "node:fs";
import type { ExtractedPlace, Home } from "../src/types";

const HOME_JC: Home = { address: "Jersey City, NJ", lat: 40.7178, lng: -74.0431 };
const HOME_CHI: Home = { address: "Chicago, IL", lat: 41.8781, lng: -87.6298 };

function raw(id: string, name: string, lat: number, lng: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    displayName: { text: name },
    formattedAddress: `${name} address`,
    location: { latitude: lat, longitude: lng },
    googleMapsUri: `https://maps.google.com/?cid=${id}`,
    businessStatus: "OPERATIONAL",
    addressComponents: [
      { longText: "Somewhere", shortText: "Somewhere", types: ["locality"] },
      { longText: "New York", shortText: "NY", types: ["administrative_area_level_1"] },
    ],
    ...extra,
  };
}

/** Route fake Google responses on the text query. */
function mockGoogle(routes: Record<string, unknown[]>) {
  const calls: { textQuery: string; bias: boolean }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ textQuery: body.textQuery, bias: !!body.locationBias });
    return new Response(JSON.stringify({ places: routes[body.textQuery] ?? [] }), { status: 200 });
  });
  return calls;
}

const place = (p: Partial<ExtractedPlace>): ExtractedPlace => ({
  name: "",
  alt_names: [],
  search_query: "",
  city: "",
  address_hint: "",
  instagram_handle: "",
  category: "Other",
  cuisine: "",
  summary: "",
  dishes: [],
  multi_location: false,
  confidence: "high",
  ...p,
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveBranch", () => {
  const client = new PlacesClient("test-key");

  it("picks the chain branch nearest home over the one in the reel", async () => {
    const calls = mockGoogle({
      "Shake Shack": [
        raw("hoboken", "Shake Shack Hoboken", 40.7440, -74.0324),
        raw("jc", "Shake Shack Jersey City", 40.7196, -74.0413),
        raw("other", "Five Guys", 40.72, -74.04),
      ],
      "Shake Shack New York, NY": [raw("msp", "Shake Shack Madison Square Park", 40.7414, -73.9882)],
    });
    const res = await resolveBranch(client, place({ name: "Shake Shack", city: "New York, NY", multi_location: true }), HOME_JC);
    expect(res?.best.id).toBe("jc");
    expect(res?.branches.map((b) => b.id)).toEqual(["jc", "hoboken", "msp"]);
    expect(res?.best.distanceM).toBeLessThan(500);
    expect(calls.find((c) => c.textQuery === "Shake Shack")?.bias).toBe(true);
  });

  it("keeps the filmed place when a same-named local spot is a different business", async () => {
    mockGoogle({
      "Joe's Pizza": [raw("chi", "Joe's Pizza", 41.88, -87.63, { websiteUri: "https://joespizzachicago.com" })],
      "Joe's Pizza New York, NY": [raw("nyc", "Joe's Pizza Broadway", 40.7547, -73.9870, { websiteUri: "https://joespizzanyc.com" })],
    });
    const res = await resolveBranch(client, place({ name: "Joe's Pizza", city: "New York, NY" }), HOME_CHI);
    expect(res?.best.id).toBe("nyc");
    expect(res?.branches).toHaveLength(1);
  });

  it("treats a shared website as the same chain even when Claude wasn't sure", async () => {
    mockGoogle({
      "Joe's Pizza": [raw("chi", "Joe's Pizza", 41.88, -87.63, { websiteUri: "https://www.joespizzanyc.com/chicago" })],
      "Joe's Pizza New York, NY": [raw("nyc", "Joe's Pizza Broadway", 40.7547, -73.9870, { websiteUri: "https://joespizzanyc.com" })],
    });
    const res = await resolveBranch(client, place({ name: "Joe's Pizza", city: "New York, NY" }), HOME_CHI);
    expect(res?.best.id).toBe("chi");
  });

  it("uses the reel's city when no home is set", async () => {
    mockGoogle({ "Lucali Brooklyn, NY": [raw("lucali", "Lucali", 40.6806, -74.0005)] });
    const res = await resolveBranch(client, place({ name: "Lucali", city: "Brooklyn, NY" }), null);
    expect(res?.best.id).toBe("lucali");
    expect(res?.best.distanceM).toBeNull();
  });

  it("skips closed branches and unrelated results", async () => {
    mockGoogle({
      "Shake Shack": [
        raw("closed", "Shake Shack Exchange Place", 40.7163, -74.0330, { businessStatus: "CLOSED_PERMANENTLY" }),
        raw("hoboken", "Shake Shack Hoboken", 40.7440, -74.0324),
      ],
    });
    const res = await resolveBranch(client, place({ name: "Shake Shack", multi_location: true }), HOME_JC);
    expect(res?.best.id).toBe("hoboken");
  });

  it("returns null when nothing matches the name", async () => {
    mockGoogle({ "Tiny Taqueria": [raw("x", "Big Burger Barn", 40.72, -74.04)] });
    expect(await resolveBranch(client, place({ name: "Tiny Taqueria" }), HOME_JC)).toBeNull();
  });

  it("reports Google errors clearly", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 }),
    );
    await expect(client.textSearch("x")).rejects.toThrow(/API key not valid/);
  });
});

describe("food filtering, categories and chains", () => {
  const client = new PlacesClient("test-key");
  const food = (id: string, name: string, lat: number, lng: number, primaryType: string, extra: Record<string, unknown> = {}) =>
    raw(id, name, lat, lng, { primaryType, types: [primaryType, "restaurant", "food"], ...extra });

  it("rejects cities and people when only food places are allowed", async () => {
    mockGoogle({
      "lucali": [raw("person", "Lucali Photography", 40.72, -74.04, { types: ["point_of_interest"] })],
    });
    expect(await resolveBranch(client, place({ name: "lucali", food_only: true }), HOME_JC)).toBeNull();
  });

  it("prefers the food business over a same-named non-food result", async () => {
    mockGoogle({
      "Lucali": [
        raw("gallery", "Lucali", 40.7, -74.0, { types: ["art_gallery"] }),
        food("pizza", "Lucali", 40.6806, -74.0005, "pizza_restaurant"),
      ],
    });
    const res = await resolveBranch(client, place({ name: "Lucali" }), HOME_JC);
    expect(res?.best.id).toBe("pizza");
  });

  it("finds a chain's other branches from a branch-specific location tag", async () => {
    const site = (slug: string) => ({ websiteUri: `https://shakeshack.com/location/${slug}` });
    const calls = mockGoogle({
      "Shake Shack Madison Square Park": [food("msp", "Shake Shack Madison Square Park", 40.7414, -73.9882, "hamburger_restaurant", site("msp"))],
      "Shake Shack": [
        food("msp", "Shake Shack Madison Square Park", 40.7414, -73.9882, "hamburger_restaurant", site("msp")),
        food("jc", "Shake Shack Jersey City", 40.7196, -74.0413, "hamburger_restaurant", site("jc")),
        food("fake", "Shake Shack Fan Club", 40.72, -74.04, "bar", { websiteUri: "https://fans.example.com" }),
      ],
    });
    const res = await resolveBranch(client, place({ name: "Shake Shack Madison Square Park", food_only: true }), HOME_JC);
    expect(res?.best.id).toBe("jc");
    expect(res?.branches.map((b) => b.id).sort()).toEqual(["jc", "msp"]);
    expect(calls.map((c) => c.textQuery)).toContain("Shake Shack");
  });

  it.each([
    [["pizza_restaurant"], "Pizza"],
    [["mexican_restaurant"], "Tacos & Mexican"],
    [["coffee_shop"], "Coffee & Cafe"],
    [["bakery", "cafe"], "Bakery & Desserts"],
    [["ramen_restaurant", "japanese_restaurant"], "Ramen & Noodles"],
    [["cocktail_bar"], "Bar & Drinks"],
    [["barbecue_restaurant"], "BBQ"],
    [["korean_barbecue_restaurant"], "Korean"],
    [["vegan_restaurant"], "Vegetarian & Vegan"],
    [["restaurant"], "Other"],
  ])("maps %j to %s", (types, expected) => {
    expect(guessCategory(types)).toBe(expected);
  });

  it("falls back to cuisine words when Google only says restaurant", () => {
    const c = toCandidate(raw("x", "Taqueria Ramirez", 1, 1, { primaryType: "restaurant", types: ["restaurant"] }), null);
    expect(categoryFor(c, "")).toBe("Tacos & Mexican");
    expect(isFoodPlace(c)).toBe(true);
    expect(cuisineFor({ ...c, typeLabel: "Mexican Restaurant" })).toBe("Mexican");
  });

  it("names chains by what their branches share", () => {
    const b = (name: string) => toCandidate(raw(name, name, 1, 1), null);
    expect(businessName(b("Shake Shack Herald Square"), [b("Shake Shack Herald Square"), b("Shake Shack Grand Central")])).toBe("Shake Shack");
    expect(businessName(b("Din Tai Fung"), [b("Din Tai Fung"), b("Din Tai Fung Glendale")])).toBe("Din Tai Fung");
    expect(businessName(b("Joe's Pizza Broadway"), [b("Joe's Pizza Broadway")])).toBe("Joe's Pizza Broadway");
    expect(brandQuery("Shake Shack Madison Square Park")).toBe("Shake Shack");
    expect(brandQuery("Lucali")).toBe("");
  });
});

describe("the Rosetta Bakery reel from Apify", () => {
  // Branch coordinates are made up for the test. Only the caption is real.
  const client = new PlacesClient("test-key");
  const site = { websiteUri: "https://www.rosettabakery.com/" };
  const highStreet = raw("rb_high", "Rosetta Bakery", 33.9296, -84.344, { ...site, primaryType: "bakery", types: ["bakery", "cafe", "food"] });
  const westside = raw("rb_west", "Rosetta Bakery", 33.787, -84.412, { ...site, primaryType: "bakery", types: ["bakery", "cafe", "food"] });
  const [item] = JSON.parse(readFileSync(new URL("./fixtures/apify-rosetta.json", import.meta.url), "utf8"));
  const pin = ruleCandidates(mapApifyItem("https://www.instagram.com/reel/DdmxY_iRYKE/", item), null).primary[0];

  function google() {
    return mockGoogle({
      "Rosetta Bakery": [westside, highStreet],
      "Rosetta Bakery 120 High Street, Dunwoody, GA": [highStreet],
    });
  }

  it("saves the Westside branch for a home in Midtown", async () => {
    google();
    const res = await resolveBranch(client, pin, { address: "Midtown Atlanta", lat: 33.7812, lng: -84.3838 });
    expect(res?.best.id).toBe("rb_west");
    expect(res?.branches.map((b) => b.id)).toEqual(["rb_west", "rb_high"]);
    expect(categoryFor(res!.best)).toBe("Bakery & Desserts");
    expect(businessName(res!.best, res!.branches)).toBe("Rosetta Bakery");
  });

  it("saves the High Street branch the reel filmed for a home in Sandy Springs", async () => {
    const calls = google();
    const res = await resolveBranch(client, pin, { address: "Sandy Springs", lat: 33.9304, lng: -84.3733 });
    expect(res?.best.id).toBe("rb_high");
    expect(calls.map((c) => c.textQuery)).toEqual(["Rosetta Bakery", "Rosetta Bakery 120 High Street, Dunwoody, GA"]);
  });
});
