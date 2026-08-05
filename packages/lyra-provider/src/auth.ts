import { ProviderFault } from "./errors.ts";

export interface AuthToken {
  token: string;
  expiresAt?: string;
}

export interface AuthSource {
  getToken(signal?: AbortSignal): Promise<AuthToken | undefined>;
  invalidate?(): void;
}

export class EnvironmentAuth implements AuthSource {
  readonly variable: string;

  constructor(variable: string) {
    this.variable = variable;
  }

  async getToken(): Promise<AuthToken> {
    const token = Bun.env[this.variable];
    if (token === undefined || token.length === 0) {
      throw authenticationFault(`Authentication variable ${this.variable} is not set`);
    }
    return { token };
  }
}

export class StaticAuth implements AuthSource {
  constructor(private readonly token: string) {}

  async getToken(): Promise<AuthToken> {
    return { token: this.token };
  }
}

export class NoAuth implements AuthSource {
  async getToken(): Promise<undefined> {
    return undefined;
  }
}

export interface HttpTransportConfig {
  id: string;
  baseUrl: string;
  auth?: AuthSource;
  headers?: Readonly<Record<string, string>>;
  authHeader?: "bearer" | "x-api-key";
}

export async function providerHeaders(
  config: HttpTransportConfig,
  signal?: AbortSignal,
): Promise<Headers> {
  const headers = new Headers(config.headers);
  headers.set("content-type", "application/json");
  const token = await config.auth?.getToken(signal);
  if (token !== undefined) {
    if (config.authHeader === "x-api-key") headers.set("x-api-key", token.token);
    else headers.set("authorization", `Bearer ${token.token}`);
  }
  return headers;
}

export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export function authenticationFault(message: string, cause?: unknown): ProviderFault {
  return new ProviderFault({
    classification: "auth",
    providerMessage: message,
    code: "auth_source_error",
    ...(cause === undefined ? {} : { cause }),
  });
}
