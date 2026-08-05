export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fields: string[] = [];

  const consumeLine = (line: string): SseEvent | undefined => {
    if (line.length === 0) {
      const event = buildEvent(fields);
      fields = [];
      return event;
    }
    if (!line.startsWith(":")) fields.push(line);
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) buffer += decoder.decode();
      else buffer += decoder.decode(value, { stream: true });

      const split = splitLines(buffer, done);
      buffer = split.rest;
      for (const line of split.lines) {
        const event = consumeLine(line);
        if (event !== undefined) yield event;
      }
      if (done) break;
    }

    if (buffer.length > 0) {
      const event = consumeLine(buffer);
      if (event !== undefined) yield event;
    }
    const final = buildEvent(fields);
    if (final !== undefined) yield final;
  } finally {
    reader.releaseLock();
  }
}

type DefaultReaderResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<DefaultReaderResult> {
  if (signal === undefined) return reader.read();
  if (signal.aborted) {
    await reader.cancel(signal.reason);
    throw signal.reason;
  }

  return new Promise((resolve, reject) => {
    const aborted = () => {
      void reader.cancel(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

function splitLines(buffer: string, atEof: boolean): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character !== "\r" && character !== "\n") continue;
    if (character === "\r" && index + 1 === buffer.length && !atEof) break;
    lines.push(buffer.slice(start, index));
    if (character === "\r" && buffer[index + 1] === "\n") index += 1;
    start = index + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

function buildEvent(lines: readonly string[]): SseEvent | undefined {
  if (lines.length === 0) return undefined;
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];

  for (const line of lines) {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^[0-9]+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) retry = parsed;
    }
  }

  if (data.length === 0) return undefined;
  return {
    data: data.join("\n"),
    ...(event === undefined ? {} : { event }),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

export async function fetchWithHeadersDeadline(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException(`Provider headers timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  const signal = init.signal === undefined || init.signal === null
    ? deadline.signal
    : AbortSignal.any([init.signal, deadline.signal]);
  try {
    return await fetch(input, { ...init, signal });
  } catch (cause) {
    if (deadline.signal.aborted && !(init.signal?.aborted ?? false)) throw deadline.signal.reason;
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonError(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}
