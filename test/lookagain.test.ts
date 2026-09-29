import { afterEach, describe, expect, it, vi } from "vitest";
import { dishCase, htmlText, lookAgain, lookAgainPrompt, menuPageText, suggestionsFrom, type LookAgainInput } from "../src/lookagain";
import { emptyMeta } from "../src/source";
import type { Env, PlaceRow } from "../src/types";

const place = (extra: Partial<PlaceRow> = {}): PlaceRow =>
  ({
    id: "p1",
    name: "Sip and Science The Drunken Laboratory",
    category: "Other",
    cuisine: null,
    summary: "A science-themed date night.",
    dishes: "[]",
    tags: '["date night"]',
    go_soon: null,
    instagram_handle: "thedrunkenlab",
    address: "Forest Park, GA",
    city: "Forest Park, GA",
    branches: "[]",
    google_place_id: "lab",
    website: null,
    menu_url: null,
    menu_by_hand: 0,
    menu_checked_for: null,
    ...extra,
  }) as PlaceRow;

const meta = {
  ...emptyMeta("https://www.instagram.com/reel/X/"),
  author: "atlfoodie",
  caption: "Hands-on science experiments, great drinks, interactive games, music and nonstop laughs @thedrunkenlab",
  mentions: ["thedrunkenlab"],
};

const input = (extra: Partial<LookAgainInput> = {}): LookAgainInput => ({
  place: place(),
  meta,
  sharedText: null,
  otherCaptions: [],
  note: "It's a cocktail bar",
  wrongPlace: false,
  ...extra,
});

describe("what Look again suggests", () => {
  it("follows the note, and offers each change separately", () => {
    const s = suggestionsFrom({ category: "Bar & Drinks", cuisine: "Cocktail bar", tags: ["date night", "cocktails"], dishes: [], go_soon: "" }, input(), "");
    expect(s.map((x) => x.field)).toEqual(["category", "cuisine", "tags_add"]);
    expect(s[0]).toMatchObject({ from: "Other", to: "Bar & Drinks" });
    expect(s[2]).toMatchObject({ to: ["cocktails"] });
  });

  it("adds a tag only when the post, the note or the menu backs it up", () => {
    const s = suggestionsFrom({ category: "Other", tags: ["date night", "rooftop", "live music"] }, input({ note: "" }), "");
    expect(s.find((x) => x.field === "tags_add")).toMatchObject({ to: ["live music"] });
    expect(s.find((x) => x.field === "tags_remove")).toBeUndefined();
  });

  it("drops a tag only when the note names it", () => {
    const tagged = place({ tags: '["brunch","cheap eats","date night"]' });
    const named = input({ place: tagged, note: "cheap eats is wrong, it's a $40 buffet" });
    expect(suggestionsFrom({ category: "Other", tags: ["brunch"] }, named, "").filter((x) => x.field === "tags_remove")).toEqual([
      { field: "tags_remove", from: ["brunch", "cheap eats", "date night"], to: ["cheap eats"] },
    ]);
    // "It's a cocktail bar" says nothing about date night, so it stays even if the model drops it.
    const other = input({ place: tagged, note: "It's a cocktail bar" });
    expect(suggestionsFrom({ category: "Other", tags: ["cocktails"] }, other, "").find((x) => x.field === "tags_remove")).toBeUndefined();
    expect(suggestionsFrom({ category: "Other" }, other, "").find((x) => x.field.startsWith("tags"))).toBeUndefined();
  });

  it("ignores a category that isn't one of the app's, and an account the post doesn't name", () => {
    const s = suggestionsFrom({ category: "Science Bar", instagram_handle: "someoneelse" }, input(), "");
    expect(s.map((x) => x.field)).toEqual([]);
    expect(suggestionsFrom({ category: "Other", instagram_handle: "@thedrunkenlab" }, input({ place: place({ instagram_handle: null }) }), "")).toEqual([
      { field: "instagram_handle", from: "", to: "thedrunkenlab" },
    ]);
  });

  it("cleans up dishes and go-soon notes", () => {
    const s = suggestionsFrom({ category: "Other", dishes: ["SHORT RIB BIRRIA", "Fried lobster tacos", "short rib birria"], go_soon: "New location just opened" }, input(), "");
    expect(s.find((x) => x.field === "dishes")?.to).toEqual(["Short Rib Birria", "Fried lobster tacos"]);
    expect(s.find((x) => x.field === "go_soon")?.to).toBe("New opening");
    expect(dishCase("TL NACHOS")).toBe("Tl Nachos");
    expect(dishCase("iPhone")).toBe("iPhone");
  });

  it("gives the model the saved entry, the note, the whole transcript and the menu", () => {
    const text = lookAgainPrompt(input({ meta: { ...meta, transcript: "a".repeat(5000) + " the end" }, wrongPlace: true }), "Tacos $4\nConsomé $3");
    expect(text).toContain("Category: Other");
    expect(text).toContain('Note from the person: "It\'s a cocktail bar"');
    expect(text).toContain("It may be the wrong place or branch: yes");
    expect(text).toContain(" the end");
    expect(text).toContain("Menu page:\nTacos $4");
  });
});

describe("menu pages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the text and leaves out scripts and styles", () => {
    expect(htmlText("<html><head><title>x</title></head><body><style>a{}</style><h2>Tacos</h2><p>Birria &amp; consomé</p><script>x()</script></body></html>")).toBe(
      "Tacos\nBirria & consomé",
    );
  });

  it("skips PDFs and documents", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await menuPageText("https://example.com/menu.pdf")).toBe("");
    expect(await menuPageText("https://docs.google.com/gview?url=x")).toBe("");
    expect(await menuPageText(null)).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("asking the model", () => {
  afterEach(() => vi.unstubAllGlobals());

  const fakeEnv = (reply: unknown, model?: string) => {
    const calls: { model: string; input: any }[] = [];
    const env = {
      AI: { run: async (m: string, i: unknown) => (calls.push({ model: m, input: i }), reply) },
      LOOK_AGAIN_MODEL: model,
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }), first: async () => null }) },
      GOOGLE_MAPS_API_KEY: "key",
    } as unknown as Env;
    return { env, calls };
  };

  it("uses Workers AI's JSON mode with Llama, and OpenAI-style requests with other models", async () => {
    const llama = fakeEnv({ response: { category: "Bar & Drinks", tags: [], dishes: [] } });
    const r = await lookAgain(llama.env, input());
    expect(llama.calls[0].input.response_format).toMatchObject({ type: "json_schema" });
    expect(llama.calls[0].input.max_tokens).toBeGreaterThan(0);
    expect(r.suggestions[0]).toMatchObject({ field: "category", to: "Bar & Drinks" });
    const qwen = fakeEnv({ choices: [{ message: { content: '{"category":"Bar & Drinks","tags":[],"dishes":[]}' } }] }, "@cf/qwen/qwen3.8-27b");
    const q = await lookAgain(qwen.env, input());
    expect(qwen.calls[0].input.response_format.json_schema.name).toBe("look_again");
    expect(q.suggestions[0]).toMatchObject({ field: "category", to: "Bar & Drinks" });
  });

  it("searches the model's query and the post's handles for the right place, handle matches first", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).textQuery as string;
      queries.push(q);
      const P = (id: string, name: string, website = "") => ({ id, displayName: { text: name }, location: { latitude: 33.9, longitude: -84.3 }, primaryType: "cafe", types: ["cafe"], websiteUri: website });
      return Response.json({ places: q.startsWith("laylocafe") ? [P("laylo", "Laylo Cafe", "https://laylocafe.com/")] : [P("lalos", "Lalo's Cafe"), P("laylo", "Laylo Cafe", "https://laylocafe.com/")] });
    });
    const { env } = fakeEnv({ response: { category: "Coffee & Cafe", search_query: "Lalo's Cafe Chamblee", tags: [], dishes: [] } });
    const r = await lookAgain(env, input({ place: place({ name: "Lalo's Cafe", instagram_handle: "laylocafe", google_place_id: "lalos" }), note: "", wrongPlace: true }));
    expect(queries).toEqual(["Lalo's Cafe Chamblee", "laylocafe", "thedrunkenlab"]);
    expect(r.query).toBe("Lalo's Cafe Chamblee");
    expect(r.candidates.map((c) => c.id)).toEqual(["laylo", "lalos"]);
  });

  it("says so when the answer can't be read", async () => {
    const { env } = fakeEnv({ response: "not json" });
    await expect(lookAgain(env, input())).rejects.toThrow(/couldn't be read/);
  });
});
