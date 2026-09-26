import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPlaces, sanitizeExtraction } from "../src/extract";
import { emptyMeta } from "../src/source";
import type { Env } from "../src/types";

const env = { ANTHROPIC_API_KEY: "sk-test", CLAUDE_MODEL: "claude-opus-5", CLAUDE_EFFORT: "medium" } as Env;

function message(content: unknown[], stop_reason: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const saveCall = (input: unknown) => ({ type: "tool_use", id: "toolu_1", name: "save_places", input });

afterEach(() => vi.unstubAllGlobals());

describe("sanitizeExtraction", () => {
  it("cleans up odd values", () => {
    const out = sanitizeExtraction({
      places: [
        { name: "  Tacos Del Norte ", category: "Mexican food", confidence: "sure", instagram_handle: "@tacosdelnorte", dishes: ["Birria", 3] },
        { name: "" },
      ],
      reason: "",
    });
    expect(out.places).toHaveLength(1);
    expect(out.places[0]).toMatchObject({
      name: "Tacos Del Norte",
      category: "Other",
      confidence: "medium",
      instagram_handle: "tacosdelnorte",
      search_query: "Tacos Del Norte",
      dishes: ["Birria"],
      multi_location: false,
    });
  });
});

describe("extractPlaces", () => {
  it("sends the caption with web search and fallbacks, and reads the tool call", async () => {
    const bodies: any[] = [];
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      headers.push(new Headers(init.headers));
      return new Response(
        JSON.stringify(
          message(
            [
              { type: "text", text: "Looks like Tacos Del Norte." },
              saveCall({
                places: [
                  {
                    name: "Tacos Del Norte", alt_names: ["tacosdelnorte"], search_query: "Tacos Del Norte", city: "Queens, NY",
                    address_hint: "", instagram_handle: "tacosdelnorte", category: "Tacos & Mexican", cuisine: "Birria tacos",
                    summary: "Rich birria with consomé.", dishes: ["Birria tacos"], multi_location: false, confidence: "high",
                  },
                ],
                reason: "",
              }),
            ],
            "tool_use",
          ),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const out = await extractPlaces(env, {
      url: "https://www.instagram.com/reel/ABC/",
      meta: { ...emptyMeta(""), author: "nycfoodie", caption: "Best birria @tacosdelnorte", locationName: "Tacos Del Norte" },
      sharedText: null,
      note: null,
      image: null,
    });

    expect(out.places[0].name).toBe("Tacos Del Norte");
    expect(out.places[0].category).toBe("Tacos & Mexican");
    const body = bodies[0];
    expect(body.model).toBe("claude-opus-5");
    expect(body.fallbacks).toBe("default");
    expect(headers[0].get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.tools.map((t: any) => t.type ?? t.name)).toEqual(["save_places", "web_search_20260209"]);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.messages[0].content.at(-1).text).toContain("<location_tag>Tacos Del Norte</location_tag>");
  });

  it("resumes after pause_turn and nudges when Claude answers in text", async () => {
    const replies = [
      message([{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } }], "pause_turn"),
      message([{ type: "text", text: "I think it's Lucali." }], "end_turn"),
      message([saveCall({ places: [], reason: "Not a restaurant." })], "tool_use"),
    ];
    const seen: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const out = await extractPlaces({ ...env, CLAUDE_WEB_SEARCH: "off" }, { url: null, meta: null, sharedText: "hi", note: null, image: null });
    expect(out).toEqual({ places: [], reason: "Not a restaurant." });
    expect(seen).toHaveLength(3);
    expect(seen[0].tools).toHaveLength(1);
    expect(seen[1].messages.at(-1).role).toBe("assistant");
    expect(seen[2].messages.at(-1).role).toBe("user");
  });

  it("drops fallbacks and effort for Haiku", async () => {
    let body: any;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(message([saveCall({ places: [], reason: "none" })], "tool_use")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await extractPlaces({ ...env, CLAUDE_MODEL: "claude-haiku-4-5" }, { url: null, meta: null, sharedText: "x", note: null, image: null });
    expect(body.fallbacks).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.tools[1].type).toBe("web_search_20250305");
  });

  it("surfaces refusals", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(message([], "refusal")), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(
      extractPlaces(env, { url: null, meta: null, sharedText: "x", note: null, image: null }),
    ).rejects.toThrow(/declined/);
  });
});
