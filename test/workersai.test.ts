import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_TIMEOUT_MS, DEFAULT_AI_MODEL, extractWithWorkersAI, parseAiPlaces, salvagePlaces, SYSTEM } from "../src/workersai";
import { emptyMeta } from "../src/source";
import type { Env } from "../src/types";

const meta = { ...emptyMeta("https://www.instagram.com/reel/X/"), author: "nycfoodie", caption: "Went to Lucali last night, the calzone!", locationName: "" };

function fakeAi(reply: unknown | (() => never)) {
  const calls: { model: string; input: any }[] = [];
  const AI = {
    run: async (model: string, input: unknown) => {
      calls.push({ model, input });
      if (typeof reply === "function") return (reply as () => never)();
      return reply;
    },
  };
  return { env: { AI } as unknown as Env, calls };
}

describe("extractWithWorkersAI", () => {
  it("asks the model for JSON and maps the answer", async () => {
    const { env, calls } = fakeAi({
      response: { places: [{ name: "Lucali", city: "Brooklyn", cuisine: "Pizza", summary: "Great calzone.", dishes: ["Calzone"] }] },
    });
    const out = await extractWithWorkersAI(env, meta, null);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Lucali", city: "Brooklyn", dishes: ["Calzone"], food_only: true, category_from_google: true });
    expect(calls[0].model).toBe(DEFAULT_AI_MODEL);
    expect(calls[0].input.response_format.type).toBe("json_schema");
    expect(calls[0].input.messages[1].content).toContain("Went to Lucali last night");
  });

  it("returns nothing when AI is off, missing, or failing", async () => {
    const off = fakeAi({ response: { places: [{ name: "X" }] } });
    expect(await extractWithWorkersAI({ ...off.env, AI_MODEL: "off" }, meta, null)).toEqual([]);
    expect(off.calls).toHaveLength(0);
    expect(await extractWithWorkersAI({} as Env, meta, null)).toEqual([]);
    const broken = fakeAi(() => {
      throw new Error("JSON Mode couldn't be met");
    });
    expect(await extractWithWorkersAI(broken.env, meta, null)).toEqual([]);
  });
});

describe("tags, go-soon notes and the transcript", () => {
  it("sends the transcript and keeps only allowed tags", async () => {
    const { env, calls } = fakeAi({
      response: {
        places: [{ name: "Lucali", city: "", cuisine: "", summary: "", dishes: [], tags: ["date night", "romantic vibes", "DATE NIGHT"], go_soon: "New opening" }],
      },
    });
    const out = await extractWithWorkersAI(env, { ...meta, transcript: "Lucali just opened a second spot, perfect for a date" }, null);
    expect(out[0].tags).toEqual(["date night"]);
    expect(out[0].go_soon).toBe("New opening");
    expect(calls[0].input.messages[1].content).toContain("Spoken in the video:\nLucali just opened a second spot");
    const schema = calls[0].input.response_format.json_schema;
    expect(schema.properties.places.items.properties.tags.items.enum).toContain("coffee date");
  });
});

describe("parseAiPlaces", () => {
  it("accepts a JSON string reply and drops empty names", () => {
    const out = parseAiPlaces('Here you go: {"places":[{"name":"Katz\'s","city":"NYC"},{"name":""}]}');
    expect(out.map((p) => p.name)).toEqual(["Katz's"]);
  });
  it("tolerates junk", () => {
    expect(parseAiPlaces("no json here")).toEqual([]);
    expect(parseAiPlaces({ places: "nope" })).toEqual([]);
  });
});

describe("answers that go wrong", () => {
  afterEach(() => vi.useRealTimers());

  // What Llama actually sent back for the La Cueva reel: tags repeated until max_tokens.
  const looping =
    '{"places": [{"city": "Atlanta", "cuisine": "", "dishes": ["goat cheese croquettes", "birria tortellini", "smashburger"], "go_soon": "New opening", "name": "La Cueva", "summary": "", "tags": ["date night", "cocktails", "date night", "live music", "date night", "live music", "date';

  it("keeps the complete places from an answer that was cut off", () => {
    expect(salvagePlaces('{"places": [{"name": "A", "note": "has } and { inside"}, {"name": "B"}, {"name": "C", "ta')).toEqual([
      { name: "A", note: "has } and { inside" },
      { name: "B" },
    ]);
    expect(salvagePlaces(looping)).toEqual([]);
    expect(parseAiPlaces(looping)).toEqual([]);
  });

  it("lists the allowed tags in the prompt, which stops the repeating", () => {
    expect(SYSTEM).toContain("at most 4, each used once, only from this list: date night, coffee date");
  });

  it("drops tags the post doesn't back up", () => {
    const text = "La Cueva speakeasy with a glowing bar and live music";
    const [p] = parseAiPlaces({ places: [{ name: "La Cueva", tags: ["splurge", "cocktails", "live music", "date night"] }] }, text);
    expect(p.tags).toEqual(["cocktails", "live music"]);
  });

  it("gives up after the time limit and falls back to the rules", async () => {
    vi.useFakeTimers();
    const env = { AI: { run: () => new Promise(() => {}) } } as unknown as Env;
    const result = extractWithWorkersAI(env, meta, null);
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS + 10);
    expect(await result).toEqual([]);
  });
});
