import { afterEach, describe, expect, it, vi } from "vitest";
import { PlacesClient, resolveBranch } from "../src/places";
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
