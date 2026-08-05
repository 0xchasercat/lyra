import { classifyProviderError, ProviderFault } from "./errors.ts";
import type {
  ProviderEvent,
  ProviderRequest,
  ProviderTransport,
  ReliableProviderEvent,
  TransportEvent,
} from "./types.ts";

export interface ReliableProviderOptions {
  maxAttempts?: number;
  headersTimeoutMs?: number;
  streamStallTimeoutMs?: number;
  turnTimeoutMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  compact?: (request: ProviderRequest) => Promise<ProviderRequest>;
  refreshAuth?: () => Promise<void>;
}

export class ReliableProvider {
  readonly transport: ProviderTransport;
  readonly options: Required<Pick<
    ReliableProviderOptions,
    "maxAttempts" | "headersTimeoutMs" | "streamStallTimeoutMs" | "turnTimeoutMs" | "random" | "sleep"
  >> & Pick<ReliableProviderOptions, "compact" | "refreshAuth">;

  constructor(transport: ProviderTransport, options: ReliableProviderOptions = {}) {
    this.transport = transport;
    this.options = {
      maxAttempts: options.maxAttempts ?? 8,
      headersTimeoutMs: options.headersTimeoutMs ?? 30_000,
      streamStallTimeoutMs: options.streamStallTimeoutMs ?? 45_000,
      turnTimeoutMs: options.turnTimeoutMs ?? 30 * 60_000,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? abortableSleep,
      ...(options.compact === undefined ? {} : { compact: options.compact }),
      ...(options.refreshAuth === undefined ? {} : { refreshAuth: options.refreshAuth }),
    };
  }

  async *stream(
    initialRequest: ProviderRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ReliableProviderEvent> {
    const turnTimeout = AbortSignal.timeout(this.options.turnTimeoutMs);
    const outerSignal = signal === undefined ? turnTimeout : AbortSignal.any([signal, turnTimeout]);
    let request = initialRequest;
    let transientAttempts = 0;
    let contentShapeRetries = 0;
    let contextRetries = 0;
    let authRetries = 0;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const attemptController = new AbortController();
      const attemptSignal = AbortSignal.any([outerSignal, attemptController.signal]);
      let produced = false;
      let completion: Extract<ProviderEvent, { type: "complete" }> | undefined;
      const toolCalls = new Map<string, string>();
      try {
        for await (const event of withStallDeadline(
          this.transport.stream(request, {
            signal: attemptSignal,
            headersTimeoutMs: this.options.headersTimeoutMs,
          }),
          this.options.streamStallTimeoutMs,
          attemptController,
        )) {
          if (completion !== undefined) {
            throw malformedCompletion("Provider emitted data after completing the turn");
          }
          if (isContentEvent(event)) produced = true;
          validateToolCallEvent(event, toolCalls);
          if (event.type === "complete") {
            if (toolCalls.size > 0) {
              throw malformedCompletion("Provider completed with an unterminated tool call");
            }
            if (!produced && event.stopReason !== "cancelled") {
              throw classifyProviderError({
                code: "empty_turn",
                message: "Provider returned an empty assistant turn",
              });
            }
            completion = event;
            continue;
          }
          yield event;
        }
        if (completion === undefined) {
          if (toolCalls.size > 0) {
            throw malformedCompletion("Provider stream ended with an unterminated tool call");
          }
          throw classifyProviderError({
            code: "stream_truncated",
            message: "Provider stream ended without a stop reason",
          });
        }
        yield completion;
        return;
      } catch (cause) {
        const fault = classifyProviderError({ cause });
        if (outerSignal.aborted) {
          if (turnTimeout.aborted && !(signal?.aborted ?? false)) {
            throw new ProviderFault({
              classification: "transient",
              providerMessage: `Turn exceeded ${this.options.turnTimeoutMs}ms; partial output was retained`,
              code: "turn_timeout",
              cause,
            });
          }
          throw outerSignal.reason;
        }

        const action = await this.recoveryAction(fault, {
          request,
          transientAttempts,
          contentShapeRetries,
          contextRetries,
          authRetries,
        });
        if (action.type === "surface") throw fault;
        if (action.type === "compact") {
          request = action.request;
          contextRetries += 1;
        } else if (action.type === "refresh_auth") {
          authRetries += 1;
        } else if (fault.classification === "content_shape") {
          contentShapeRetries += 1;
        } else {
          transientAttempts += 1;
        }

        const delayMs = fault.classification === "transient"
          ? fault.retryAfterMs ?? retryDelay(transientAttempts, this.options.random)
          : 0;
        yield {
          type: "retry",
          attempt: attempt + 1,
          maxAttempts: this.options.maxAttempts,
          reason: `${fault.classification}: ${fault.providerMessage}`,
          delayMs,
          resetsPartialOutput: produced,
        };
        if (delayMs > 0) await this.options.sleep(delayMs, outerSignal);
      } finally {
        attemptController.abort();
      }
    }

    throw new ProviderFault({
      classification: "transient",
      providerMessage: `Provider failed after ${this.options.maxAttempts} attempts`,
      code: "retry_exhausted",
    });
  }

  private async recoveryAction(
    fault: ProviderFault,
    state: {
      request: ProviderRequest;
      transientAttempts: number;
      contentShapeRetries: number;
      contextRetries: number;
      authRetries: number;
    },
  ): Promise<
    | { type: "retry" }
    | { type: "compact"; request: ProviderRequest }
    | { type: "refresh_auth" }
    | { type: "surface" }
  > {
    switch (fault.classification) {
      case "transient":
        return state.transientAttempts + 1 < this.options.maxAttempts ? { type: "retry" } : { type: "surface" };
      case "content_shape":
        return state.contentShapeRetries === 0 ? { type: "retry" } : { type: "surface" };
      case "context_overflow":
        if (state.contextRetries > 0 || this.options.compact === undefined) return { type: "surface" };
        return { type: "compact", request: await this.options.compact(state.request) };
      case "auth":
        if (state.authRetries > 0 || this.options.refreshAuth === undefined) return { type: "surface" };
        await this.options.refreshAuth();
        return { type: "refresh_auth" };
      case "quota":
      case "model_unavailable":
      case "bad_request":
      case "refusal":
        return { type: "surface" };
    }
  }
}

function isContentEvent(event: TransportEvent): boolean {
  return event.type !== "usage"
    && event.type !== "complete"
    && event.type !== "transport_fallback";
}

function validateToolCallEvent(event: TransportEvent, toolCalls: Map<string, string>): void {
  if (event.type === "tool_call_start") {
    if (toolCalls.has(event.id)) {
      throw malformedCompletion(`Provider started duplicate tool call ${event.id}`);
    }
    toolCalls.set(event.id, "");
    return;
  }
  if (event.type === "tool_call_delta") {
    const current = toolCalls.get(event.id);
    if (current === undefined) {
      throw malformedCompletion(`Provider streamed arguments for unknown tool call ${event.id}`);
    }
    toolCalls.set(event.id, current + event.argumentsDelta);
    return;
  }
  if (event.type !== "tool_call_end") return;

  const argumentsJson = toolCalls.get(event.id);
  if (argumentsJson === undefined) {
    throw malformedCompletion(`Provider ended unknown tool call ${event.id}`);
  }
  try {
    JSON.parse(argumentsJson);
  } catch (cause) {
    throw new ProviderFault({
      classification: "content_shape",
      providerMessage: `Provider returned malformed arguments for tool call ${event.id}`,
      code: "malformed_completion",
      raw: argumentsJson,
      cause,
    });
  }
  toolCalls.delete(event.id);
}

function malformedCompletion(message: string): ProviderFault {
  return classifyProviderError({ code: "malformed_completion", message });
}

function retryDelay(attempt: number, random: () => number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random()));
}

async function* withStallDeadline<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  controller: AbortController,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const fault = classifyProviderError({
              code: "stream_stalled",
              message: `Provider stream stalled for ${timeoutMs}ms`,
            });
            controller.abort(fault);
            reject(fault);
          }, timeoutMs);
        }),
      ]);
      if (next.done) return;
      yield next.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
