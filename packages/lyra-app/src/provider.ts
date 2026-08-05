import { createProviderTransport, loadProviderConfig, ReliableProvider, resolveProvider, resolveModelRole } from "@lyra/provider";
import type { ProviderFileConfig } from "@lyra/provider";

export interface EnvironmentProviderOptions { configPath?: string; configPaths?: readonly string[]; model?: string; maxAttempts?: number; streamStallTimeoutMs?: number; turnTimeoutMs?: number; }
export interface EnvironmentProvider { provider: ReliableProvider; providerName: string; model: string; config: ProviderFileConfig; }

export async function createEnvironmentProvider(options: EnvironmentProviderOptions = {}): Promise<EnvironmentProvider> {
  const config = await loadProviderConfig(options.configPaths ?? options.configPath);
  return createConfiguredProvider(config, options);
}

export function createConfiguredProvider(config: ProviderFileConfig, options: Omit<EnvironmentProviderOptions, "configPath" | "configPaths"> = {}): EnvironmentProvider {
  if (options.model === undefined && config.roles.default === undefined) throw new Error("No default provider is configured. Run `lyra` in an interactive terminal for setup, export OPENAI_API_KEY or ANTHROPIC_API_KEY, or add a provider and [roles].default to Lyra TOML.");
  const reference = resolveModelRole(options.model ?? "@default", config.roles);
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) throw new Error(`Model ${reference} must use provider/model form.`);
  const providerName = reference.slice(0, separator);
  const model = reference.slice(separator + 1);
  const definition = config.providers[providerName];
  if (!definition) throw new Error(`Provider ${providerName} is not configured. Set its API key or add [providers.${providerName}] to Lyra TOML.`);
  const transport = createProviderTransport(resolveProvider(providerName, definition));
  const provider = new ReliableProvider(transport, { ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }), ...(options.streamStallTimeoutMs === undefined ? {} : { streamStallTimeoutMs: options.streamStallTimeoutMs }), ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }) });
  return { provider, providerName, model, config };
}
