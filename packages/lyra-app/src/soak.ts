import { MetricsStore } from "./metrics.ts";

export type LoopSpec = { kind: "count"; count: number } | { kind: "duration"; durationMs: number } | { kind: "until"; condition: string; maxCycles: number };
export interface SoakCycleResult { done?: boolean; progress: boolean; latencyMs: number; detail?: string; }
export interface SoakRunnerOptions { metrics: MetricsStore; cycle(goal: string, index: number, signal: AbortSignal): Promise<SoakCycleResult>; processCount(): number | Promise<number>; workspaceLeakCount(): number | Promise<number>; cycleTimeoutMs?: number; now?: () => number; }
export interface SoakResult { cycles: number; stopped: "complete" | "condition" | "no_progress" | "cancelled"; elapsedMs: number; rssStart: number; rssPeak: number; orphanedProcesses: number; workspaceLeaks: number; }

export class SoakRunner {
  readonly #options: SoakRunnerOptions;
  constructor(options: SoakRunnerOptions) { if (!options || typeof options.cycle !== "function") throw new TypeError("Soak cycle function is required."); this.#options = options; }
  async run(goal: string, spec: LoopSpec, signal?: AbortSignal): Promise<SoakResult> {
    if (typeof goal !== "string" || goal.trim().length === 0) throw new TypeError("Soak goal is required.");
    validateSpec(spec);
    const now = this.#options.now ?? Date.now;
    const started = now();
    const rssStart = process.memoryUsage().rss;
    let rssPeak = rssStart;
    let cycles = 0;
    let noProgress = 0;
    let stopped: SoakResult["stopped"] = "complete";
    while (shouldContinue(spec, cycles, now() - started)) {
      if (signal?.aborted) { stopped = "cancelled"; break; }
      const controller = new AbortController();
      const parentAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", parentAbort, { once: true });
      const timeoutMs = this.#options.cycleTimeoutMs ?? 30 * 60_000;
      const timer = setTimeout(() => controller.abort(new Error(`Soak cycle ${cycles + 1} exceeded ${timeoutMs}ms.`)), timeoutMs);
      const before = now();
      try {
        const result = await Promise.race([this.#options.cycle(goal, cycles, controller.signal), abort(controller.signal)]);
        cycles += 1;
        noProgress = result.progress ? 0 : noProgress + 1;
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        await this.#options.metrics.record({ type: "turn", latencyMs: result.latencyMs || now() - before, success: true });
        if (result.done && spec.kind === "until") { stopped = "condition"; break; }
        if (noProgress >= 10) { stopped = "no_progress"; break; }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", parentAbort);
      }
    }
    const [orphanedProcesses, workspaceLeaks] = await Promise.all([this.#options.processCount(), this.#options.workspaceLeakCount()]);
    return { cycles, stopped, elapsedMs: now() - started, rssStart, rssPeak, orphanedProcesses, workspaceLeaks };
  }
}

export function parseLoopSpec(value: string): LoopSpec {
  const trimmed = value.trim(); if (/^\d+$/.test(trimmed)) { const count = Number(trimmed); if (count < 1) throw new TypeError("Loop count must be positive."); return { kind: "count", count }; }
  const duration = /^(\d+)(m|h|d)$/.exec(trimmed); if (duration) { const amount = Number(duration[1]); const factor = duration[2] === "m" ? 60_000 : duration[2] === "h" ? 3_600_000 : 86_400_000; return { kind: "duration", durationMs: amount * factor }; }
  const condition = /^until\s+["'](.+)["']$/i.exec(trimmed); if (condition) return { kind: "until", condition: condition[1]!, maxCycles: 10_000 };
  throw new TypeError('Loop spec must be a count, duration like 30m, or until "condition".');
}
function validateSpec(spec: LoopSpec): void { if (!spec || typeof spec !== "object") throw new TypeError("Loop spec is required."); if (spec.kind === "count" && (!Number.isSafeInteger(spec.count) || spec.count < 1)) throw new TypeError("Loop count must be positive."); if (spec.kind === "duration" && (!Number.isFinite(spec.durationMs) || spec.durationMs < 1)) throw new TypeError("Loop duration must be positive."); if (spec.kind === "until" && (typeof spec.condition !== "string" || spec.condition.length === 0 || !Number.isSafeInteger(spec.maxCycles) || spec.maxCycles < 1)) throw new TypeError("Until loop requires a condition and positive maxCycles."); }
function shouldContinue(spec: LoopSpec, cycles: number, elapsed: number): boolean { return spec.kind === "count" ? cycles < spec.count : spec.kind === "duration" ? elapsed < spec.durationMs : cycles < spec.maxCycles; }
function abort(signal: AbortSignal): Promise<never> { if (signal.aborted) return Promise.reject(signal.reason); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
