import { fileURLToPath } from "node:url";
import protocolSchema from "../schema/protocol.json" with { type: "json" };

/**
 * The canonical protocol schema and a validator small enough to run on every emitted frame.
 *
 * This exists so the schema file is load-bearing rather than documentation: conformance
 * tests validate real daemon output against `schema/protocol.json`, so a field that drifts
 * away from the declared shape fails a test instead of surprising a client at runtime.
 *
 * The supported keyword set is deliberately the subset the protocol file uses — `$ref` to
 * local pointers, `const`, `enum`, `type` (including unions and `null`), `required`,
 * `properties`, `additionalProperties`, `items`, `oneOf`/`anyOf`/`allOf`, and the
 * length/range bounds. An unknown keyword is ignored rather than guessed at; the schema
 * file is checked against this list by its own conformance test.
 */

/**
 * On-disk location of the schema, for tooling that needs the file itself (the Rust
 * conformance suite reads it from here). It is *not* how this module loads it: under
 * `bun build --compile` there is no `../schema` next to the bundled module, so a
 * `readFileSync` here would work in the repo and fail in every shipped binary.
 * The import below is what makes the schema travel with the code.
 */
export const PROTOCOL_SCHEMA_PATH = fileURLToPath(
  new URL("../schema/protocol.json", import.meta.url),
);

const SCHEMA = protocolSchema as unknown;

/** The canonical schema document. */
export function loadProtocolSchema(): Readonly<Record<string, unknown>> {
  if (!isRecord(SCHEMA)) throw new Error("Lyra ACP protocol schema is not a JSON object.");
  return SCHEMA;
}

export class SchemaViolation extends Error {
  readonly issues: readonly string[];
  constructor(label: string, issues: readonly string[]) {
    super(`${label} violates the Lyra ACP protocol schema:\n  - ${issues.join("\n  - ")}`);
    this.name = "SchemaViolation";
    this.issues = issues;
  }
}

export class ProtocolValidator {
  readonly root: Readonly<Record<string, unknown>>;

  constructor(root: Readonly<Record<string, unknown>> = loadProtocolSchema()) {
    if (!isRecord(root)) throw new TypeError("A protocol validator needs a schema object.");
    this.root = root;
  }

  /** Returns every issue found; an empty array means the value conforms. */
  validate(value: unknown, pointer = "#"): string[] {
    const issues: string[] = [];
    this.check(value, this.resolve(pointer), "$", issues, new Set());
    return issues;
  }

  /** Throws on the first non-conforming value, with every issue in the message. */
  assert(value: unknown, pointer = "#", label = pointer): void {
    const issues = this.validate(value, pointer);
    if (issues.length > 0) throw new SchemaViolation(label, issues);
  }

  /** Validates a whole daemon-to-client notification frame, envelope included. */
  assertNotification(frame: unknown): void {
    this.assert(frame, "#/$defs/notification", describeFrame(frame));
  }

  /** Validates one `update` union member without its envelope. */
  assertUpdate(update: unknown): void {
    const tag = isRecord(update) && typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : "<untagged>";
    this.assert(update, "#/$defs/update", `update ${tag}`);
  }

  /** Resolves a JSON pointer against the schema document. */
  resolve(pointer: string): unknown {
    if (pointer === "#" || pointer === "") return this.root;
    if (!pointer.startsWith("#/")) throw new Error(`Only local JSON pointers are supported: ${pointer}`);
    let current: unknown = this.root;
    for (const raw of pointer.slice(2).split("/")) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!isRecord(current) || !(key in current)) throw new Error(`Unresolvable schema pointer: ${pointer}`);
      current = current[key];
    }
    return current;
  }

  /** Params schema for a client-to-daemon method, by name. */
  requestParams(method: string): unknown {
    return this.member("requests", method, "params");
  }

  /** Result schema for a client-to-daemon method, by name. */
  requestResult(method: string): unknown {
    return this.member("requests", method, "result");
  }

  /** Params schema for a daemon-to-client request, by name. */
  clientRequestParams(method: string): unknown {
    return this.member("clientRequests", method, "params");
  }

  /** Every method name the schema declares, so tests can diff it against ACP_METHODS. */
  declaredMethods(): string[] {
    const requests = this.resolve("#/$defs/requests");
    if (!isRecord(requests)) return [];
    return Object.keys(requests).filter((key) => !key.startsWith("$"));
  }

  /** Every `sessionUpdate` tag the schema declares. */
  declaredUpdates(): string[] {
    const update = this.resolve("#/$defs/update");
    if (!isRecord(update) || !Array.isArray(update.oneOf)) return [];
    return update.oneOf.flatMap((variant) => {
      const tag = isRecord(variant) && isRecord(variant.properties) && isRecord(variant.properties.sessionUpdate)
        ? variant.properties.sessionUpdate.const
        : undefined;
      return typeof tag === "string" ? [tag] : [];
    });
  }

  private member(container: string, method: string, field: string): unknown {
    const escaped = method.replaceAll("~", "~0").replaceAll("/", "~1");
    return this.resolve(`#/$defs/${container}/${escaped}/${field}`);
  }

  private check(
    value: unknown,
    schema: unknown,
    path: string,
    issues: string[],
    seen: Set<unknown>,
  ): void {
    if (schema === true || schema === undefined) return;
    if (schema === false) {
      issues.push(`${path} is not permitted here`);
      return;
    }
    if (!isRecord(schema)) return;

    if (typeof schema.$ref === "string") {
      const target = this.resolve(schema.$ref);
      if (seen.has(target)) return;
      const nested = new Set(seen);
      nested.add(target);
      this.check(value, target, path, issues, nested);
      return;
    }

    if ("const" in schema && !sameJson(schema.const, value)) {
      issues.push(`${path} must equal ${JSON.stringify(schema.const)}`);
      return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJson(candidate, value))) {
      issues.push(`${path} must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
      return;
    }
    if (schema.type !== undefined) {
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!allowed.some((type) => matchesType(value, type))) {
        issues.push(`${path} must be ${allowed.join(" or ")}, got ${describeType(value)}`);
        return;
      }
    }

    if (typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        issues.push(`${path} must be at least ${schema.minLength} characters`);
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        issues.push(`${path} must be at most ${schema.maxLength} characters`);
      }
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
        issues.push(`${path} does not match ${schema.pattern}`);
      }
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        issues.push(`${path} must be at least ${schema.minimum}`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        issues.push(`${path} must be at most ${schema.maximum}`);
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        issues.push(`${path} must contain at least ${schema.minItems} items`);
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        issues.push(`${path} must contain at most ${schema.maxItems} items`);
      }
      if (schema.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
          this.check(value[index], schema.items, `${path}[${index}]`, issues, seen);
        }
      }
    }
    if (isRecord(value)) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) {
        for (const name of schema.required) {
          if (typeof name === "string" && !(name in value)) issues.push(`${path}.${name} is required`);
        }
      }
      for (const [name, propertySchema] of Object.entries(properties)) {
        if (name in value) this.check(value[name], propertySchema, `${path}.${name}`, issues, seen);
      }
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(value)) {
          if (!(name in properties)) {
            issues.push(`${path}.${name} is not declared by the protocol schema`);
          }
        }
      } else if (isRecord(schema.additionalProperties)) {
        for (const [name, nested] of Object.entries(value)) {
          if (!(name in properties)) {
            this.check(nested, schema.additionalProperties, `${path}.${name}`, issues, seen);
          }
        }
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) this.check(value, branch, path, issues, seen);
    }
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => this.matches(value, branch, seen))) {
      issues.push(`${path} matches none of the ${schema.anyOf.length} permitted shapes`);
    }
    if (Array.isArray(schema.oneOf)) {
      const matched = schema.oneOf.filter((branch) => this.matches(value, branch, seen));
      if (matched.length === 1) return;
      if (matched.length > 1) {
        issues.push(`${path} is ambiguous: it matches ${matched.length} variants at once`);
        return;
      }
      // Report against the variant the discriminator selected, so the failure names the
      // real problem instead of listing every branch that did not apply.
      const selected = this.selectVariant(value, schema.oneOf);
      if (selected === undefined) {
        issues.push(`${path} matches none of the ${schema.oneOf.length} declared variants`);
        return;
      }
      this.check(value, selected, path, issues, seen);
    }
  }

  private matches(value: unknown, schema: unknown, seen: Set<unknown>): boolean {
    const issues: string[] = [];
    this.check(value, schema, "$", issues, seen);
    return issues.length === 0;
  }

  /** Picks the union member whose discriminating `const` the value already satisfies. */
  private selectVariant(value: unknown, branches: readonly unknown[]): unknown {
    if (!isRecord(value)) return undefined;
    for (const branch of branches) {
      if (!isRecord(branch) || !isRecord(branch.properties)) continue;
      for (const [name, propertySchema] of Object.entries(branch.properties)) {
        if (isRecord(propertySchema) && "const" in propertySchema && sameJson(propertySchema.const, value[name])) {
          return branch;
        }
      }
    }
    return undefined;
  }
}

function describeFrame(frame: unknown): string {
  if (!isRecord(frame)) return "notification";
  const params = isRecord(frame.params) ? frame.params : undefined;
  const update = params !== undefined && isRecord(params.update) ? params.update : undefined;
  const tag = update !== undefined && typeof update.sessionUpdate === "string" ? update.sessionUpdate : undefined;
  return tag === undefined ? `notification ${String(frame.method)}` : `notification ${String(frame.method)} (${tag})`;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
