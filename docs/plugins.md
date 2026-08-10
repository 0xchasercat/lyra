# Auth plugins

Lyra has one executable extension point (LYRA.md §2, §5.5). This is it.

Everything else Lyra does, it ships finished. An auth plugin exists because the thing it
enables — reaching a subscription tier rather than an API key — is not one thing. It is a
different OAuth dance per vendor, changing on their schedule, with credentials Lyra has no
business storing. Core owns none of that. It owns the four facts a request needs, and the
community owns how they are obtained.

---

## The contract

`~/.lyra/plugins/<id>/plugin.ts` (or `index.ts`) default-exports:

```ts
export default {
  id: "claude-oauth",                 // must equal the directory name

  headers: {                          // optional: extra headers this endpoint mandates
    "anthropic-beta": "oauth-2025-04-20",
  },

  systemPrefix: "You are …",          // optional: one static line, prepended as the FIRST
                                      // system block, ahead of Lyra's own prompt

  async login() { /* … */ },          // optional: interactive. Only ever run by
                                      // `lyra plugins login <id>`, which owns the terminal.

  async getToken() {                  // required: non-interactive
    return { token: "…", expiresAt: "2026-08-10T12:00:00.000Z" };
  },
};
```

| Field | Required | What Lyra does with it |
|---|---|---|
| `id` | yes | Checked against the directory name. A mismatch is refused at install and at load, by name. |
| `headers` | no | Merged over the provider's own request headers, on every request. |
| `systemPrefix` | no | Sent as the first system block, before Lyra's system prompt. One line, no newlines. |
| `login` | no | Never called during a turn. Only `lyra plugins login <id>` runs it. |
| `getToken` | yes | Called whenever a request needs a credential. Cached until 60s before `expiresAt`. |

`getToken` must be **non-interactive**. It runs inside a streaming turn, possibly inside a
spawned child, possibly while nothing is attached to a terminal. When there are no stored
credentials it must **throw**, with a sentence saying so — Lyra appends
`Run \`lyra plugins login <id>\`` and surfaces the pair. A `getToken` that opens a browser is a
hung turn.

`expiresAt` is an ISO 8601 instant. Omit it and Lyra caches the token for the life of the
process; a rejected token still recovers, see *Refresh* below.

### Wiring it to a provider

```toml
[providers.claude-max]
base_url = "https://api.anthropic.com/v1"
api_type = "anthropic_messages"
auth     = { type = "plugin", plugin = "claude-oauth" }
```

A plugin returns a **bearer** token by contract, so `auth = { type = "plugin" }` sends
`Authorization: Bearer …` even on `anthropic_messages`, where an API key would have gone in
`x-api-key`.

### Refresh

Lyra caches the token and re-asks the plugin 60 seconds before `expiresAt`. If the endpoint
rejects a token anyway — revoked early, clocks disagreeing — the 401 is classified as `auth`,
the cached token is dropped, `getToken` is called again, and the request is retried **once**.
A second 401 surfaces to the user with the provider named and `lyra plugins login <id>` as the
remedy. Plugins should treat a `getToken` call as *"give me a token that works now"*, refreshing
from a stored refresh token when the access token is stale.

---

## Why `systemPrefix` exists

This is the field that justifies the hatch being more than one function, so it is worth being
precise about.

Subscription endpoints do not only check a token. Some also check that the request *looks like*
the vendor's own client: a specific set of beta headers, and a specific identity line as the
first system block.

The established workaround is a proxy that injects the vendor client's **entire system
prompt** — thousands of words of someone else's instructions, tool descriptions, and behavioural
rules — in front of yours. It works, and it quietly replaces the agent you configured with a
different one. Instruction-following is contaminated at the root: two prompts, disagreeing,
with the bigger one first.

`systemPrefix` pays the part that is actually checked and nothing else. One line the endpoint
requires, then Lyra's own prompt, in Lyra's own authority (§14). The two are separate blocks on
the wire, not a concatenated string, so the split is visible rather than implied.

Two consequences worth knowing:

- **It is not counted against Lyra's 4,000-character system prompt budget.** The budget exists
  to keep Lyra's capability index short (§14); a line the endpoint mandates is not Lyra's to
  shorten. `buildSystemPrompt` never sees the prefix — it is added in the provider layer, at the
  same point request headers are resolved.
- **It is static for the session**, so the cache breakpoint still sits at the end of the system
  blocks and prompt caching is unaffected (§13).

A `systemPrefix` is not a place to put instructions. If yours is a paragraph, it is a proxy in
a smaller costume.

---

## Installing

```
lyra plugins install <git-url|path> [id]   clone (shallow) or copy into ~/.lyra/plugins
lyra plugins list                          what is installed, from where, and whether it loads
lyra plugins update <id>                   git pull, then re-validate
lyra plugins remove <id>                   delete it
lyra plugins login <id>                    run its login flow, then verify a token
```

`install` derives the id from the repository or directory basename (`claude-oauth.git` →
`claude-oauth`); pass an explicit id when the two differ. It refuses to overwrite an existing
directory — use `update`, or `remove` first. After cloning it loads the plugin once; if it does
not load, the directory is deleted again so `list` never has to explain a half-install.

`list` reports each plugin as `ok` or `INVALID` with the reason, because a plugin that stopped
loading should be discovered by asking, not by a failed turn.

## The trust model, plainly

An auth plugin is code, and Lyra imports it into its own process. It runs with your environment
variables, your filesystem access, your network, and your credentials. Nothing sandboxes it.

Lyra tells you this at install time, naming the source, and then installs it. There is no
confirmation prompt, because a prompt you click through is not a safety property — it is a
delay that trains you to click through prompts (§1: YOLO; make it visible instead of gating it).

What Lyra does guarantee is narrow and worth stating:

- A plugin is loaded **only** when a provider's configuration names it.
- The id is a directory name, validated against `^[a-z][a-z0-9-]{0,63}$`; it cannot traverse.
- The entry file is resolved through `realpath` and must stay inside `~/.lyra/plugins`, so a
  symlinked directory cannot make Lyra import something else.
- `login()` runs **only** under `lyra plugins login`. A turn never triggers an interactive flow.

Read plugins before installing them. Prefer ones you can read in a sitting — the whole contract
is four fields, so a plugin that is not short is doing something you did not ask for.

---

## Skeleton: an OAuth device-flow plugin

The shape, not an implementation. The OAuth specifics are deliberately stubbed: which
authorization server, which client id, which scopes, and what a given vendor's terms allow are
the community's business, not core's.

`~/.lyra/plugins/claude-oauth/plugin.ts`:

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const CREDENTIALS = join(HERE, "credentials.json");

// TODO: the vendor's own values. Nothing here is a secret — a public client id is public —
// but everything here is vendor-specific and changes on their schedule, not Lyra's.
const DEVICE_CODE_URL = "https://…/oauth/device/code";
const TOKEN_URL = "https://…/oauth/token";
const CLIENT_ID = "…";
const SCOPES = "…";

interface Stored {
  accessToken: string;
  refreshToken: string;
  /** ISO 8601. */
  expiresAt: string;
}

async function read(): Promise<Stored | undefined> {
  try { return JSON.parse(await readFile(CREDENTIALS, "utf8")) as Stored; }
  catch { return undefined; }
}

async function write(stored: Stored): Promise<void> {
  await mkdir(dirname(CREDENTIALS), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS, JSON.stringify(stored, null, 2), { mode: 0o600 });
  // Belt and braces: writeFile's mode does not apply to a file that already existed.
  await chmod(CREDENTIALS, 0o600);
}

export default {
  id: "claude-oauth",

  // The beta flag this endpoint mandates alongside an OAuth bearer token.
  headers: { "anthropic-beta": "…" },

  // The one line the endpoint checks. Not a prompt — a shibboleth.
  systemPrefix: "…",

  /**
   * Interactive. Runs only under `lyra plugins login claude-oauth`, which owns the terminal,
   * so printing and waiting are both fine here.
   */
  async login(): Promise<void> {
    // 1. Ask for a device code.
    const start = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
    }).then((response) => response.json() as Promise<{
      device_code: string; user_code: string; verification_uri: string; interval: number;
    }>);

    // 2. Tell the human what to do. This is the whole reason login() is separate from getToken().
    console.log(`Open ${start.verification_uri} and enter code ${start.user_code}`);

    // 3. Poll until they do, or until it expires. Honour `interval`; back off on slow_down.
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, start.interval * 1000));
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: start.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const body = await response.json() as {
        access_token?: string; refresh_token?: string; expires_in?: number; error?: string;
      };
      if (body.error === "authorization_pending") continue;
      if (body.error !== undefined) throw new Error(`Sign-in failed: ${body.error}`);
      if (!body.access_token || !body.refresh_token || !body.expires_in) {
        throw new Error("The token endpoint returned no usable credentials.");
      }
      await write({
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      });
      return;
    }
  },

  /**
   * Non-interactive, and called on the hot path. Read, refresh if stale, never prompt.
   */
  async getToken(): Promise<{ token: string; expiresAt: string }> {
    const stored = await read();
    if (stored === undefined) {
      // The sentence a user sees. Lyra appends `Run \`lyra plugins login claude-oauth\``.
      throw new Error(`No stored credentials at ${CREDENTIALS}`);
    }

    // Lyra already refreshes 60s early, so this only fires when the clock moved under us.
    if (Date.parse(stored.expiresAt) > Date.now() + 30_000) {
      return { token: stored.accessToken, expiresAt: stored.expiresAt };
    }

    const body = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
    }).then((response) => response.json() as Promise<{
      access_token?: string; refresh_token?: string; expires_in?: number;
    }>);
    if (!body.access_token || !body.expires_in) {
      throw new Error(`Refresh was rejected; the stored credentials at ${CREDENTIALS} are stale`);
    }

    const next: Stored = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? stored.refreshToken,
      expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
    };
    await write(next);
    return { token: next.accessToken, expiresAt: next.expiresAt };
  },
};
```

Then:

```
lyra plugins install https://github.com/you/claude-oauth
lyra plugins login claude-oauth
```

and in `~/.lyra/providers.toml`:

```toml
[providers.claude-max]
base_url = "https://api.anthropic.com/v1"
api_type = "anthropic_messages"
auth     = { type = "plugin", plugin = "claude-oauth" }

[roles]
default = "claude-max/claude-opus-5"
```

## Writing your own

- Keep credentials inside the plugin's own directory, `chmod 600`. Lyra never reads them and
  never copies them.
- Throw, with the path in the message, when there is nothing stored. That sentence is the whole
  error the user gets.
- `getToken` may be called concurrently by a parent and its spawned children. If a refresh is
  expensive, memoise the in-flight promise.
- Do not log the token. `lyra plugins list` and every Lyra error report the credential's
  *address*, never its contents; keep that true.
