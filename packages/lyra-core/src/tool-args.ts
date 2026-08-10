/**
 * First-call ergonomics for tool arguments (LYRA.md §3.7).
 *
 * Models arrive with priors from other harnesses — Claude Code's `file_path`, `old_string`,
 * `new_string`, `timeout`; camelCase spellings like `filePath`; the MCP wire spelling
 * `arguments`. Those priors override the schema the model is shown, so the fix belongs in
 * the tool: the alias is declared in the schema (which legitimizes it and puts it in front
 * of the model) and folded onto the canonical field before anything else runs.
 *
 * Two rules make this safe rather than sloppy:
 *  - A canonical field always wins its own name; an alias only fills a hole.
 *  - Canonical and alias arriving together with *different* values is a real ambiguity and
 *    is refused by name, never silently resolved.
 */

/** One canonical field and the foreign spellings that mean exactly the same thing. */
export interface ToolAlias {
  readonly canonical: string;
  readonly aliases: readonly string[];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * A field the model did not fill. Some providers emit *every* declared property on every
 * call — strict structured output puts the whole schema in the grammar — so the spelling for
 * "nothing to say here" arrives as `null` rather than as an absent key. Treating null as
 * absent is what makes `{ timeoutMs: 10000, timeout: null }` a plain call instead of a
 * conflict between a value and a hole.
 */
function absent(value: unknown): boolean { return value === undefined || value === null; }

/** A plain argument object, or undefined when the value is not one. */
export function toolArgs(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Fold declared aliases onto their canonical fields. Returns the rewritten arguments, or a
 * sentence naming both fields when a canonical and an alias disagree. Non-object input is
 * returned untouched so the schema validator produces the type error.
 */
export function foldToolAliases(input: unknown, aliases: readonly ToolAlias[], tool: string): unknown | string {
  const args = toolArgs(input);
  if (args === undefined) return input;
  let output: Record<string, unknown> | undefined;
  for (const { canonical, aliases: spellings } of aliases) {
    // Whichever name currently holds the canonical value, so a conflict names the field the
    // model actually sent rather than one it never used.
    let holder = absent(args[canonical]) ? undefined : canonical;
    for (const alias of spellings) {
      if (!(alias in args)) continue;
      // An empty alias is dropped rather than skipped: leaving `timeout: null` in place would
      // fail the alias's own schema type on the very next step.
      if (absent(args[alias])) { output ??= { ...args }; delete output[alias]; continue; }
      const supplied = (output ?? args)[canonical];
      if (!absent(supplied) && !sameValue(supplied, args[alias])) {
        return `${tool} received both ${holder ?? canonical} and ${alias} with different values; ${alias} is only an alias for ${canonical}, so send ${canonical} alone.`;
      }
      output ??= { ...args };
      if (absent(supplied)) { output[canonical] = args[alias]; holder = alias; }
      delete output[alias];
    }
  }
  return output ?? args;
}

/**
 * Declare an alias in the schema the model actually sees. An undeclared alias would be
 * refused by `additionalProperties: false` before the fold ever ran.
 */
export function aliasSchema(canonical: string, type: string | readonly string[], extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { type: Array.isArray(type) ? [...type] : type, ...extra, description: `Alias for ${canonical}.` };
}

/**
 * Refuse one field that Lyra deliberately does not implement, with a sentence that teaches
 * the Lyra way. Accept-and-ignore is forbidden (§3.7.5), so an unsupported knob has to say
 * what to do instead.
 */
export function rejectedField(input: unknown, field: string, lesson: string): string | undefined {
  const args = toolArgs(input);
  if (args === undefined || !(field in args) || args[field] === undefined) return undefined;
  return lesson;
}
