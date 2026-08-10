import {
  providerHeaders,
  providerSystemPrefix,
  type HttpTransportConfig,
} from "../auth.ts";
import type { WebSocketPreference } from "../config.ts";
import { resolvedProviderEndpoint } from "../endpoints.ts";
import { classifyProviderError, ProviderFault } from "../errors.ts";
import {
  buildResponsesRequest,
  ResponsesChainState,
  ResponsesStreamDecoder,
  type PreparedResponseInput,
} from "../responses-codec.ts";
import type {
  ProviderEvent,
  ProviderRequest,
  ProviderTransport,
  TransportContext,
  TransportEvent,
  TransportFallbackEvent,
} from "../types.ts";
import {
  OpenAIResponsesTransport,
  type OpenAIResponsesTransportConfig,
} from "./openai-responses.ts";

const DEFAULT_MAX_CONNECTION_AGE_MS = 55 * 60 * 1_000;
const OPEN = 1;

export interface OpenAIWebSocketTransportConfig extends OpenAIResponsesTransportConfig {
  /**
   * The configured preference this transport was built from. `"on"` is a demand — a fallback
   * out of it is news. `"auto"` (the default) is a probe, and its fallback is routine.
   */
  websocket?: WebSocketPreference;
  websocketUrl?: string;
  websocketPath?: string;
  maxConnectionAgeMs?: number;
  maxConnectionFailures?: number;
  maxReplayAttempts?: number;
  now?: () => number;
  websocketFactory?: (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
}

export class OpenAIWebSocketTransport implements ProviderTransport {
  readonly apiType = "openai_websocket" as const;
  readonly id: string;

  private readonly config: OpenAIWebSocketTransportConfig;
  private readonly http: OpenAIResponsesTransport;
  // The socket owns the chained window: the service's cache is connection-local (§5.3), so a
  // slice that references a tool call only the server holds is safe here and nowhere else.
  // `this.http` keeps its own, non-stateful chain for the fallback path.
  private readonly chain = new ResponsesChainState({ stateful: true });
  private readonly now: () => number;
  private readonly maxConnectionAgeMs: number;
  private readonly maxConnectionFailures: number;
  private readonly maxReplayAttempts: number;

  private socket: WebSocket | undefined;
  private connectedAt = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private inbox: SocketInbox | undefined;
  private inFlight = false;
  private closed = false;
  private connectionFailures = 0;
  private fallback = false;
  private fallbackReason = "WebSocket connection unavailable";
  private fallbackAnnounced = false;

  constructor(config: OpenAIWebSocketTransportConfig) {
    this.config = config;
    this.id = config.id;
    this.http = new OpenAIResponsesTransport(config);
    this.now = config.now ?? Date.now;
    this.maxConnectionAgeMs = config.maxConnectionAgeMs ?? DEFAULT_MAX_CONNECTION_AGE_MS;
    this.maxConnectionFailures = Math.max(1, config.maxConnectionFailures ?? 2);
    this.maxReplayAttempts = Math.max(0, config.maxReplayAttempts ?? 1);
  }

  async *stream(
    request: ProviderRequest,
    context: TransportContext,
  ): AsyncGenerator<TransportEvent> {
    this.beginTurn();
    try {
      if (!this.fallback && this.connectionFailures >= this.maxConnectionFailures) {
        this.activateFallback(this.fallbackReason);
      }
      if (this.fallback) {
        const notice = this.takeFallbackNotice();
        if (notice !== undefined) yield notice;
        yield* this.http.stream(request, context);
        return;
      }

      this.retireExpiredConnection();
      let prepared = this.chain.prepare(request);
      let replayAttempts = 0;
      let recoveredMissingChain = false;
      let emittedAny = false;

      while (true) {
        const decoder = new ResponsesStreamDecoder({ input: prepared.input });
        try {
          for await (const event of this.socketAttempt(request, context, prepared, decoder, true)) {
            emittedAny = true;
            yield event;
          }
          this.chain.commit(request, prepared, decoder.responseId, decoder.output);
          this.connectionFailures = 0;
          return;
        } catch (cause) {
          if (context.signal.aborted) throw context.signal.reason;
          this.chain.break();

          if (cause instanceof ProviderFault && cause.code === "previous_response_not_found") {
            // Replaying silently on top of text a client has already rendered would show it
            // twice; once anything has been emitted the fault is surfaced instead.
            if (recoveredMissingChain || emittedAny) throw cause;
            recoveredMissingChain = true;
            prepared = this.chain.recovery(request);
            continue;
          }

          const connectionLimit = cause instanceof ProviderFault &&
            cause.code === "websocket_connection_limit_reached";
          if (cause instanceof UnexpectedWebSocketClose || connectionLimit) {
            this.connectionFailures += 1;
            this.fallbackReason = providerMessage(cause);
            this.disconnect();
            if (emittedAny) throw interruptedFault(cause);
            if (this.connectionFailures >= this.maxConnectionFailures) {
              this.activateFallback(providerMessage(cause));
              const notice = this.takeFallbackNotice();
              if (notice !== undefined) yield notice;
              yield* this.http.stream(request, context);
              return;
            }
            if (replayAttempts < this.maxReplayAttempts) {
              replayAttempts += 1;
              prepared = this.chain.recovery(request);
              continue;
            }
            throw asProviderFault(cause);
          }

          if (cause instanceof WebSocketConnectionError) {
            this.connectionFailures += 1;
            this.disconnect();
            if (this.connectionFailures < this.maxConnectionFailures) {
              prepared = this.chain.recovery(request);
              continue;
            }
            this.activateFallback(cause.message);
            const notice = this.takeFallbackNotice();
            if (notice !== undefined) yield notice;
            yield* this.http.stream(request, context);
            return;
          }

          throw asProviderFault(cause);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  async warmup(request: ProviderRequest, context: TransportContext): Promise<void> {
    this.beginTurn();
    try {
      if (!this.fallback && this.connectionFailures >= this.maxConnectionFailures) {
        this.activateFallback(this.fallbackReason);
      }
      if (this.fallback) {
        await this.http.warmup(request, context);
        return;
      }

      this.retireExpiredConnection();
      let prepared = this.chain.prepare(request);
      let replayAttempts = 0;
      let recoveredMissingChain = false;
      while (true) {
        const decoder = new ResponsesStreamDecoder({ input: prepared.input });
        try {
          for await (const _event of this.socketAttempt(request, context, prepared, decoder, false)) {
            // Warmup events only establish the response ID used by the next generated turn.
          }
          this.chain.commit(request, prepared, decoder.responseId, decoder.output);
          this.connectionFailures = 0;
          return;
        } catch (cause) {
          if (context.signal.aborted) throw context.signal.reason;
          this.chain.break();
          if (cause instanceof ProviderFault && cause.code === "previous_response_not_found") {
            if (recoveredMissingChain) throw cause;
            recoveredMissingChain = true;
            prepared = this.chain.recovery(request);
            continue;
          }
          const connectionLimit = cause instanceof ProviderFault &&
            cause.code === "websocket_connection_limit_reached";
          if (cause instanceof UnexpectedWebSocketClose || connectionLimit) {
            this.connectionFailures += 1;
            this.disconnect();
            if (replayAttempts < this.maxReplayAttempts) {
              replayAttempts += 1;
              prepared = this.chain.recovery(request);
              continue;
            }
          } else if (cause instanceof WebSocketConnectionError) {
            this.connectionFailures += 1;
            this.disconnect();
            if (this.connectionFailures < this.maxConnectionFailures) {
              prepared = this.chain.recovery(request);
              continue;
            }
          } else {
            throw asProviderFault(cause);
          }

          if (this.connectionFailures >= this.maxConnectionFailures) {
            this.activateFallback(providerMessage(cause));
            await this.http.warmup(request, context);
            return;
          }
          throw asProviderFault(cause);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.chain.break();
    this.disconnect();
    await this.http.close?.();
  }

  private async *socketAttempt(
    request: ProviderRequest,
    context: TransportContext,
    prepared: PreparedResponseInput,
    decoder: ResponsesStreamDecoder,
    generate: boolean,
  ): AsyncGenerator<ProviderEvent> {
    await this.connect(context);
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== OPEN) {
      throw new WebSocketConnectionError("The Responses WebSocket did not remain open");
    }

    const inbox = new SocketInbox();
    this.inbox = inbox;
    const contextManagement = this.contextManagement();
    const systemPrefix = await providerSystemPrefix(this.config, context.signal);
    const payload = buildResponsesRequest(request, {
      stream: false,
      ...(!generate ? { generate: false } : {}),
      input: prepared.input,
      previousResponseId: prepared.previousResponseId,
      ...(contextManagement === undefined ? {} : { contextManagement }),
      ...(systemPrefix === undefined ? {} : { systemPrefix }),
    });
    delete payload.stream;
    socket.send(JSON.stringify({ type: "response.create", ...payload }));

    try {
      while (true) {
        const data = await inbox.next(context.signal);
        // Every frame is liveness, whether or not the decoder makes an event of it: the
        // socket's own keep-alives and progress frames are how a thinking model proves the
        // connection is alive (§3.3).
        context.onLiveness?.();
        const value = await decodeSocketData(data);
        let event: unknown;
        try {
          event = JSON.parse(value) as unknown;
        } catch (cause) {
          throw classifyProviderError({
            code: "malformed_completion",
            message: "The Responses WebSocket returned malformed JSON",
            body: { data: value },
            cause,
          });
        }
        for (const providerEvent of decoder.consume(event)) yield providerEvent;
        if (decoder.completed) return;
      }
    } finally {
      if (this.inbox === inbox) this.inbox = undefined;
      if (context.signal.aborted) {
        this.chain.break();
        this.disconnect();
      }
    }
  }


  private async connect(context: TransportContext): Promise<void> {
    if (this.closed) {
      throw new WebSocketConnectionError("This Responses WebSocket transport is closed");
    }
    if (this.socket?.readyState === OPEN) return;

    const headers = await providerHeaders(this.config, context.signal);
    const websocketOptions = { headers: Object.fromEntries(headers.entries()) };
    const socket = this.config.websocketFactory === undefined
      ? createWebSocket(websocketEndpoint(this.config), websocketOptions)
      : this.config.websocketFactory(websocketEndpoint(this.config), websocketOptions);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new WebSocketConnectionError(
          `Provider WebSocket headers timed out after ${context.headersTimeoutMs}ms`,
        ));
      }, context.headersTimeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onInitialError);
      };
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        tryClose(socket);
        reject(cause);
      };
      const onOpen = (): void => {
        if (settled) return;
        if (this.socket !== socket) {
          fail(new WebSocketConnectionError("The Responses WebSocket connection was replaced"));
          return;
        }
        settled = true;
        cleanup();
        this.connectedAt = this.now();
        this.armExpiry(socket);
        resolve();
      };
      const onAbort = (): void => fail(context.signal.reason);
      const onInitialError = (): void => {
        fail(new WebSocketConnectionError("The provider rejected the Responses WebSocket connection"));
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onInitialError);
      socket.addEventListener("message", (event) => {
        if (this.socket === socket) this.inbox?.push(event.data);
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.clearExpiry();
        this.chain.break();
        const closeError = new UnexpectedWebSocketClose(event.code, event.reason);
        if (!settled) fail(new WebSocketConnectionError(closeError.message));
        else this.inbox?.fail(closeError);
      });
      context.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private contextManagement(): readonly Readonly<Record<string, unknown>>[] | undefined {
    if (this.config.serverCompaction === false) return undefined;
    if (this.config.contextManagement !== undefined) return this.config.contextManagement;
    if (this.config.serverCompaction?.mode === "standalone") return undefined;
    const threshold = this.config.serverCompaction?.compactThreshold ?? this.config.compactThreshold;
    return threshold === undefined
      ? undefined
      : [{ type: "compaction", compact_threshold: threshold }];
  }

  private retireExpiredConnection(): void {
    if (
      this.socket !== undefined &&
      this.now() - this.connectedAt >= this.maxConnectionAgeMs
    ) {
      this.chain.break();
      this.disconnect();
    }
  }

  private armExpiry(socket: WebSocket): void {
    this.clearExpiry();
    this.expiryTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      this.chain.break();
      this.disconnect();
    }, this.maxConnectionAgeMs);
  }


  private activateFallback(reason: string): void {
    this.fallback = true;
    this.fallbackReason = reason;
    this.chain.break();
    this.disconnect();
  }

  /**
   * The one notice a session gets, if it gets one at all.
   *
   * Announced once per transport — the decision to fall back is remembered for the whole
   * session, so a client never sees the same sentence twice, and no later turn re-probes a
   * socket that is already known not to be there.
   */
  private takeFallbackNotice(): TransportFallbackEvent | undefined {
    if (!this.fallback || this.fallbackAnnounced) return undefined;
    this.fallbackAnnounced = true;
    return {
      type: "transport_fallback",
      from: "openai_websocket",
      to: "openai_responses",
      reason: this.fallbackReason,
      resetsPartialOutput: true,
      expected: this.config.websocket !== "on",
    };
  }

  private disconnect(): void {
    this.clearExpiry();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) tryClose(socket);
    this.inbox?.fail(new UnexpectedWebSocketClose(1000, "Connection replaced"));
    this.inbox = undefined;
    this.connectedAt = 0;
  }

  private clearExpiry(): void {
    if (this.expiryTimer === undefined) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private beginTurn(): void {
    if (this.inFlight) {
      throw classifyProviderError({
        code: "invalid_role_sequence",
        message: "This WebSocket transport already has an in-flight turn",
      });
    }
    if (this.closed) {
      throw classifyProviderError({
        code: "connection_reset",
        message: "This WebSocket transport is closed",
      });
    }
    this.inFlight = true;
  }
}

class SocketInbox {
  private readonly values: unknown[] = [];
  private waiter:
    | { resolve: (value: unknown) => void; reject: (cause: unknown) => void }
    | undefined;
  private failure: unknown;
  private failed = false;

  push(value: unknown): void {
    if (this.failed) return;
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.values.push(value);
      return;
    }
    this.waiter = undefined;
    waiter.resolve(value);
  }

  fail(cause: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = cause;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter.reject(cause);
    }
  }

  async next(signal: AbortSignal): Promise<unknown> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.failed) throw this.failure;
    if (signal.aborted) throw signal.reason;

    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.waiter === undefined) return;
        this.waiter = undefined;
        reject(signal.reason);
      };
      this.waiter = {
        resolve: (next) => {
          signal.removeEventListener("abort", onAbort);
          resolve(next);
        },
        reject: (cause) => {
          signal.removeEventListener("abort", onAbort);
          reject(cause);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

class WebSocketConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSocketConnectionError";
  }
}

class UnexpectedWebSocketClose extends Error {
  readonly code: number;

  constructor(code: number, reason: string) {
    super(reason.length === 0
      ? `Responses WebSocket closed unexpectedly (${code})`
      : `Responses WebSocket closed unexpectedly (${code}): ${reason}`);
    this.name = "UnexpectedWebSocketClose";
    this.code = code;
  }
}

/**
 * Where the socket connects: the same route resolution the HTTP transports use, including
 * any base-URL shape a 404 already taught this provider — a socket that reconnected to the
 * unhealed shape would fail for a reason the fallback could never explain.
 */
function websocketEndpoint(config: OpenAIWebSocketTransportConfig): string {
  if (config.websocketUrl !== undefined) return config.websocketUrl;
  const url = new URL(resolvedProviderEndpoint(config, config.websocketPath ?? "responses"));
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw classifyProviderError({
      code: "bad_request",
      message: `Unsupported WebSocket base URL protocol ${url.protocol}`,
    });
  }
  return url.toString();
}

async function decodeSocketData(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (data instanceof Blob) return await data.text();
  throw classifyProviderError({
    code: "malformed_completion",
    message: "The Responses WebSocket returned an unsupported message frame",
    body: data,
  });
}

function createWebSocket(
  url: string,
  options: { headers: Record<string, string> },
): WebSocket {
  const WebSocketWithOptions = WebSocket as unknown as {
    new (target: string, init: Bun.WebSocketOptions): WebSocket;
  };
  return new WebSocketWithOptions(url, options);
}

function tryClose(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    // The socket is already closed.
  }
}


function providerMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Responses WebSocket connection failed";
}

function asProviderFault(cause: unknown): ProviderFault {
  if (cause instanceof UnexpectedWebSocketClose || cause instanceof WebSocketConnectionError) {
    return classifyProviderError({ code: "connection_reset", message: cause.message, cause });
  }
  return classifyProviderError({ cause });
}

function interruptedFault(cause: unknown): ProviderFault {
  return classifyProviderError({
    code: "connection_reset",
    message: providerMessage(cause),
    cause,
  });
}
