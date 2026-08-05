import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentLoop, Compactor, LoopDetector, ProviderSummaryGenerator, type AgentEvent, type SpawnExecutor, type SpawnExecutorContext, type SpawnRequest, type ToolRegistry } from "@lyra/core";
import type { ReliableProvider } from "@lyra/provider";
import { TranscriptStore } from "@lyra/session";

export interface AgentSpawnExecutorOptions {
  provider: ReliableProvider | (() => ReliableProvider);
  resolveEnvironment?: (model?: string) => { provider: ReliableProvider; model: string; owned?: boolean };
  tools(context: SpawnExecutorContext): (ToolRegistry & { close?(): Promise<void> }) | Promise<ToolRegistry & { close?(): Promise<void> }>;
  externalAcp?: (command: string, request: SpawnRequest, context: SpawnExecutorContext) => Promise<unknown>;
  peerLifecycle?: { register(id: string, label?: string): void; unregister(id: string): void };
  origin: string;
  defaultModel: string | (() => string);
  system(context: { workspace: string; session: string; model: string; tools: ReturnType<ToolRegistry["definitions"]> }): string;
  contextWindow?: number;
  turnTimeoutMs?: number;
  compactAt?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export function createAgentSpawnExecutor(options: AgentSpawnExecutorOptions): SpawnExecutor {
  if (!options || !options.provider || typeof options.tools !== "function") throw new TypeError("Provider and live tool registry getter are required for spawn execution.");
  const sessionRoot = resolve(options.origin, ".lyra", "sessions");
  return async (request, context) => {
    let tools: ToolRegistry & { close?(): Promise<void> } | undefined;
    let store: TranscriptStore | undefined;
    let selected: ReturnType<NonNullable<AgentSpawnExecutorOptions["resolveEnvironment"]>> | undefined;
    let provider: ReliableProvider | undefined;
    let registered = false;
    try {
      const childContext = context;
      const session = childContext.workspace.split("/").filter(Boolean).at(-1) ?? `agent-${Date.now()}`;
      await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
      const path = join(sessionRoot, `${session}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jsonl`);
      selected = options.resolveEnvironment?.(childContext.model);
      const model = selected?.model ?? childContext.model ?? (typeof options.defaultModel === "function" ? options.defaultModel() : options.defaultModel);
      provider = selected?.provider ?? (typeof options.provider === "function" ? options.provider() : options.provider);
      store = TranscriptStore.create({ path, name: request.label ?? session, origin: resolve(options.origin), workspace: childContext.workspace, provider: provider.transport.id, model });
      options.peerLifecycle?.register(childContext.id, request.label);
      registered = true;
      if (request.acp !== undefined) {
        if (!options.externalAcp) throw new Error("External ACP spawning is not configured.");
        return await options.externalAcp(request.acp, request, childContext);
      }
      tools = await options.tools(childContext);
      const contextWindow = options.contextWindow ?? 200_000;
      const loop = new AgentLoop({ provider, store, tools, model, system: options.system({ workspace: childContext.workspace, session, model, tools: tools.definitions() }), contextWindow, workspace: childContext.workspace, ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }), compactor: new Compactor({ transcript: store, summaryGenerator: new ProviderSummaryGenerator({ provider, model }), contextWindow, ...(options.compactAt === undefined ? {} : { threshold: options.compactAt }) }), loopDetector: new LoopDetector() });
      const prompt = request.context ? `${request.context}\n\n${request.task}` : request.task;
      const iterator = loop.runTurn(prompt, childContext.signal);
      let terminal;
      while (true) { const next = await iterator.next(); if (next.done) { terminal = next.value; break; } await options.onEvent?.(next.value); }
      const text = terminal.assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
      if (request.output_schema !== undefined) { try { return JSON.parse(text); } catch { throw new Error(`Typed spawn ${childContext.parentId ?? session} returned non-JSON output; revise the child task or schema.`); } }
      return text;
    } finally {
      store?.close();
      await tools?.close?.();
      if (selected?.owned) await provider?.transport.close?.();
      if (registered) options.peerLifecycle?.unregister(context.id);
    }
  };
}
