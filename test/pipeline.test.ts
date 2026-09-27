import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleFor, storedMeta, summarize } from "../src/pipeline";
import { mapApifyItem } from "../src/source";
import type { PlaceRow, ShareRow } from "../src/types";

const [post] = JSON.parse(readFileSync(new URL("./fixtures/apify-post-details-rosetta.json", import.meta.url), "utf8"));
const url = "https://www.instagram.com/reel/DdmxY_iRYKE/";

describe("the restaurant's Instagram account", () => {
  const meta = mapApifyItem(url, post);
  it("is the tagged or mentioned account that matches the name", () => {
    expect(handleFor("Rosetta Bakery", meta)).toBe("rosettabakery");
  });
  it("is empty when no account matches", () => {
    expect(handleFor("Joe's Pizza", meta)).toBe("");
  });
});

describe("re-processing a share", () => {
  const share = {
    id: "s1",
    source_url: url,
    raw_post: JSON.stringify(post),
    transcript: "Rosetta Bakery is selling out daily.",
    source_caption: post.caption.text,
    posted_at: null,
  } as unknown as ShareRow;

  it("rebuilds the reel's details from the stored Apify result instead of paying again", () => {
    const meta = storedMeta(share)!;
    expect(meta.author).toBe("atlfoodiesofficial");
    expect(meta.location?.lat).toBe(33.7566);
    expect(meta.transcript).toBe("Rosetta Bakery is selling out daily.");
  });

  it("uses the stored caption when there's no raw result", () => {
    const meta = storedMeta({ ...share, raw_post: null, source_author: "someone" })!;
    expect(meta).toMatchObject({ author: "someone", via: "embed" });
    expect(meta.caption).toContain("Rosetta Bakery");
  });

  it("fetches again when nothing was stored", () => {
    expect(storedMeta({ ...share, raw_post: null, source_caption: null })).toBeNull();
  });
});

describe("the reply after sharing", () => {
  const p = { id: "p1", name: "Tacos Del Norte", located: 1, distance_m: 8000, city: "Queens, NY" } as PlaceRow;
  it("says when another creator's reel was added to a saved place", () => {
    expect(summarize([], [p], "mi", true, { p1: 2 })).toBe(
      "Already on your list: Tacos Del Norte. Added this reel to it. 2 creators have recommended it now.",
    );
    expect(summarize([], [p], "mi", true)).toBe("Already on your list: Tacos Del Norte.");
  });
});
