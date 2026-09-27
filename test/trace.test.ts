import { describe, expect, it } from "vitest";
import { currentTrace, MAX_ATTEMPTS, mergeAttempt, runTraced, Trace, traced } from "../src/trace";

describe("the debug log", () => {
  it("records timed calls made inside a traced run, and nothing outside one", async () => {
    const trace = new Trace("waiting");
    await runTraced(trace, async () => {
      await traced("google search", async () => 3, (n) => `${n} results`);
      await traced("apify", async () => {
        throw new Error("HTTP 402");
      }).catch(() => {});
      currentTrace()?.note("saved", "Lucali");
    });
    await traced("outside", async () => 1);
    expect(trace.steps.map((s) => [s.step, s.ok, s.detail ?? s.error])).toEqual([
      ["google search", true, "3 results"],
      ["apify", false, "HTTP 402"],
      ["saved", true, "Lucali"],
    ]);
    expect(trace.attempt("done")).toMatchObject({ trigger: "waiting", outcome: "done", steps: trace.steps });
  });

  it("replaces an attempt saved part way, marks an earlier unfinished one as cut off, and keeps the last few", () => {
    const a = new Trace("background");
    let log = mergeAttempt(null, a.attempt("running"));
    const b = new Trace("every-minute job");
    Object.defineProperty(b, "started", { value: a.started + 1 });
    log = mergeAttempt(log, b.attempt("running"));
    log = mergeAttempt(log, b.attempt("done"));
    expect(JSON.parse(log).map((x: { trigger: string; outcome: string }) => `${x.trigger}: ${x.outcome}`)).toEqual([
      "background: cut off",
      "every-minute job: done",
    ]);
    for (let i = 0; i < 10; i++) {
      const t = new Trace(`try ${i}`);
      Object.defineProperty(t, "started", { value: a.started + 10 + i });
      log = mergeAttempt(log, t.attempt("done"));
    }
    expect(JSON.parse(log)).toHaveLength(MAX_ATTEMPTS);
    expect(mergeAttempt("not json", a.attempt("done"))).toContain('"outcome":"done"');
  });
});
