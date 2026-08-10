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

## Worked example: reusing Claude Code's credential

The community's answer to subscription auth is not to re-implement an OAuth flow — it is to
reuse the credential the vendor's own CLI already maintains. `claude` (Claude Code) keeps a
refreshable token in the OS credential store; a plugin that reads it, refreshes it through
the same endpoint near expiry, and writes the rotation back needs no login flow of its own.
If the user can run `claude`, the plugin works.

The shape (condensed — the full file is ~150 lines with the platform fallbacks):

`~/.lyra/plugins/claude-oauth/plugin.ts`:

```ts
const SERVICE = "Claude Code-credentials";          // macOS keychain entry
const FILE = "~/.claude/.credentials.json";         // where there is no keychain
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const MARGIN_MS = 60_000;

function read(): { store: Store; oauth: StoredOauth } {
  // keychain via `security find-generic-password -s SERVICE -w`, else the file;
  // both hold JSON with { claudeAiOauth: { accessToken, refreshToken, expiresAt } }.
  // Absent → throw the actionable line below.
}

async function refresh(store: Store, oauth: StoredOauth): Promise<StoredOauth> {
  // POST TOKEN_ENDPOINT { grant_type: "refresh_token", refresh_token, client_id }
  // → rotate accessToken/refreshToken/expiresAt, write back to the same store
  //   (best-effort — the token in hand is good either way) so `claude` keeps working.
}

export default {
  id: "claude-oauth",
  headers: { "anthropic-beta": "oauth-2025-04-20" },
  systemPrefix: "You are Claude Code, Anthropic's official CLI for Claude.",

  async login(): Promise<void> {
    // No flow of our own: Claude Code owns login. Verify the credential exists
    // (throwing "run `claude` and log in once" when it does not) and refresh if stale.
  },

  async getToken(): Promise<{ token: string; expiresAt?: string }> {
    const { store, oauth } = read();
    const live = oauth.expiresAt <= Date.now() + MARGIN_MS ? await refresh(store, oauth) : oauth;
    return { token: live.accessToken, expiresAt: new Date(live.expiresAt - MARGIN_MS).toISOString() };
  },
};
```

Wire it to a provider:

```toml
[providers.claude-max]
base_url = "https://api.anthropic.com/v1"
api_type = "anthropic_messages"
auth = { type = "plugin", plugin = "claude-oauth" }
models = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]
```

Why `systemPrefix` matters here: the subscription endpoint requires the Claude Code identity
line as the first system block. A proxy satisfies that by injecting Claude Code's *entire*
system prompt — tool instructions included — which contaminates the model's instruction
following. This plugin pays exactly one line, and Lyra's prompt keeps its authority.

The specifics above — which service name, which endpoint, which client id, and what a given
vendor's terms allow — are the plugin author's and user's business, not core's. That line is
the whole reason the hatch is a hatch.
