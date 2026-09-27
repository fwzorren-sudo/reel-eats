import { describe, expect, it } from "vitest";
import { DEFAULT_AI_MODEL, extractWithWorkersAI, parseAiPlaces } from "../src/workersai";
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
    const out = await extractWithWorkersAI(env, { ...meta, transcript: "Lucali just opened a second spot" }, null);
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
