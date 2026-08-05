import type { AuthSource, AuthToken } from "./auth.ts";
import { authenticationFault } from "./auth.ts";

export interface CredentialCommandResult { exitCode: number; stdout: string; stderr: string; }
export type CredentialRunner = (command: string, args: readonly string[], input?: string, signal?: AbortSignal) => Promise<CredentialCommandResult>;
export interface KeychainCredential { service: string; account: string; }
export interface KeychainOptions extends KeychainCredential { platform?: NodeJS.Platform; run?: CredentialRunner; }

export class KeychainAuth implements AuthSource {
  readonly service: string;
  readonly account: string;
  readonly #platform: NodeJS.Platform;
  readonly #run: CredentialRunner;
  constructor(options: KeychainOptions) {
    validateCredential(options);
    this.service = options.service;
    this.account = options.account;
    this.#platform = options.platform ?? process.platform;
    this.#run = options.run ?? runCredentialCommand;
  }
  async getToken(signal?: AbortSignal): Promise<AuthToken> {
    const command = lookupCommand(this.#platform, this.service, this.account);
    const result = await this.#run(command.command, command.args, undefined, signal);
    const token = result.stdout.trim();
    if (result.exitCode !== 0 || token.length === 0) throw authenticationFault(`No keychain credential is available for ${this.service}/${this.account}: ${result.stderr.trim() || "credential lookup failed"}`);
    return { token };
  }
}

export async function storeKeychainCredential(credential: KeychainCredential, token: string, options: { platform?: NodeJS.Platform; run?: CredentialRunner; signal?: AbortSignal } = {}): Promise<void> {
  validateCredential(credential);
  if (typeof token !== "string" || token.length === 0) throw new TypeError("Keychain token must be non-empty.");
  const platform = options.platform ?? process.platform;
  const command = storeCommand(platform, credential.service, credential.account, token);
  const result = await (options.run ?? runCredentialCommand)(command.command, command.args, command.input, options.signal);
  if (result.exitCode !== 0) throw authenticationFault(`Could not store ${credential.service}/${credential.account} in the OS keychain: ${result.stderr.trim() || "credential store failed"}`);
}

export function supportsOsKeychain(platform: NodeJS.Platform = process.platform): boolean { return platform === "darwin" || (platform === "linux" && Bun.which("secret-tool") !== null); }

function lookupCommand(platform: NodeJS.Platform, service: string, account: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "/usr/bin/security", args: ["find-generic-password", "-w", "-s", service, "-a", account] };
  if (platform === "linux") { const command = Bun.which("secret-tool"); if (command) return { command, args: ["lookup", "service", service, "account", account] }; }
  throw authenticationFault(`OS keychain integration is unavailable on ${platform}; use environment or static auth.`);
}
function storeCommand(platform: NodeJS.Platform, service: string, account: string, token: string): { command: string; args: string[]; input?: string } {
  if (platform === "darwin") return { command: "/usr/bin/security", args: ["add-generic-password", "-U", "-s", service, "-a", account, "-w", token] };
  if (platform === "linux") { const command = Bun.which("secret-tool"); if (command) return { command, args: ["store", "--label", `Lyra ${account}`, "service", service, "account", account], input: token }; }
  throw authenticationFault(`OS keychain integration is unavailable on ${platform}; use environment or static auth.`);
}
function validateCredential(value: KeychainCredential): void { if (!value || typeof value.service !== "string" || value.service.length === 0 || typeof value.account !== "string" || value.account.length === 0) throw new TypeError("Keychain service and account are required."); }
async function runCredentialCommand(command: string, args: readonly string[], input?: string, signal?: AbortSignal): Promise<CredentialCommandResult> {
  if (signal?.aborted) throw signal.reason;
  const child = Bun.spawn([command, ...args], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" }, detached: true });
  const abort = (): void => { if (typeof child.pid === "number" && child.pid > 1) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } try { child.kill("SIGTERM"); } catch {} };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (input !== undefined && child.stdin !== undefined && typeof child.stdin !== "number") { child.stdin.write(input); child.stdin.end(); }
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (signal?.aborted) throw signal.reason;
    return { stdout, stderr, exitCode };
  } finally { signal?.removeEventListener("abort", abort); }
}
