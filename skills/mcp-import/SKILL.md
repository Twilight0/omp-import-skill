---
name: mcp-import
description: Import MCP server definitions from other agents (muse-code, gemini mcp_config.json) into omp's native mcp.json. Use when the user wants servers configured elsewhere to also run under omp. Never touches servers omp already discovers itself.
---

# MCP server import

omp already discovers most tools' MCP configs live (opencode.json,
codex `config.toml`, gemini `settings.json`, claude, cursor, windsurf,
vscode, root `mcp.json` fallbacks) — check `/mcp list` first. What it
does **not** read, this skill imports:

| source | file | mapping |
|---|---|---|
| `muse` | `~/.config/muse/settings.json` → `mcpServers` | `stdio` → `{command, args, env}`; `streamable_http` → `{type: http, url}`; `enabled: false` preserved; muse-only `mode` dropped |
| `gemini-mcp` | `~/.gemini/mcp_config.json` → `mcpServers` | `command` → stdio entry, `url` → http entry |

Antigravity has no file-based MCP store (checked
`~/.config/Antigravity`) — nothing to import.

## Converter

`scripts/mcp_to_omp.py` (stdlib only; target backup before every write):

```bash
scripts/mcp_to_omp.py --dry-run                    # preview all sources
scripts/mcp_to_omp.py --source muse --dry-run      # one source
scripts/mcp_to_omp.py --include-disabled --dry-run # preview disabled too
scripts/mcp_to_omp.py                              # merge into ~/.omp/agent/mcp.json
```

Entries the source has disabled are skipped by default
(`--include-disabled` overrides). Merge rule: add names missing from
the target; never modify or delete existing entries (same-name entries
from another tool keep working through omp's own discovery).
Afterwards `/mcp reload`.
scripts/mcp_to_omp.py                              # merge into ~/.omp/agent/mcp.json
```

## Safety

- Sources are read-only; target gets a timestamped `.bak.*` backup.
- No secrets are transformed: stdio `env` and remote `headers` values
  copy verbatim (use omp's `${VAR}` / `!command` indirection when
  editing afterwards).
- Review a foreign server before enabling it: stdio entries run
  arbitrary commands.
