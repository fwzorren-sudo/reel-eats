import { AsyncLocalStorage } from "node:async_hooks";

/** One outside call or decision while processing a share. */
export interface TraceStep {
  step: string;
  /** Milliseconds from the start of the attempt. */
  at: number;
  ms: number;
  ok: boolean;
  detail?: string;
  error?: string;
}

/** One attempt at processing a share, as stored in shares.debug. */
export interface Attempt {
  started: number;
  trigger: string;
  ms: number;
  outcome: "running" | "done" | "failed" | "handed over" | "cut off";
  error?: string;
  steps: TraceStep[];
}

const MAX_STEPS = 80;
/** Only the most recent attempts are kept. */
export const MAX_ATTEMPTS = 5;

export class Trace {
  readonly started = Date.now();
  readonly steps: TraceStep[] = [];
  constructor(readonly trigger: string) {}

  add(step: string, ms: number, ok: boolean, detail?: string, error?: string): void {
    if (this.steps.length >= MAX_STEPS) return;
    const at = Math.max(0, Date.now() - this.started - ms);
    this.steps.push({ step, at, ms, ok, ...(detail ? { detail: detail.slice(0, 300) } : {}), ...(error ? { error: error.slice(0, 300) } : {}) });
  }

  note(step: string, detail: string): void {
    this.add(step, 0, true, detail);
  }

  attempt(outcome: Attempt["outcome"], error?: string): Attempt {
    return { started: this.started, trigger: this.trigger, ms: Date.now() - this.started, outcome, ...(error ? { error } : {}), steps: this.steps };
  }
}

const store = new AsyncLocalStorage<Trace>();

/** Run `fn` with `trace` as the current trace, so calls made inside it get recorded. */
export const runTraced = <T>(trace: Trace, fn: () => Promise<T>): Promise<T> => store.run(trace, fn);
export const currentTrace = (): Trace | undefined => store.getStore();

export const errorText = (err: unknown): string => (err instanceof Error ? `${err.name === "Error" ? "" : `${err.name}: `}${err.message}` : String(err));

/** Time an async call and record it in the current trace, if there is one. */
export async function traced<T>(step: string, fn: () => Promise<T>, describe?: (result: T) => string): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    currentTrace()?.add(step, Date.now() - t0, true, describe?.(result));
    return result;
  } catch (err) {
    currentTrace()?.add(step, Date.now() - t0, false, undefined, errorText(err));
    throw err;
  }
}

/**
 * Add this attempt to a share's stored log, replacing an earlier save of the same attempt.
 * An attempt still marked "running" from before was cut off.
 */
export function mergeAttempt(previous: string | null, attempt: Attempt): string {
  let list: Attempt[] = [];
  try {
    const parsed = previous ? JSON.parse(previous) : [];
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  list = list
    .filter((a) => a.started !== attempt.started)
    .map((a) => (a.outcome === "running" ? { ...a, outcome: "cut off" as const } : a));
  list.push(attempt);
  return JSON.stringify(list.slice(-MAX_ATTEMPTS));
}
