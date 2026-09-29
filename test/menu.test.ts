import { afterEach, describe, expect, it, vi } from "vitest";
import { findMenuLink, menuDue, MENU_RECHECK_MS, pickMenuLink } from "../src/menu";
import { formatPriceRange, PlacesClient, toCandidate } from "../src/places";

const page = (links: string) => `<html><body><nav>${links}</nav></body></html>`;

describe("finding a menu link on a restaurant's site", () => {
  it("takes a link labelled Menu, made absolute", () => {
    expect(pickMenuLink(page('<a href="/menu/">Menu</a>'), "https://tinlizzyscantina.com/")).toBe("https://tinlizzyscantina.com/menu/");
    expect(pickMenuLink(page('<a href="/menus"><span>Our</span> <b>Menus</b></a>'), "http://valenzarestaurant.com/")).toBe(
      "http://valenzarestaurant.com/menus",
    );
  });

  it("prefers a labelled link to one with menu only in its address", () => {
    const html = page('<a href="/menu-of-the-day-blog">News</a><a href="/food/">Food · Explore the Menu</a>');
    expect(pickMenuLink(html, "https://www.rosettabakery.com/")).toBe("https://www.rosettabakery.com/food/");
  });

  it("gives a PDF menu a small edge", () => {
    const html = page('<a href="/menu">Menu</a><a href="/files/dinner-menu.pdf">Dinner menu</a>');
    expect(pickMenuLink(html, "https://example.com/")).toBe("https://example.com/files/dinner-menu.pdf");
  });

  it("keeps a jump to the menu section, but not a link back to the page", () => {
    expect(pickMenuLink(page('<a href="#menus">Menus</a>'), "https://lacuevaatl.com/")).toBe("https://lacuevaatl.com/#menus");
    // Hamp & Harry's "MENU" link points at its own home page.
    expect(pickMenuLink(page('<a href="https://www.hampandharrys.com/">MENU</a>'), "https://www.hampandharrys.com/")).toBeNull();
    expect(pickMenuLink(page('<a href="#" class="menu-toggle">Menu</a>'), "https://example.com/")).toBeNull();
  });

  it("ignores social sites, mail links and delivery apps when there's anything better", () => {
    expect(pickMenuLink(page('<a href="https://www.instagram.com/x/">Menu on Instagram</a>'), "https://example.com/")).toBeNull();
    expect(pickMenuLink(page('<a href="mailto:hi@example.com">Menu questions</a>'), "https://example.com/")).toBeNull();
    const html = page('<a href="https://www.doordash.com/store/x">Order from our menu</a><a href="/menu">Menu</a>');
    expect(pickMenuLink(html, "https://example.com/")).toBe("https://example.com/menu");
  });

  it("reads an icon link's aria-label", () => {
    expect(pickMenuLink(page('<a href="/food" aria-label="View our menu"><svg></svg></a>'), "https://example.com/")).toBe("https://example.com/food");
  });

  it("returns nothing for a page without one", () => {
    expect(pickMenuLink(page('<a href="/about">About</a><a href="/order">Order online</a>'), "https://example.com/")).toBeNull();
  });
});

describe("fetching the site", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows the site's own address after a redirect", async () => {
    vi.stubGlobal("fetch", async () => {
      const res = new Response(page('<a href="menu">Menu</a>'), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      Object.defineProperty(res, "url", { value: "https://www.cuddlefishatl.com/home/" });
      return res;
    });
    expect(await findMenuLink("https://cuddlefishatl.com/")).toBe("https://www.cuddlefishatl.com/home/menu");
  });

  it("gives up on a site that turns the request away", async () => {
    vi.stubGlobal("fetch", async () => new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/html" } }));
    expect(await findMenuLink("https://khanskitchenatlanta.com/")).toBeNull();
    expect(await findMenuLink("not a url")).toBeNull();
  });
});

describe("when to look again", () => {
  const at = 1_800_000_000_000;
  it("looks once per website, then monthly", () => {
    expect(menuDue({ website: null, menu_checked_for: null, menu_checked_at: null }, at)).toBe(false);
    expect(menuDue({ website: "https://a.com/", menu_checked_for: null, menu_checked_at: null }, at)).toBe(true);
    expect(menuDue({ website: "https://a.com/", menu_checked_for: "https://a.com/", menu_checked_at: at - 1000 }, at)).toBe(false);
    expect(menuDue({ website: "https://b.com/", menu_checked_for: "https://a.com/", menu_checked_at: at - 1000 }, at)).toBe(true);
    expect(menuDue({ website: "https://a.com/", menu_checked_for: "https://a.com/", menu_checked_at: at - MENU_RECHECK_MS - 1 }, at)).toBe(true);
  });
});

describe("Google's price range", () => {
  it("reads like Google Maps shows it", () => {
    expect(formatPriceRange({ startPrice: { currencyCode: "USD", units: "20" }, endPrice: { currencyCode: "USD", units: "30" } })).toBe("$20–30");
    expect(formatPriceRange({ startPrice: { currencyCode: "USD", units: "100" } })).toBe("$100+");
    expect(formatPriceRange({ startPrice: { currencyCode: "EUR", units: "10" }, endPrice: { units: "20" } })).toBe("€10–20");
    expect(formatPriceRange({ startPrice: { currencyCode: "CHF", units: "30" }, endPrice: { units: "50" } })).toBe("CHF 30–50");
    expect(formatPriceRange(undefined)).toBe("");
  });

  it("comes with every search result", () => {
    const c = toCandidate(
      {
        id: "v",
        displayName: { text: "Valenza Restaurant" },
        location: { latitude: 33.87, longitude: -84.33 },
        priceRange: { startPrice: { currencyCode: "USD", units: "30" }, endPrice: { currencyCode: "USD", units: "70" } },
      },
      null,
    );
    expect(c.priceRange).toBe("$30–70");
  });
});

describe("Google's review summary and features", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks only for the summary and features, and keeps Google's credits", async () => {
    let mask = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      mask = (init.headers as Record<string, string>)["X-Goog-FieldMask"];
      return Response.json({
        reviewSummary: {
          text: { text: "People say the pasta is excellent." },
          disclosureText: { text: "Summarized with Gemini" },
          flagContentUri: "https://www.google.com/local/review/rap/report?x",
          reviewsUri: "https://www.google.com/maps/place//data=reviews",
        },
        outdoorSeating: true,
        goodForGroups: true,
        liveMusic: false,
        takeout: true,
      });
    });
    const extras = await new PlacesClient("key").extras("ChIJ123");
    expect(mask.split(",")).toEqual(expect.arrayContaining(["reviewSummary", "outdoorSeating", "servesCocktails"]));
    expect(mask).not.toMatch(/reviews,|photos|priceRange/);
    expect(extras.summary).toEqual({
      text: "People say the pasta is excellent.",
      disclosure: "Summarized with Gemini",
      flagUri: "https://www.google.com/local/review/rap/report?x",
      reviewsUri: "https://www.google.com/maps/place//data=reviews",
    });
    expect(extras.features).toEqual(["Outdoor seating", "Good for groups", "Takeout"]);
  });

  it("has no summary when Google has none", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ takeout: true }));
    const extras = await new PlacesClient("key").extras("ChIJ123");
    expect(extras).toEqual({ summary: null, features: ["Takeout"] });
  });
});
