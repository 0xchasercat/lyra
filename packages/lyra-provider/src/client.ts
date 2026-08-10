import { classifyProviderError, ProviderFault } from "./errors.ts";
import { halveOutputCap, isOutputCapFault, OutputCapMemory, parseOutputCap } from "./output-limit.ts";
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
  /**
   * The §3.3 inter-token deadline: how long the stream may be silent *after* it has produced
   * output. It deliberately does not apply before the first token — see
   * {@link withStallDeadline} for why the pre-first-token phase has no deadline of its own.
   */
  streamStallTimeoutMs?: number;
  turnTimeoutMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  compact?: (request: ProviderRequest) => Promise<ProviderRequest>;
  refreshAuth?: () => Promise<void>;
  /**
   * Where output-token ceilings learned from this provider's own 400s are remembered.
   *
   * Injectable so a caller can share one memory across providers that front the same
   * endpoint, or inspect what was learned; the default is a fresh per-provider memory,
   * which is the scope the fact actually has.
   */
  outputCaps?: OutputCapMemory;
}

/** How many times one turn may lower its output ask before the refusal is surfaced. */
const MAX_OUTPUT_CAP_RETRIES = 3;

export class ReliableProvider {
  readonly transport: ProviderTransport;
  /** Output ceilings this provider has stated, so the discovery 400 is paid once. */
  readonly outputCaps: OutputCapMemory;
  readonly options: Required<Pick<
    ReliableProviderOptions,
    "maxAttempts" | "headersTimeoutMs" | "streamStallTimeoutMs" | "turnTimeoutMs" | "random" | "sleep"
  >> & Pick<ReliableProviderOptions, "compact" | "refreshAuth">;

  constructor(transport: ProviderTransport, options: ReliableProviderOptions = {}) {
    this.transport = transport;
    this.outputCaps = options.outputCaps ?? new OutputCapMemory();
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
    // The ask starts at whatever the caller resolved from model metadata, lowered by
    // anything this provider has already refused for this model in this session. Without
    // the clamp the first turn after a discovery 400 would ask too high again and pay the
    // round trip a second time.
    let request = applyLearnedOutputCap(initialRequest, this.outputCaps);
    let transientAttempts = 0;
    let contentShapeRetries = 0;
    let contextRetries = 0;
    let authRetries = 0;
    let outputCapRetries = 0;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const attemptController = new AbortController();
      const attemptSignal = AbortSignal.any([outerSignal, attemptController.signal]);
      const liveness = new StreamLiveness();
      let produced = false;
      let completion: Extract<ProviderEvent, { type: "complete" }> | undefined;
      const toolCalls = new Map<string, string>();
      try {
        for await (const event of withStallDeadline(
          this.transport.stream(request, {
            signal: attemptSignal,
            headersTimeoutMs: this.options.headersTimeoutMs,
            onLiveness: () => liveness.tick(),
          }),
          this.options.streamStallTimeoutMs,
          attemptController,
          liveness,
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

        // Checked ahead of the classification switch because an output-cap rejection is a
        // fact about *our own* request field, not about the conversation: it classifies as a
        // plain `bad_request`, which would surface a raw 400 for a number the user never
        // chose. §3.8's rule is that Lyra's own guess must never become the user's error.
        if (isOutputCapFault(fault) && outputCapRetries < MAX_OUTPUT_CAP_RETRIES) {
          const asked = request.maxOutputTokens;
          const stated = parseOutputCap(fault.providerMessage, asked);
          const next = stated ?? (asked === undefined ? undefined : halveOutputCap(asked));
          if (next !== undefined && (asked === undefined || next < asked)) {
            this.outputCaps.learn(request.model, next);
            request = { ...request, maxOutputTokens: next };
            outputCapRetries += 1;
            yield {
              type: "retry",
              attempt: attempt + 1,
              maxAttempts: this.options.maxAttempts,
              // Retries are visible (§3.2), and this one is worth reading: it says the
              // provider named a lower ceiling and the turn is being re-asked against it.
              reason: `${fault.classification}: lowering the output-token ask to ${next} — ${fault.providerMessage}`,
              classification: fault.classification,
              providerMessage: fault.providerMessage,
              delayMs: 0,
              retryAtMs: Date.now(),
              resetsPartialOutput: produced,
            };
            continue;
          }
        }

        const action = await this.recoveryAction(fault, {
          request,
          transientAttempts,
          contentShapeRetries,
          contextRetries,
          authRetries,
        });
        if (action.type === "surface") {
          throw isOutputCapFault(fault) ? unrecoverableOutputCap(fault, request) : fault;
        }
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
          classification: fault.classification,
          providerMessage: fault.providerMessage,
          delayMs,
          retryAtMs: Date.now() + delayMs,
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

/** Lower a request's output ask to whatever this provider has already proven it accepts. */
function applyLearnedOutputCap(request: ProviderRequest, caps: OutputCapMemory): ProviderRequest {
  const clamped = caps.clamp(request.model, request.maxOutputTokens);
  if (clamped === request.maxOutputTokens || clamped === undefined) return request;
  return { ...request, maxOutputTokens: clamped };
}

/**
 * The sentence a user reads when even the lowered ask was refused.
 *
 * The provider's own words are kept, because they are the only evidence of what it actually
 * wants — but they arrive wrapped in the one piece of context the raw 400 lacks: the number
 * Lyra asked for and where that number came from. A bare `max_tokens: 128000 > 64000` reads
 * as the user's mistake, and it never was one.
 */
function unrecoverableOutputCap(fault: ProviderFault, request: ProviderRequest): ProviderFault {
  return new ProviderFault({
    classification: fault.classification,
    providerMessage:
      `The provider refused this turn's output-token request of ${request.maxOutputTokens ?? "(unset)"} for ${request.model}`
      + ` and did not state a limit Lyra could retry with: ${fault.providerMessage}.`
      + ` Set the model's real output ceiling in its provider configuration.`,
    ...(fault.status === undefined ? {} : { status: fault.status }),
    ...(fault.code === undefined ? {} : { code: fault.code }),
    raw: fault.raw,
    cause: fault,
    ...(fault.url === undefined ? {} : { url: fault.url }),
  });
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

/** When the provider last proved it was alive: an event, or raw bytes on the socket. */
class StreamLiveness {
  #lastAt = Date.now();

  tick(): void {
    this.#lastAt = Date.now();
  }

  idleMs(): number {
    return Date.now() - this.#lastAt;
  }
}

interface ArmedDeadline {
  readonly expired: Promise<never>;
  dispose(): void;
}

/**
 * The §3.3 stall watchdog, in two phases.
 *
 * **Before the first output event there is no stall deadline at all.** A model that thinks
 * for five minutes before its first token — routine for a reasoning model, and invisible
 * through a proxy that does not stream thinking — is the workload, not a fault, and it is
 * indistinguishable from a hung server by any measurement short of waiting. The two failures
 * that phase could catch are already caught: a connection that never answers dies on the
 * headers deadline (§3.4, 30s), and a server that accepted the request and then went silent
 * forever is bounded by the total-turn deadline (§3.4, 30m). Cancelling at 45s instead
 * killed healthy turns, resent the whole context at full input cost, and started the
 * thinking over — sometimes on every attempt until the retry budget ran out.
 *
 * **After output has started, the tight inter-token deadline applies.** That is the real F2
 * signature: a stream that flowed and then died with the socket still open. Any liveness at
 * all resets it — an event, or bare bytes via {@link StreamLiveness}, since a proxy sending
 * `: ping` while the model thinks is proving the connection is alive.
 */
async function* withStallDeadline(
  source: AsyncIterable<TransportEvent>,
  timeoutMs: number,
  controller: AbortController,
  liveness: StreamLiveness,
): AsyncGenerator<TransportEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let streaming = false;
  while (true) {
    liveness.tick();
    const deadline = streaming ? armStallDeadline(timeoutMs, liveness, controller) : undefined;
    let next: IteratorResult<TransportEvent>;
    try {
      const pending = iterator.next();
      if (deadline === undefined) {
        next = await pending;
      } else {
        try {
          next = await Promise.race([pending, deadline.expired]);
        } catch (error) {
          // The abandoned read rejects once the attempt is aborted; it has no other reader.
          void pending.catch(() => undefined);
          throw error;
        }
      }
    } finally {
      deadline?.dispose();
    }
    if (next.done) return;
    // Usage and transport-fallback notices are bookkeeping, not the model's output, so they
    // do not arm the inter-token phase — the same test `produced` uses for an empty turn.
    if (isContentEvent(next.value)) streaming = true;
    yield next.value;
  }
}

function armStallDeadline(
  timeoutMs: number,
  liveness: StreamLiveness,
  controller: AbortController,
): ArmedDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const expired = new Promise<never>((_, reject) => {
    const schedule = (delayMs: number): void => {
      timer = setTimeout(() => {
        if (disposed) return;
        // Bytes may have arrived while this timer was pending. Silence is measured from the
        // last sign of life, so a keep-alive re-arms the deadline instead of being ignored.
        const idleMs = liveness.idleMs();
        if (idleMs < timeoutMs) {
          schedule(Math.max(1, timeoutMs - idleMs));
          return;
        }
        const fault = classifyProviderError({
          code: "stream_stalled",
          message: `Provider stream went silent for ${formatDuration(timeoutMs)} after output began`,
        });
        controller.abort(fault);
        reject(fault);
      }, delayMs);
    };
    schedule(timeoutMs);
  });
  return {
    expired,
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1_000) return `${Number((ms / 1_000).toFixed(3))}s`;
  return `${ms}ms`;
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
