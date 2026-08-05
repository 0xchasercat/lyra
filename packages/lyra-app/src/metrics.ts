import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type MetricEvent =
  | { type: "turn"; latencyMs: number; success: boolean; createdAt?: string }
  | { type: "provider_retry"; classification: string; createdAt?: string }
  | { type: "tool"; name: string; success: boolean; firstCall: boolean; latencyMs: number; createdAt?: string }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; createdAt?: string }
  | { type: "context_repair"; count: number; createdAt?: string };
export interface HealthReport { turns: number; successfulTurns: number; turnLatencyMs: { p50: number; p95: number; p99: number }; retries: Readonly<Record<string, number>>; compactions: number; contextRepairs: number; tools: Readonly<Record<string, { calls: number; successes: number; firstCallSuccessRate: number; latencyP95Ms: number }>>; malformedMetrics: number; processes?: number; workspaces?: number; }

export class MetricsStore {
  readonly path: string;
  #tail: Promise<void> = Promise.resolve();
  constructor(origin: string) { if (typeof origin !== "string" || origin.length === 0) throw new TypeError("Metrics origin is required."); this.path = resolve(origin, ".lyra", "metrics.jsonl"); }
  record(event: MetricEvent): Promise<void> { validateEvent(event); const persisted = { ...event, createdAt: event.createdAt ?? new Date().toISOString() }; this.#tail = this.#tail.then(async () => { await mkdir(dirname(this.path), { recursive: true }); await appendFile(this.path, `${JSON.stringify(persisted)}\n`, { mode: 0o600 }); }); return this.#tail; }
  async health(extra: { processes?: number; workspaces?: number } = {}): Promise<HealthReport> {
    await this.#tail;
    let raw = "";
    try { raw = await readFile(this.path, "utf8"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const events: MetricEvent[] = []; let malformedMetrics = 0;
    for (const line of raw.split("\n").filter(Boolean)) { try { const value: unknown = JSON.parse(line); if (!isMetricEvent(value)) { malformedMetrics += 1; continue; } events.push(value); } catch { malformedMetrics += 1; } }
    const turns = events.filter((event): event is Extract<MetricEvent, { type: "turn" }> => event.type === "turn");
    const retries: Record<string, number> = {};
    for (const event of events) if (event.type === "provider_retry") retries[event.classification] = (retries[event.classification] ?? 0) + 1;
    const tools: Record<string, { calls: number; successes: number; firstCalls: number; firstSuccesses: number; latencies: number[] }> = {};
    for (const event of events) if (event.type === "tool") { const value = tools[event.name] ??= { calls: 0, successes: 0, firstCalls: 0, firstSuccesses: 0, latencies: [] }; value.calls += 1; if (event.success) value.successes += 1; if (event.firstCall) { value.firstCalls += 1; if (event.success) value.firstSuccesses += 1; } value.latencies.push(event.latencyMs); }
    const toolReport: Record<string, { calls: number; successes: number; firstCallSuccessRate: number; latencyP95Ms: number }> = {};
    for (const [name, value] of Object.entries(tools)) toolReport[name] = { calls: value.calls, successes: value.successes, firstCallSuccessRate: value.firstCalls === 0 ? 1 : value.firstSuccesses / value.firstCalls, latencyP95Ms: percentile(value.latencies, 0.95) };
    return { turns: turns.length, successfulTurns: turns.filter((event) => event.success).length, turnLatencyMs: { p50: percentile(turns.map((event) => event.latencyMs), 0.5), p95: percentile(turns.map((event) => event.latencyMs), 0.95), p99: percentile(turns.map((event) => event.latencyMs), 0.99) }, retries, compactions: events.filter((event) => event.type === "compaction").length, contextRepairs: events.reduce((total, event) => total + (event.type === "context_repair" ? event.count : 0), 0), tools: toolReport, malformedMetrics, ...(extra.processes === undefined ? {} : { processes: extra.processes }), ...(extra.workspaces === undefined ? {} : { workspaces: extra.workspaces }) };
  }
}

function percentile(values: number[], ratio: number): number { if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!; }
function isMetricEvent(value: unknown): value is MetricEvent { if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return false; switch (value.type) { case "turn": return "latencyMs" in value && typeof value.latencyMs === "number" && "success" in value && typeof value.success === "boolean"; case "provider_retry": return "classification" in value && typeof value.classification === "string"; case "tool": return "name" in value && typeof value.name === "string" && "success" in value && typeof value.success === "boolean" && "firstCall" in value && typeof value.firstCall === "boolean" && "latencyMs" in value && typeof value.latencyMs === "number"; case "compaction": return "tokensBefore" in value && typeof value.tokensBefore === "number" && "tokensAfter" in value && typeof value.tokensAfter === "number"; case "context_repair": return "count" in value && typeof value.count === "number"; default: return false; } }
function validateEvent(event: MetricEvent): void { if (!isMetricEvent(event)) throw new TypeError("Metric event is invalid."); }
