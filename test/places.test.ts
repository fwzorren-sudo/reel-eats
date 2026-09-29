import { afterEach, describe, expect, it, vi } from "vitest";
import { brandQuery, categoryFor, cuisineFor, guessCategory, isFoodPlace, PlacesClient, resolveBranch, toCandidate } from "../src/places";
import { businessName } from "../src/pipeline";
import { attachHandles, CITY_RADIUS_M, closestHandle, ruleCandidates } from "../src/identify";
import { emptyMeta } from "../src/source";
import { mapApifyItem } from "../src/source";
import { readFileSync } from "node:fs";
import { distanceMeters } from "../src/geo";
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
  const calls: { textQuery: string; bias: boolean; circle?: { center: { latitude: number; longitude: number }; radius: number } }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ textQuery: body.textQuery, bias: !!body.locationBias, circle: body.locationBias?.circle });
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

describe("hours and time zone", () => {
  it("keeps Google's opening hours, time zone and offset", () => {
    const periods = [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } }];
    const c = toCandidate(
      raw("x", "Rosetta Bakery", 33.93, -84.34, {
        regularOpeningHours: { openNow: true, periods, weekdayDescriptions: ["Monday: 8:00 AM – 5:00 PM"] },
        timeZone: { id: "America/New_York" },
        utcOffsetMinutes: -240,
      }),
      null,
    );
    expect(c.hours).toEqual({ periods, weekdayDescriptions: ["Monday: 8:00 AM – 5:00 PM"] });
    expect(c.timeZone).toBe("America/New_York");
    expect(c.utcOffset).toBe(-240);
  });

  it("leaves them empty when Google has none", () => {
    const c = toCandidate(raw("y", "Pop-up", 40, -74), null);
    expect(c).toMatchObject({ hours: null, timeZone: "", utcOffset: null });
  });
});

describe("searching where the reel was filmed", () => {
  const client = new PlacesClient("test-key");
  const site = { websiteUri: "https://www.rosettabakery.com/", primaryType: "bakery", types: ["bakery", "food"] };
  const highStreet = raw("rb_high", "Rosetta Bakery", 33.9296, -84.344, site);
  const buckhead = raw("rb_buck", "Rosetta Bakery", 33.8384, -84.3797, site);
  const [post] = JSON.parse(readFileSync(new URL("./fixtures/apify-post-details-rosetta.json", import.meta.url), "utf8"));
  const meta = mapApifyItem("https://www.instagram.com/reel/DdmxY_iRYKE/", post);

  it("biases the reel's own search to the location tag's coordinates, and measures distance from home", async () => {
    const rules = ruleCandidates(meta, null);
    expect(rules.area).toEqual({ lat: 33.7566, lng: -84.3889, radius: CITY_RADIUS_M });
    const pin = rules.primary[0];
    expect(pin.near).toEqual(rules.area);
    const calls = mockGoogle({
      "Rosetta Bakery": [buckhead, highStreet],
      "Rosetta Bakery 120 High Street, Dunwoody, GA": [highStreet],
    });
    const carrollton = { address: "Carrollton, GA", lat: 33.5801, lng: -85.0766 };
    const res = await resolveBranch(client, pin, carrollton);
    const filmed = calls.find((c) => c.textQuery.includes("High Street"))!;
    expect(filmed.circle).toEqual({ center: { latitude: 33.7566, longitude: -84.3889 }, radius: CITY_RADIUS_M });
    const nearHome = calls.find((c) => c.textQuery === "Rosetta Bakery")!;
    expect(nearHome.circle?.center).toEqual({ latitude: 33.5801, longitude: -85.0766 });
    expect(res?.best.id).toBe("rb_buck");
    // Measured from home in Carrollton, not from the Atlanta location tag.
    expect(res!.best.distanceM).toBe(Math.round(distanceMeters(carrollton.lat, carrollton.lng, 33.8384, -84.3797)));
    expect(res!.best.distanceM).toBeGreaterThan(60000);
  });

  it("searches right at a venue's location tag when the post gives no city", async () => {
    const venue = { ...meta, caption: "So good", mentions: [], locationName: "Rosetta Bakery", location: { name: "Rosetta Bakery", lat: 33.9296, lng: -84.344, address: "120 High St", city: "Dunwoody, Georgia" } };
    const [c] = ruleCandidates(venue, null).primary;
    expect(c.near).toEqual({ lat: 33.9296, lng: -84.344, radius: 1500 });
    expect(c.address_hint).toBe("120 High St, Dunwoody, Georgia");
  });
});

describe("food check", () => {
  it("doesn't mistake a barber shop for a food business", () => {
    expect(isFoodPlace({ primaryType: "barber_shop", types: ["barber_shop", "hair_care", "point_of_interest", "establishment"] })).toBe(false);
    expect(isFoodPlace({ primaryType: "shopping_mall", types: ["shopping_mall", "point_of_interest"] })).toBe(false);
  });
  it("still accepts food shops, bars and restaurants", () => {
    for (const t of ["coffee_shop", "bagel_shop", "ice_cream_shop", "cocktail_bar", "wine_bar", "mexican_restaurant", "steak_house", "bakery"]) {
      expect(isFoodPlace({ primaryType: t, types: [t] })).toBe(true);
    }
  });
});

describe("the branch in the reel", () => {
  const client = new PlacesClient("test-key");
  const site = { websiteUri: "https://tinlizzyscantina.com/", primaryType: "mexican_restaurant", types: ["mexican_restaurant", "restaurant", "food"] };
  const downtown = raw("tl_down", "Tin Lizzy's Cantina", 33.7603, -84.3915, site);
  const midtown = raw("tl_mid", "Tin Lizzy's Taco Americana", 33.7847, -84.3847, site);
  const kennesaw = raw("tl_ken", "Tin Lizzy's Cantina", 34.0151, -84.5677, site);

  it("is reported alongside the nearest one, from the location tag's coordinates", async () => {
    mockGoogle({
      "Tin Lizzy's Cantina": [downtown, midtown, kennesaw],
      "Tin Lizzy's Cantina 77 12th St NE": [midtown, downtown],
      "Tin Lizzy's": [downtown, midtown, kennesaw],
    });
    const tag = place({ name: "Tin Lizzy's Cantina", search_query: "Tin Lizzy's Cantina", address_hint: "77 12th St NE", near: { lat: 33.78467, lng: -84.38468, radius: 1500 } });
    const carrollton = { address: "Carrollton, GA", lat: 33.5801, lng: -85.0766 };
    const res = await resolveBranch(client, tag, carrollton);
    expect(res?.best.id).toBe("tl_down");
    expect(res?.filmed?.id).toBe("tl_mid");
    expect(res?.branches.map((b) => b.id)).toContain("tl_mid");
  });

  it("is unknown when the post doesn't say where", async () => {
    mockGoogle({ "Tin Lizzy's Cantina": [downtown, midtown] });
    const res = await resolveBranch(client, place({ name: "Tin Lizzy's Cantina", search_query: "Tin Lizzy's Cantina" }), { address: "x", lat: 33.58, lng: -85.08 });
    expect(res?.filmed).toBeNull();
  });
});

describe("the Instagram handle and the venue's website (reels from Sep 27)", () => {
  const client = new PlacesClient("test-key");
  const carrollton = { address: "Carrollton, GA", lat: 33.5801, lng: -85.0766 };
  const mexican = { primaryType: "mexican_restaurant", types: ["mexican_restaurant", "restaurant", "food"] };
  const ct = (id: string, name: string, lat: number, lng: number, site: string) => raw(id, name, lat, lng, { ...mexican, websiteUri: site });
  const dunwoody = ct("ct_dun", "CT Cantina & Taqueria", 33.926, -84.341, "https://www.cttacos.com/");
  const alpharetta = ct("ct_alp", "CT Cantina & Taqueria", 34.07, -84.29, "https://www.cttacos.com/alpharetta");
  const fayetteville = ct("ct_fay", "CT Cantina & Taqueria", 33.43, -84.58, "https://www.cttacos.com/");
  const reforma = ct("ct_ref", "CT Reforma Taqueria - Buckhead", 33.85, -84.36, "https://reforma.cttacos.com/");
  const alPastor = ct("ct_alpa", "CT Al Pastor Taqueria", 34.13, -84.2, "https://alpastor.cttacos.com/");

  it("finds @cttacos as CT Cantina & Taqueria through its website, and not its sister restaurants", async () => {
    mockGoogle({
      "CT Tacos": [dunwoody, alpharetta, fayetteville, reforma, alPastor],
      "CT Tacos Dunwoody": [dunwoody],
    });
    const c = place({ name: "CT Tacos", search_query: "CT Tacos", city: "Dunwoody", food_only: true });
    attachHandles([c], { ...emptyMeta("x"), mentions: ["cttacos"] });
    expect(c.instagram_handle).toBe("cttacos");
    const res = await resolveBranch(client, c, carrollton);
    expect(res?.branches.map((b) => b.id).sort()).toEqual(["ct_alp", "ct_dun", "ct_fay"]);
    expect(res?.best.id).toBe("ct_fay");
    expect(res?.filmed?.id).toBe("ct_dun");
  });

  it("prefers @laylocafe's Laylo Cafe over Lalo's Cafe when the transcript misheard the name", async () => {
    const bakery = { primaryType: "bakery", types: ["bakery", "cafe", "food"] };
    const laylo = raw("laylo", "Laylo Cafe", 33.886, -84.3, { ...bakery, websiteUri: "https://laylocafe.com/" });
    const lalos = raw("lalos", "Lalo's Cafe", 33.92, -84.35, { primaryType: "cafe", types: ["cafe", "food"] });
    mockGoogle({ "Lalo Cafe": [lalos], "Lalo Cafe Chamblee": [laylo, lalos] });
    const c = place({ name: "Lalo Cafe", search_query: "Lalo Cafe", city: "Chamblee", food_only: true });
    attachHandles([c], { ...emptyMeta("x"), mentions: ["laylocafe"] });
    expect(c.alt_names).toEqual(["laylocafe"]);
    const res = await resolveBranch(client, c, carrollton);
    expect(res?.best.id).toBe("laylo");
    expect(res?.branches.map((b) => b.id)).toEqual(["laylo"]);
  });

  it("links a name to a handle only when they're close", () => {
    expect(closestHandle("Lalo Cafe", ["atlpeachyeats", "laylocafe"])).toBe("laylocafe");
    expect(closestHandle("Khan's Kitchen", ["khans_kitchen_atlanta"])).toBe("khans_kitchen_atlanta");
    expect(closestHandle("Rosetta Bakery", ["highstreetatl", "atlfoodiesofficial"])).toBe("");
    expect(closestHandle("CT", ["ct"])).toBe("");
  });
});

describe("categories when Google only says restaurant (reels from Sep 28)", () => {
  const generic = (name: string) => toCandidate(raw("x", name, 33.9, -84.3, { primaryType: "restaurant", types: ["restaurant", "food"] }), null);
  it("uses the dishes before the name", () => {
    expect(categoryFor(generic("Cuddlefish"), "", ["sushi", "temaki"])).toBe("Japanese & Sushi");
  });
  it("falls back to the post's opening line", () => {
    expect(categoryFor(generic("Hamp & Harry's"), "", [], "pov: you find a Wizardry Themed Pop - Up Bar just north of Atlanta!")).toBe("Bar & Drinks");
  });
  it("goes by the post's tags when nothing else says what it is", () => {
    const lab = generic("Sip and Science The Drunken Laboratory");
    const opening = "☀️ ATLANTA ☀️ Looking for a date night you’ll actually remember? 🧪💙 Grab your partner and experience hands-on science experiments, great drinks";
    expect(categoryFor(lab, "", [], opening)).toBe("Other");
    expect(categoryFor(lab, "", [], opening, ["cocktails", "date night"])).toBe("Bar & Drinks");
    // The tags come last: a named cuisine still wins.
    expect(categoryFor(generic("Valenza"), "Italian", [], "", ["cocktails"])).toBe("Italian");
  });
  it("names a single branch without Google's branch suffix", () => {
    const h = generic("Habaneros | Midtown");
    expect(businessName(h, [h])).toBe("Habaneros");
  });
});
