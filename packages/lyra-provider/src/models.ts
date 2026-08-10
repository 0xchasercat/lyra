import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import type { HttpTransportConfig } from "./auth.ts";
import { providerHeaders } from "./auth.ts";
import { fetchProviderRoute } from "./endpoints.ts";
import { classifyProviderError } from "./errors.ts";
import { readJsonError } from "./sse.ts";

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

/** Reasoning-class families that rejected the deprecated Chat Completions max_tokens. */
const MAX_COMPLETION_TOKENS_FAMILIES = ["o1", "o3", "o4", "gpt-5"] as const;

/**
 * Chat Completions replaced `max_tokens` with `max_completion_tokens`, and
 * reasoning-class models reject the old name outright. Everything else —
 * including OpenAI-compatible servers that never learned the new name — still
 * needs `max_tokens`, so the two cannot be sent together.
 */
export function usesMaxCompletionTokens(modelId: string): boolean {
  const id = modelId.toLowerCase().split("/").at(-1) ?? modelId.toLowerCase();
  return MAX_COMPLETION_TOKENS_FAMILIES.some((family) =>
    id === family || id.startsWith(`${family}-`) || id.startsWith(`${family}.`)
  );
}

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
  // `{base}/models` for every api_type, through the one shared resolver — the family-specific
  // guess this used to make ("append /v1 when the base does not end in it, but only for
  // x-api-key providers") is exactly the divergence that let discovery succeed against a base
  // the message endpoint could not use.
  const { response, url } = await fetchProviderRoute(config, "models", {
    method: "GET",
    headers: await providerHeaders(config, signal),
    signal,
  }, options.headersTimeoutMs ?? 30_000);

  if (response.status === 404) return [...(options.manual ?? [])].map(augmentModel);
  if (!response.ok) {
    const body = await readJsonError(response);
    throw classifyProviderError({ status: response.status, headers: response.headers, body, url });
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

/**
 * The models an endpoint listed, plus the ones a provider declares that it did not.
 *
 * `discoverModels` folds `manual` in only when the endpoint has no `/models` route at all
 * (a 404), because that is the case where the declaration is the *whole* answer. A provider
 * that both discovers and declares — an endpoint that lists a subset, or one a user extended
 * with `/model add` — needs the union, and needs the declared ids to pick up the same
 * pricing and context-window facts a discovered id would.
 */
export function mergeModelLists(
  discovered: readonly ModelInfo[],
  declared: readonly ModelInfo[],
): ModelInfo[] {
  const seen = new Set(discovered.map((model) => model.id));
  return [...discovered, ...declared.filter((model) => !seen.has(model.id))]
    .map(augmentModel)
    .sort((left, right) => left.id.localeCompare(right.id));
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
  const family = KNOWN_MODELS[model.id] ?? longestKnownPrefix(model.id);
  return family === undefined ? model : { ...family, ...model };
}

/**
 * The most specific family wins: gpt-5.6-luna-x is a luna, not a plain gpt-5.6,
 * and the two carry different pricing.
 */
function longestKnownPrefix(id: string): Partial<ModelInfo> | undefined {
  let bestLength = 0;
  let best: Partial<ModelInfo> | undefined;
  for (const [prefix, info] of Object.entries(KNOWN_MODELS)) {
    if (prefix.length <= bestLength || !id.startsWith(prefix)) continue;
    bestLength = prefix.length;
    best = info;
  }
  return best;
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
