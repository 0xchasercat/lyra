import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentLoop, Compactor, LoopDetector, ProviderSummaryGenerator, SteerQueue, type AgentEvent, type SpawnExecutor, type SpawnExecutorContext, type SpawnRequest, type ToolCheckpointer, type ToolRegistry } from "@lyra/core";
import type { CheckpointAccess } from "./integrated-tools.ts";
import type { ReliableProvider } from "@lyra/provider";
import { TranscriptStore } from "@lyra/session";

/**
 * A child's undo history.
 *
 * A child running in the parent's directory shares the parent's stream, so a rewind covers
 * everything that happened in that tree whoever did it. A child in an isolated workspace
 * gets its own store rooted there, so its checkpoints travel with the work and survive
 * the parent — and `close` releases it when the child ends.
 */
export interface ChildCheckpoints {
  checkpointer: ToolCheckpointer;
  access?: CheckpointAccess;
  close?(): Promise<void>;
}

export interface AgentSpawnExecutorOptions {
  provider: ReliableProvider | (() => ReliableProvider);
  resolveEnvironment?: (model?: string) => { provider: ReliableProvider; model: string; owned?: boolean };
  checkpoints?(context: SpawnExecutorContext): Promise<ChildCheckpoints | undefined>;
  tools(context: SpawnExecutorContext, checkpoints?: CheckpointAccess): (ToolRegistry & { close?(): Promise<void> }) | Promise<ToolRegistry & { close?(): Promise<void> }>;
  externalAcp?: (command: string, request: SpawnRequest, context: SpawnExecutorContext) => Promise<unknown>;
  /**
   * Connects this child's live turn to its mailbox, so a message from another agent folds
   * in at its next tool boundary. Returns a detach function; a child with no bus simply
   * runs without asides.
   */
  asides?(context: SpawnExecutorContext, steering: SteerQueue): (() => void) | undefined;
  origin: string;
  defaultModel: string | (() => string);
  system(context: { workspace: string; session: string; model: string; tools: ReturnType<ToolRegistry["definitions"]> }): string;
  contextWindow?: number;
  turnTimeoutMs?: number;
  toolTimeouts?: Readonly<Record<string, number>>;
  compactAt?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export function createAgentSpawnExecutor(options: AgentSpawnExecutorOptions): SpawnExecutor {
  if (!options || !options.provider || typeof options.tools !== "function") throw new TypeError("Provider and live tool registry getter are required for spawn execution.");
  const sessionRoot = resolve(options.origin, ".lyra", "sessions");
  /**
   * Where each child's transcript lives, by spawn id.
   *
   * This is what makes revival a *continuation* (LYRA.md §9: "a message revives a parked
   * agent. The only resume primitive"). A revived child re-opens the same file and adds one
   * turn to it, so it still knows what it was doing; a fresh store would produce an agent
   * with the same name and no memory, which is the failure mode the primitive exists to avoid.
   */
  const transcripts = new Map<string, { path: string; session: string }>();
  return async (request, context) => {
    let tools: ToolRegistry & { close?(): Promise<void> } | undefined;
    let checkpoints: ChildCheckpoints | undefined;
    let store: TranscriptStore | undefined;
    let selected: ReturnType<NonNullable<AgentSpawnExecutorOptions["resolveEnvironment"]>> | undefined;
    let provider: ReliableProvider | undefined;
    let detachAsides: (() => void) | undefined;
    try {
      const childContext = context;
      const steering = new SteerQueue();
      // A child in its own workspace is named by it; one sharing the parent's directory is
      // named by its peer name, because the directory's basename is the *project's* name
      // and would file every shared child's transcript under it.
      const existing = childContext.resume === true ? transcripts.get(childContext.id) : undefined;
      const session = existing?.session ?? (childContext.workspaceName ?? (childContext.workspace === resolve(options.origin)
        ? childContext.peer
        : (childContext.workspace.split("/").filter(Boolean).at(-1) ?? `agent-${Date.now()}`)));
      selected = options.resolveEnvironment?.(childContext.model);
      const model = selected?.model ?? childContext.model ?? (typeof options.defaultModel === "function" ? options.defaultModel() : options.defaultModel);
      provider = selected?.provider ?? (typeof options.provider === "function" ? options.provider() : options.provider);
      // Before the transcript: an external harness keeps its own, and creating one here
      // wrote a `.jsonl` per delegation that nothing ever read.
      if (request.acp !== undefined) {
        if (!options.externalAcp) throw new Error("External ACP spawning is not configured.");
        return await options.externalAcp(request.acp, request, childContext);
      }
      if (existing !== undefined) {
        store = TranscriptStore.open(existing.path);
      } else {
        await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
        const path = join(sessionRoot, `${session.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jsonl`);
        store = TranscriptStore.create({ path, name: request.label ?? session, origin: resolve(options.origin), workspace: childContext.workspace, provider: provider.transport.id, model });
        remember(transcripts, childContext.id, { path, session });
      }
      checkpoints = await options.checkpoints?.(childContext);
      tools = await options.tools(childContext, checkpoints?.access);
      const contextWindow = options.contextWindow ?? 200_000;
      const loop = new AgentLoop({ provider, store, tools, model, system: options.system({ workspace: childContext.workspace, session, model, tools: tools.definitions() }), contextWindow, workspace: childContext.workspace, ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }), ...(options.toolTimeouts === undefined ? {} : { toolTimeouts: options.toolTimeouts }), compactor: new Compactor({ transcript: store, summaryGenerator: new ProviderSummaryGenerator({ provider, model }), contextWindow, ...(options.compactAt === undefined ? {} : { threshold: options.compactAt }) }), loopDetector: new LoopDetector(), ...(checkpoints === undefined ? {} : { checkpointer: checkpoints.checkpointer }) });
      // Attached only for the duration of the turn: a message that arrives while the child
      // is running folds into it, and one that arrives after it parks revives it instead.
      detachAsides = options.asides?.(childContext, steering);
      const prompt = request.context ? `${request.context}\n\n${request.task}` : request.task;
      const iterator = loop.runTurn(prompt, childContext.signal, { steering });
      let terminal;
      while (true) {
        const next = await iterator.next();
        if (next.done) { terminal = next.value; break; }
        reportActivity(childContext, next.value);
        await options.onEvent?.(next.value);
      }
      const text = terminal.assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
      if (request.output_schema !== undefined) { try { return JSON.parse(text); } catch { throw new Error(`Typed spawn ${childContext.peer} returned non-JSON output; revise the child task or schema.`); } }
      return text;
    } finally {
      // Each independently: `tools.close()` shuts down an owned language server, and one
      // that refuses to die must not take the checkpoint store and an owned provider
      // transport with it — nor replace the child's actual result with its own failure.
      for (const close of [
        () => detachAsides?.(),
        () => store?.close(),
        () => tools?.close?.(),
        () => checkpoints?.close?.(),
        () => selected?.owned === true ? provider?.transport.close?.() : undefined,
      ]) {
        try { await close(); } catch { /* one leak reported nowhere beats four caused by it */ }
      }
    }
  };
}

/** How many children stay revivable. Matches the spawn manager's own job retention. */
const RETAINED_TRANSCRIPTS = 64;

/** Remember where a child's transcript is, without growing forever in a long session. */
function remember(transcripts: Map<string, { path: string; session: string }>, id: string, entry: { path: string; session: string }): void {
  transcripts.set(id, entry);
  while (transcripts.size > RETAINED_TRANSCRIPTS) {
    const oldest = transcripts.keys().next();
    if (oldest.done === true) return;
    transcripts.delete(oldest.value);
  }
}

/**
 * Turn one loop event into the observable step a parent's `spawn status` reads.
 *
 * This is the whole of a child's outward visibility while it runs, so it is deliberately
 * cheap and deliberately total: nothing here may throw into the middle of a turn, and every
 * number it reports is something that actually happened rather than an estimate.
 */
function reportActivity(context: SpawnExecutorContext, event: AgentEvent): void {
  try {
    switch (event.type) {
      case "tool_started":
        context.activity({ state: "awaiting_tool", tool: event.name, toolCall: true });
        return;
      case "tool_finished": {
        const modified = event.result.progress?.filesModified?.map((entry) => entry.path) ?? [];
        context.activity({ state: "running", ...(modified.length === 0 ? {} : { filesModified: modified }) });
        return;
      }
      case "text_delta":
        context.activity({ text: event.text });
        return;
      default:
        return;
    }
  } catch { /* observation must never be able to fail the child it observes */ }
}
