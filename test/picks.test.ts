import { describe, expect, it } from "vitest";
import { pickName, tallyPick, validVoterId, type PickPerson, type PickVote } from "../src/picks";

const people = (...names: string[]): PickPerson[] => names.map((name, i) => ({ voter_id: `voter-${name.toLowerCase()}`, name, joined_at: i }));
const vote = (name: string, place_id: string, keep: boolean): PickVote => ({ voter_id: `voter-${name.toLowerCase()}`, place_id, keep: keep ? 1 : 0 });
const ids = ["a", "b", "c", "d"];

describe("Pass it along", () => {
  it("gives the first person every card", () => {
    const t = tallyPick("relay", ids, people("Alex"), [], "voter-alex");
    expect(t.left).toEqual(ids);
    expect(t.todo).toEqual(ids);
    expect(t.people).toEqual([{ name: "Alex", me: true, done: false, todo: 4 }]);
    expect(t.agreed).toEqual([]);
  });

  it("hands on only what's left, and a drop by anyone takes the place out", () => {
    const votes = [vote("Alex", "a", true), vote("Alex", "b", false), vote("Alex", "c", true), vote("Alex", "d", true)];
    let t = tallyPick("relay", ids, people("Alex", "Sam"), votes, "voter-sam");
    expect(t.left).toEqual(["a", "c", "d"]);
    expect(t.todo).toEqual(["a", "c", "d"]);
    expect(t.people.map((p) => [p.name, p.done])).toEqual([
      ["Alex", true],
      ["Sam", false],
    ]);
    expect(t.all_done).toBe(false);

    t = tallyPick("relay", ids, people("Alex", "Sam"), [...votes, vote("Sam", "a", true), vote("Sam", "c", false), vote("Sam", "d", true)], "voter-sam");
    expect(t.left).toEqual(["a", "d"]);
    expect(t.todo).toEqual([]);
    expect(t.agreed).toEqual(["a", "d"]);
    expect(t.all_done).toBe(true);
    expect(t.mine).toEqual({ a: true, c: false, d: true });
  });

  it("sends a place back to someone who already kept everything", () => {
    // Sam kept "a" and "c" before Alex dropped "c": Sam has nothing more to do.
    const t = tallyPick("relay", ["a", "c"], people("Alex", "Sam"), [vote("Sam", "a", true), vote("Sam", "c", true), vote("Alex", "a", true), vote("Alex", "c", false)], null);
    expect(t.left).toEqual(["a"]);
    expect(t.agreed).toEqual(["a"]);
    expect(t.all_done).toBe(true);
  });

  it("brings a place back when the only drop is taken back", () => {
    const t = tallyPick("relay", ids, people("Alex"), [vote("Alex", "a", true)], "voter-alex");
    expect(t.left).toEqual(ids);
    expect(t.todo).toEqual(["b", "c", "d"]);
  });
});

describe("Everyone votes", () => {
  it("gives everyone every card, and ranks by keeps", () => {
    const votes = [
      vote("Alex", "a", true),
      vote("Alex", "b", false),
      vote("Alex", "c", true),
      vote("Sam", "a", false),
      vote("Sam", "b", false),
      vote("Sam", "c", true),
      vote("Sam", "d", true),
    ];
    const t = tallyPick("vote", ids, people("Alex", "Sam"), votes, "voter-alex");
    expect(t.left).toEqual(ids);
    expect(t.todo).toEqual(["d"]);
    // "d" and "a" have one keep each; "a" was also dropped once.
    expect(t.ranking.map((r) => r.place_id)).toEqual(["c", "d", "a", "b"]);
    expect(t.ranking[0]).toEqual({ place_id: "c", kept_by: ["Alex", "Sam"], dropped_by: [] });
    expect(t.ranking[3].dropped_by).toEqual(["Alex", "Sam"]);
    expect(t.agreed).toEqual(["c"]);
    expect(t.people).toEqual([
      { name: "Alex", me: true, done: false, todo: 1 },
      { name: "Sam", me: false, done: true, todo: 0 },
    ]);
  });

  it("calls nothing agreed with one person", () => {
    const t = tallyPick("vote", ids, people("Alex"), ids.map((id) => vote("Alex", id, true)), "voter-alex");
    expect(t.agreed).toEqual([]);
    expect(t.all_done).toBe(true);
  });
});

it("ignores swipes on places that dropped out, and from people who aren't in the pick", () => {
  const t = tallyPick("relay", ["a", "b"], people("Alex"), [vote("Alex", "gone", false), vote("Stranger", "a", false)], "voter-alex");
  expect(t.left).toEqual(["a", "b"]);
  expect(t.mine).toEqual({});
});

it("gives someone who hasn't joined the cards, but no swipes", () => {
  const t = tallyPick("relay", ids, people("Alex"), [vote("Alex", "b", false)], "voter-new");
  expect(t.todo).toEqual(["a", "c", "d"]);
  expect(t.people.every((p) => !p.me)).toBe(true);
});

it("tidies names and checks voter ids", () => {
  expect(pickName("  Sam \n Smith ")).toBe("Sam Smith");
  expect(pickName("x".repeat(40))).toHaveLength(24);
  expect(pickName("   ")).toBeNull();
  expect(pickName(7)).toBeNull();
  expect(validVoterId("v-12345678")).toBe(true);
  expect(validVoterId("short")).toBe(false);
  expect(validVoterId("has space 1234")).toBe(false);
});
