import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import type { HttpTransportConfig } from "./auth.ts";
import { endpoint, providerHeaders } from "./auth.ts";
import { classifyProviderError } from "./errors.ts";
import { fetchWithHeadersDeadline, readJsonError } from "./sse.ts";

export interface ModelInfo {
  id: string;
  ownedBy?: string;
  contextWindow?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

interface ModelCache {
  fetchedAt: string;
  models: ModelInfo[];
}

export interface ModelDiscoveryOptions {
  cacheDirectory?: string;
  force?: boolean;
  maxAgeMs?: number;
  manual?: readonly ModelInfo[];
  signal?: AbortSignal;
  headersTimeoutMs?: number;
}

const KNOWN_MODELS: Readonly<Record<string, Partial<ModelInfo>>> = {
  "gpt-5.6": {
    contextWindow: 1_050_000,
    inputPricePerMillion: 5,
    outputPricePerMillion: 30,
  },
  "gpt-5.6-sol": {
    contextWindow: 1_050_000,
    inputPricePerMillion: 5,
    outputPricePerMillion: 30,
  },
  "gpt-5.6-terra": {
    contextWindow: 1_050_000,
    inputPricePerMillion: 2,
    outputPricePerMillion: 12,
  },
  "gpt-5.6-luna": {
    contextWindow: 1_050_000,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 1.2,
  },
  "gpt-5.4": {
    contextWindow: 1_050_000,
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 15,
  },
  "claude-opus-5": {
    contextWindow: 1_000_000,
    inputPricePerMillion: 5,
    outputPricePerMillion: 25,
  },
  "claude-haiku-4-5": {
    contextWindow: 200_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
  },
  "claude-haiku-4.5": {
    contextWindow: 200_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
  },
};

export async function discoverModels(
  config: HttpTransportConfig,
  options: ModelDiscoveryOptions = {},
): Promise<ModelInfo[]> {
  const cachePath = resolve(
    options.cacheDirectory ?? resolve(homedir(), ".lyra", "providers"),
    config.id,
    "models.json",
  );
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
  if (options.force !== true) {
    const cache = await readCache(cachePath);
    if (cache !== undefined && Date.now() - Date.parse(cache.fetchedAt) < maxAgeMs) {
      return cache.models.map(augmentModel);
    }
  }

  const signal = options.signal ?? new AbortController().signal;
  const modelsPath = config.authHeader === "x-api-key" && !config.baseUrl.endsWith("/v1")
    ? "v1/models"
    : "models";
  const response = await fetchWithHeadersDeadline(endpoint(config.baseUrl, modelsPath), {
    method: "GET",
    headers: await providerHeaders(config, signal),
    signal,
  }, options.headersTimeoutMs ?? 30_000);

  if (response.status === 404) return [...(options.manual ?? [])].map(augmentModel);
  if (!response.ok) {
    const body = await readJsonError(response);
    throw classifyProviderError({ status: response.status, headers: response.headers, body });
  }

  const body = await response.json() as unknown;
  const models = parseModels(body).map(augmentModel);
  await writeCache(cachePath, { fetchedAt: new Date().toISOString(), models });
  return models;
}

export async function cachedModels(
  providerId: string,
  cacheDirectory = resolve(homedir(), ".lyra", "providers"),
): Promise<ModelInfo[] | undefined> {
  return (await readCache(resolve(cacheDirectory, providerId, "models.json")))?.models;
}

export class ModelCatalog {
  readonly cacheDirectory: string;
  private readonly onRefreshError: (providerId: string, error: unknown) => void;

  constructor(options: {
    cacheDirectory?: string;
    onRefreshError?: (providerId: string, error: unknown) => void;
  } = {}) {
    this.cacheDirectory = options.cacheDirectory ?? resolve(homedir(), ".lyra", "providers");
    this.onRefreshError = options.onRefreshError ?? (() => undefined);
  }

  async list(config: HttpTransportConfig, manual: readonly ModelInfo[] = []): Promise<ModelInfo[]> {
    const cached = await cachedModels(config.id, this.cacheDirectory);
    if (cached === undefined) {
      return discoverModels(config, { cacheDirectory: this.cacheDirectory, manual });
    }
    void discoverModels(config, { cacheDirectory: this.cacheDirectory, manual }).catch((error: unknown) => {
      this.onRefreshError(config.id, error);
    });
    return cached.map(augmentModel);
  }

  async refresh(config: HttpTransportConfig, manual: readonly ModelInfo[] = []): Promise<ModelInfo[]> {
    return discoverModels(config, {
      cacheDirectory: this.cacheDirectory,
      manual,
      force: true,
    });
  }
}

function parseModels(body: unknown): ModelInfo[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw classifyProviderError({
      code: "invalid_models_response",
      message: "Provider /models response must contain a data array",
      body,
    });
  }
  const result: ModelInfo[] = [];
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const reportedContext = typeof item.max_input_tokens === "number"
      ? item.max_input_tokens
      : undefined;
    result.push({
      id: item.id,
      ...(typeof item.owned_by === "string" ? { ownedBy: item.owned_by } : {}),
      ...(reportedContext === undefined ? {} : { contextWindow: reportedContext }),
    });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function augmentModel(model: ModelInfo): ModelInfo {
  const exact = KNOWN_MODELS[model.id];
  const family = exact ?? Object.entries(KNOWN_MODELS).find(([id]) => model.id.startsWith(id))?.[1];
  return family === undefined ? model : { ...family, ...model };
}

async function readCache(path: string): Promise<ModelCache | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    const value = await file.json() as unknown;
    if (!isRecord(value) || typeof value.fetchedAt !== "string" || !Array.isArray(value.models)) {
      return undefined;
    }
    const models = value.models.filter(isModelInfo);
    return { fetchedAt: value.fetchedAt, models };
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, cache: ModelCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(cache)}\n`);
  await rename(temporary, path);
}

function isModelInfo(value: unknown): value is ModelInfo {
  return isRecord(value) && typeof value.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
