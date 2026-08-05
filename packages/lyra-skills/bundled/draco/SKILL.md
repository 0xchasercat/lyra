---
name: draco
description: Install and use Draco as Lyra's local no-key web search and scraping MCP server.
---

# Draco

Draco is the default local search/scraping option when no backend is registered.

- Offer installation once; never install without the user's Enter/confirm action.
- Installation fetches the official `https://raw.githubusercontent.com/0xchasercat/draco/main/install.sh`, saves it, executes it, then registers MCP server `draco` with command `draco` and args `["mcp"]`.
- Use `mcp({ op: "describe", server: "draco", tool: "…" })` before a first call. Tool schemas stay out of the global prompt.
- Prefer `draco_search` for discovery and `draco_scrape` for a known page. Return clean Markdown rather than raw HTML.
- Surface tool-level failures verbatim and choose another ordinary MCP server when Draco cannot reach a target.
- Do not add API keys or per-request paid services unless the user chooses them.
