import { IrcBus, SpawnManager } from "@lyra/core";
import { LspManager } from "@lyra/lsp";
import { McpGateway, McpRegistry } from "@lyra/mcp";
import { RuntimeManager } from "@lyra/runtime";
import { SkillRegistry } from "@lyra/skills";
import { ToolRegistry, type LyraTool } from "@lyra/tools";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRATED_TOOL_NAMES, createIntegratedToolRegistry, type CheckpointAccess } from "../src/integrated-tools.ts";

/**
 * The model's contract, checked in both directions against the tools that serve it.
 *
 * The advertised schema is the only description of Lyra a model ever reads, so a property it
 * declares and the handler then discards is a lie the model pays for twice: once filling the
 * field and once acting on a result that ignored it. The two directions are:
 *
 *   declared ⇒ accepted — every property in every schema survives normalization and reaches
 *     the handler with the value the model sent;
 *   read ⇒ declared — the handler never receives a key the schema does not declare, so there
 *     is no field it can act on that the model was never told about. Foreign spellings fold
 *     onto canonical names *before* this boundary (§3.7), which the alias pass below proves.
 *
 * Both run over the registry the application actually builds, reflecting over whatever it
 * registers rather than a list maintained here — a tool added without a schema review fails
 * this file rather than shipping.
 */

const roots: string[] = [];
const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A checkpoint store that answers but never touches a repository: this is a schema test. */
const checkpoints: CheckpointAccess = {
  list: async () => [],
  create: async () => undefined,
  restore: async () => { throw new Error("not used"); },
  diff: async () => ({ from: "a", to: "b", files: [] }) as never,
  unavailable: () => undefined,
};

async function surface(): Promise<{ registry: ToolRegistry; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "lyra-contract-"));
  roots.push(root);
  const bus = new IrcBus();
  const spawn = new SpawnManager({ defaultWorkspace: root, executor: async () => ({ ok: true }) });
  const registry = createIntegratedToolRegistry({
    lsp: new LspManager({ workspace: root } as never),
    spawn, bus, peer: "main",
    agents: { status: (name) => spawn.status(name) },
    skills: new SkillRegistry({ workspace: root, home: root, projectRoot: root, userRoot: root, bundledRoot: root } as never),
    runtime: new RuntimeManager({ origin: root, session: "contract", adapters: {} } as never),
    mcp: new McpGateway(new McpRegistry(root)),
    checkpoints,
    filesystem: { root }, bash: { root }, cwd: root, origin: root,
  });
  closers.push(async () => { await registry.close(); await spawn.close?.(); });
  return { registry, root };
}

/**
 * Runs one tool's real normalizer and the registry's real validator, then stops.
 *
 * Substituting the execute body is what makes this exhaustive: probing every declared property
 * of `bash` or `spawn` against the live handler would run commands and start children, so the
 * contract could only ever be spot-checked. Everything up to the handler boundary — aliases,
 * padding, scalar coercion, schema validation — is the genuine article.
 */
function boundary(tool: LyraTool): { registry: ToolRegistry; received: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  const stub: LyraTool = {
    definition: tool.definition,
    ...(tool.normalize ? { normalize: (args: unknown) => tool.normalize!(args) } : {}),
    execute: async (args: unknown) => {
      captured = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
      return { content: "ok" };
    },
  };
  return { registry: new ToolRegistry([stub]), received: () => captured };
}

function context(root: string): never {
  return { signal: new AbortController().signal, sessionId: "contract", workspace: root, callId: "call-1", cwd: root, origin: root } as never;
}

function properties(definition: { inputSchema: unknown }): Record<string, Record<string, unknown>> {
  return ((definition.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {});
}

/** A value the declared schema would accept, so a rejection can only be the handler's doing. */
function sample(schema: Record<string, unknown>, tool: string, property: string): unknown {
  if (property === "flags") return "i";
  if (property === "job") return "job-000001";
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.pattern === "^#[a-fA-F0-9]+$") return "#abc123";
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "integer": case "number": return Math.max(1, (schema.minimum as number | undefined) ?? 1);
    case "boolean": return true;
    case "array": return [`sample-${property}`];
    case "object": return { probe: true };
    default: return typeof schema.pattern === "string" ? `sample-${property}` : `sample-${tool}-${property}`;
  }
}

/**
 * Properties whose only job is to name another one. There are none, and the point of
 * asserting the empty list is that adding one is a red test rather than a quiet regression.
 *
 * Declaring an alias beside its canonical twin is what taught a strict emitter to fill both,
 * so every accepted foreign spelling lives in a fold table that runs before validation
 * instead of in the schema a model reads. `mcp.arguments` and `skill.skill` were the last
 * two exceptions; both are still accepted, neither is advertised.
 */
const DECLARED_ALIASES: readonly string[] = [];

/** Foreign spellings every tool accepts and none advertises, from the fold tables (§3.7). */
const FOREIGN_SPELLINGS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  read: { file_path: "a.ts", offset: 3, limit: 4 },
  write: { filePath: "a.ts", file_text: "body\n" },
  edit: { file_path: "a.ts", old_string: "a", new_string: "b", tag: "#abc123" },
  bash: { cmd: "echo hi", workdir: ".", timeout: 5000, runInBackground: true },
  grep: { regex: "value", include: "**/*.ts", head_limit: 5, "-C": 2, "-i": true, directory: "." },
  glob: { glob: "**/*.ts", dir: "." },
  git: { command: "status --short", workdir: ".", timeout: 5000 },
  spawn: { prompt: "audit the parser", description: "auditor", write_scope: ["src/**"], timeout: 1000 },
  hub: { op: "send", agent: "reviewer", text: "hello", topic: "build", timeout: 5 },
  jit: { op: "declare", script_name: "porter", code: "export default () => 1;\n" },
  lsp: { operation: "definition", uri: "file:///tmp/a.ts", line: 1, character: 2 },
  skill: { skill: "reviewer" },
  mcp: { op: "describe", server: "s", tool: "t", arguments: { probe: true } },
});

/** Calls that mean two different things at once, so a bare "required + one field" cannot work. */
const BASE_ARGS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  spawn: { task: "audit the parser" },
});
/** Properties whose presence excludes the tool's ordinary base call, or needs a specific value. */
const EXCLUSIVE: Readonly<Record<string, unknown>> = Object.freeze({
  // `id` addresses a child that exists; `task` starts a new one. Sending both is refused by name.
  "spawn.id": undefined,
  // Every other op needs an `id` to name the child it applies to; `list` is the one that does not.
  "spawn.op": "list",
});

describe("the schema a model reads and the handler that serves it", () => {
  test("the advertised surface is exactly the thirteen tools, in the documented order", async () => {
    const { registry } = await surface();
    expect(registry.definitions().map((definition) => definition.name)).toEqual([...INTEGRATED_TOOL_NAMES]);
  });

  test("every tool and every property carries documentation, and refuses what it does not declare", async () => {
    const { registry } = await surface();
    for (const definition of registry.definitions()) {
      const schema = definition.inputSchema as Record<string, unknown>;
      expect({ tool: definition.name, described: definition.description.trim().length > 0 }).toEqual({ tool: definition.name, described: true });
      // Without this an undeclared field is silently ignored, which is §3.8's no-silent-loss
      // failure wearing a schema: the model believes it asked for something it did not get.
      expect({ tool: definition.name, closed: schema.additionalProperties }).toEqual({ tool: definition.name, closed: false });
      const declared = properties(definition);
      for (const [name, property] of Object.entries(declared)) {
        expect({ tool: definition.name, property: name, described: typeof property.description === "string" && property.description.trim().length > 0 })
          .toEqual({ tool: definition.name, property: name, described: true });
      }
      for (const name of (schema.required as string[] | undefined) ?? []) {
        expect({ tool: definition.name, required: name, declared: name in declared }).toEqual({ tool: definition.name, required: name, declared: true });
      }
    }
  });

  /** Direction one: a property the schema names must survive to the handler with its value. */
  test("every declared property is accepted and reaches the handler", async () => {
    const { registry, root } = await surface();
    for (const definition of registry.definitions()) {
      const tool = registry.get(definition.name)!;
      const declared = properties(definition);
      for (const [name, property] of Object.entries(declared)) {
        const key = `${definition.name}.${name}`;
        if ((DECLARED_ALIASES as readonly string[]).includes(key)) continue; // folds onto its canonical twin by design
        const args: Record<string, unknown> = key in EXCLUSIVE ? {} : { ...(BASE_ARGS[definition.name] ?? {}) };
        for (const required of ((definition.inputSchema as { required?: string[] }).required ?? [])) {
          args[required] ??= sample(declared[required] ?? {}, definition.name, required);
        }
        args[name] = key in EXCLUSIVE ? EXCLUSIVE[key] : sample(property, definition.name, name);
        if (args[name] === undefined) args[name] = sample(property, definition.name, name);

        const probe = boundary(tool);
        const result = await probe.registry.execute(definition.name, args, context(root));
        expect({ key, rejected: result.isError === true, why: result.isError === true ? String(result.content) : "" })
          .toEqual({ key, rejected: false, why: "" });
        expect({ key, reached: probe.received()?.[name] }).toEqual({ key, reached: args[name] });
      }
    }
  });

  /**
   * Direction two: nothing undeclared reaches the handler.
   *
   * A key the handler can read but the schema never named is a capability the model cannot
   * discover — or, worse, one it discovers by accident from another harness's spelling and
   * then relies on. Every accepted foreign spelling must therefore be *gone* by this point,
   * folded onto the canonical name the schema does advertise.
   */
  test("the handler never receives a property the schema does not declare", async () => {
    const { registry, root } = await surface();
    for (const definition of registry.definitions()) {
      const tool = registry.get(definition.name)!;
      const declared = Object.keys(properties(definition));
      const calls: Array<Record<string, unknown>> = [];
      const foreign = FOREIGN_SPELLINGS[definition.name];
      if (foreign !== undefined) calls.push(foreign);
      // Also the fully-populated canonical call, which is where an inferred field (edit's
      // `mode`) would show up if a normalizer ever invented one the schema does not carry.
      const canonical: Record<string, unknown> = { ...(BASE_ARGS[definition.name] ?? {}) };
      for (const [name, property] of Object.entries(properties(definition))) {
        if (`${definition.name}.${name}` in EXCLUSIVE || (DECLARED_ALIASES as readonly string[]).includes(`${definition.name}.${name}`)) continue;
        canonical[name] = sample(property, definition.name, name);
      }
      calls.push(canonical);

      for (const args of calls) {
        const probe = boundary(tool);
        const result = await probe.registry.execute(definition.name, args, context(root));
        expect({ tool: definition.name, args, rejected: result.isError === true, why: result.isError === true ? String(result.content) : "" })
          .toEqual({ tool: definition.name, args, rejected: false, why: "" });
        // Named explicitly: a handler that was never reached would satisfy the loop below
        // vacuously, and "nothing undeclared arrived" is only a fact if something arrived.
        expect({ tool: definition.name, reachedHandler: probe.received() !== undefined }).toEqual({ tool: definition.name, reachedHandler: true });
        for (const key of Object.keys(probe.received() ?? {})) {
          expect({ tool: definition.name, key, declared: declared.includes(key) }).toEqual({ tool: definition.name, key, declared: true });
        }
      }
    }
  });

  /**
   * §3.7: the schema is the smallest true statement of what a tool takes.
   *
   * A model on a strict proxy emits every declared property on every call, so an advertised
   * alias is paid for on every single call and teaches the model to fill both spellings.
   */
  test("no alias is advertised beside its canonical name", async () => {
    const { registry } = await surface();
    const advertised: string[] = [];
    for (const definition of registry.definitions()) {
      for (const [name, property] of Object.entries(properties(definition))) {
        if (/^alias for /i.test(String(property.description ?? ""))) advertised.push(`${definition.name}.${name}`);
      }
    }
    expect(advertised.sort()).toEqual([...DECLARED_ALIASES]);
  });
});
