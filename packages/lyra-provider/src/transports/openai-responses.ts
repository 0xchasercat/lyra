import {
  endpoint,
  providerHeaders,
  type HttpTransportConfig,
} from "../auth.ts";
import { classifyProviderError, type ProviderFault } from "../errors.ts";
import {
  buildResponsesRequest,
  isResponseRecord,
  ResponsesChainState,
  ResponsesStreamDecoder,
  type PreparedResponseInput,
  type ResponseItem,
} from "../responses-codec.ts";
import {
  fetchWithHeadersDeadline,
  parseSse,
  readJsonError,
} from "../sse.ts";
import type {
  ProviderEvent,
  ProviderRequest,
  ProviderTransport,
  TransportContext,
} from "../types.ts";

export interface OpenAIResponsesTransportConfig extends HttpTransportConfig {
  responsesPath?: string;
  compactPath?: string;
  compactThreshold?: number;
  contextManagement?: readonly Readonly<Record<string, unknown>>[];
  serverCompaction?:
    | false
    | {
        mode?: "automatic" | "standalone";
        compactThreshold?: number;
      };
}

export class OpenAIResponsesTransport implements ProviderTransport {
  readonly apiType = "openai_responses" as const;
  readonly id: string;

  private readonly config: OpenAIResponsesTransportConfig;
  private readonly chain = new ResponsesChainState();
  private inFlight = false;

  constructor(config: OpenAIResponsesTransportConfig) {
    this.config = config;
    this.id = config.id;
  }

  async *stream(
    request: ProviderRequest,
    context: TransportContext,
  ): AsyncGenerator<ProviderEvent> {
    this.beginTurn();
    try {
      let prepared = this.chain.prepare(request);
      let recovered = false;
      while (true) {
        const decoder = new ResponsesStreamDecoder();
        try {
          for await (const event of this.streamAttempt(request, context, prepared, decoder, true)) {
            yield event;
          }
          this.chain.commit(request, prepared, decoder.responseId, decoder.output);
          return;
        } catch (cause) {
          const fault = asProviderFault(cause);
          this.chain.break();
          if (!recovered && prepared.incremental && fault.code === "previous_response_not_found") {
            recovered = true;
            prepared = this.chain.recovery(request);
            continue;
          }
          throw fault;
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  async warmup(request: ProviderRequest, context: TransportContext): Promise<void> {
    this.beginTurn();
    try {
      let prepared = this.chain.prepare(request);
      let recovered = false;
      while (true) {
        const decoder = new ResponsesStreamDecoder();
        try {
          for await (const _event of this.streamAttempt(request, context, prepared, decoder, false)) {
            // Warmup has no model output; terminal events are consumed only to establish the chain.
          }
          this.chain.commit(request, prepared, decoder.responseId, decoder.output);
          return;
        } catch (cause) {
          const fault = asProviderFault(cause);
          this.chain.break();
          if (!recovered && prepared.incremental && fault.code === "previous_response_not_found") {
            recovered = true;
            prepared = this.chain.recovery(request);
            continue;
          }
          throw fault;
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  async compact(
    request: ProviderRequest,
    context: TransportContext,
  ): Promise<readonly ResponseItem[]> {
    this.beginTurn();
    try {
      const prepared = this.chain.recovery(request);
      const headers = await providerHeaders(this.config, context.signal);
      const response = await fetchWithHeadersDeadline(
        endpoint(this.config.baseUrl, this.config.compactPath ?? "responses/compact"),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: request.model,
            instructions: request.system,
            input: prepared.fullInput,
          }),
          signal: context.signal,
        },
        context.headersTimeoutMs,
      );
      if (!response.ok) {
        const body = await readJsonError(response);
        throw classifyProviderError({ status: response.status, body, headers: response.headers });
      }

      const body = await readJsonError(response);
      if (!isResponseRecord(body) || !Array.isArray(body.output) || !body.output.every(isResponseRecord)) {
        throw classifyProviderError({
          code: "malformed_completion",
          message: "The Responses compact endpoint returned an invalid output window",
          body,
        });
      }
      const output: readonly ResponseItem[] = body.output;
      this.chain.stageCompacted(request, output);
      return output;
    } catch (cause) {
      this.chain.break();
      throw asProviderFault(cause);
    } finally {
      this.inFlight = false;
    }
  }

  private async *streamAttempt(
    request: ProviderRequest,
    context: TransportContext,
    prepared: PreparedResponseInput,
    decoder: ResponsesStreamDecoder,
    generate: boolean,
  ): AsyncGenerator<ProviderEvent> {
    const headers = await providerHeaders(this.config, context.signal);
    headers.set("accept", "text/event-stream");
    const contextManagement = this.contextManagement();
    const response = await fetchWithHeadersDeadline(
      endpoint(this.config.baseUrl, this.config.responsesPath ?? "responses"),
      {
        method: "POST",
        headers,
        body: JSON.stringify(buildResponsesRequest(request, {
          stream: true,
          ...(!generate ? { generate: false } : {}),
          input: prepared.input,
          previousResponseId: prepared.previousResponseId,
          ...(contextManagement === undefined ? {} : { contextManagement }),
        })),
        signal: context.signal,
      },
      context.headersTimeoutMs,
    );

    if (!response.ok) {
      const body = await readJsonError(response);
      throw classifyProviderError({ status: response.status, body, headers: response.headers });
    }
    if (response.body === null) {
      throw classifyProviderError({
        code: "stream_truncated",
        message: "The Responses endpoint returned an empty stream",
      });
    }

    for await (const sse of parseSse(response.body, context.signal)) {
      if (sse.data === "[DONE]") break;
      let value: unknown;
      try {
        value = JSON.parse(sse.data) as unknown;
      } catch (cause) {
        throw classifyProviderError({
          code: "malformed_completion",
          message: "The Responses endpoint returned malformed SSE JSON",
          body: { event: sse.event, data: sse.data },
          cause,
        });
      }
      if (sse.event === "error" && isResponseRecord(value) && value.type === undefined) {
        value = { ...value, type: "error" };
      }
      for (const event of decoder.consume(value)) yield event;
    }

    if (!decoder.completed) {
      throw classifyProviderError({
        code: "stream_truncated",
        message: "The Responses stream ended before a terminal event",
      });
    }
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
  async close(): Promise<void> {
    this.chain.break();
  }


  private beginTurn(): void {
    if (this.inFlight) {
      throw classifyProviderError({
        code: "invalid_role_sequence",
        message: "This Responses transport already has an in-flight turn",
      });
    }
    this.inFlight = true;
  }
}

function asProviderFault(cause: unknown): ProviderFault {
  return classifyProviderError({ cause });
}
