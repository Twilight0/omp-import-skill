# omp-import-skill

Import foreign agent sessions and MCP servers into [omp](https://omp.sh)
as native JSONL sessions and `mcp.json` entries — so conversations started
in OpenCode, Google Antigravity, or Meta Muse Code (and MCP servers
configured there) keep working after you switch to omp.

One shared provenance rule across every importer: **imported tool and
output history stays plain text — never synthesized `toolCall` blocks**,
so replays can't fake tool provenance.

| Skill | Imports from | How |
|---|---|---|
| `skills/opencode-import` | OpenCode `opencode.db` — 1.X stores (`session`/`message`/`part`) **and** 2.X stores (`session_v2`/`session_message`) | In-repo converter (`src/core.ts`) + `/opencode-import` extension (`adapters/omp`). Reads the DB with `sqlite3 -readonly`; idempotent per-runtime registry |
| `skills/antigravity-import` | Antigravity CLI `brain/<uuid>/.system_generated/logs/transcript_full.jsonl` (+ titles from `conversation_summaries.db`) | `scripts/antigravity_to_omp.py` (stdlib only). Sidesteps the protobuf `steps.step_payload` blobs in `conversations/*.db`, which have no stable schema |
| `skills/muse-code-import` | Muse `sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl` (+ `session-index.db` for list/title/workspace) | `scripts/muse_to_omp.py` (stdlib only). Maps framed `run`/`task` events in sequence order; reasoning bodies are server-side encrypted and `task/output` chunks duplicate tool results — both skipped with counts |
| `skills/mcp-import` | `~/.config/muse/settings.json`, `~/.gemini/mcp_config.json` | `scripts/mcp_to_omp.py` (stdlib only). Adds names missing from `~/.omp/agent/mcp.json`; skips source-disabled entries by default and anything omp already discovers itself (opencode.json, codex, gemini settings, claude, cursor, windsurf, vscode need no import — check `/mcp list` first) |

The OpenCode core was originally sourced from
[pi-opencode-session-import](https://github.com/jms830/pi-opencode-session-import)
(MIT, see `LICENSE.upstream`) and is maintained here.

## Install

```bash
git clone https://github.com/Twilight0/omp-import-skill.git
cd omp-import-skill

# skills (pick the ones you need)
ln -s "$PWD/skills/opencode-import" ~/.omp/agent/skills/opencode-import
ln -s "$PWD/skills/antigravity-import" ~/.omp/agent/skills/antigravity-import
ln -s "$PWD/skills/muse-code-import" ~/.omp/agent/skills/muse-code-import
ln -s "$PWD/skills/mcp-import" ~/.omp/agent/skills/mcp-import

# /opencode-import extension (required by the opencode-import skill)
ln -s "$PWD/adapters/omp" ~/.omp/agent/extensions/opencode-import
```

Restart the session afterwards (skills and extensions load at startup).
Requires `sqlite3` and `bun` on PATH (`bun test` runs the opencode core suite).

## Use

```bash
/opencode-import                        # pick an OpenCode session (v1 + v2)
/opencode-import list [search]           # browse (--cwd, --since, --limit)
/opencode-import all --dry-run           # preview bulk import
/opencode-import all                     # bulk import, idempotent

scripts/antigravity_to_omp.py <uuid> --dry-run          # preview
scripts/antigravity_to_omp.py <uuid> --cwd /path/to/project

scripts/muse_to_omp.py --list                           # browse muse sessions
scripts/muse_to_omp.py <uuid> --dry-run                 # preview

scripts/mcp_to_omp.py --dry-run                         # preview MCP merge
scripts/mcp_to_omp.py --source muse --dry-run           # one source
scripts/mcp_to_omp.py                                   # merge into ~/.omp/agent/mcp.json

omp --resume <written-file>             # open an imported session
```

Converted sessions land in `~/.omp/agent/sessions/<encoded-cwd>/` with a
`parentSession` pointer back at the source (`opencode:<id>`,
`antigravity:<uuid>`, `muse:<uuid>`); MCP merges back up the target with a
timestamped `.bak` first. Run `/mcp reload` (or restart) to pick up new MCP
servers.

## Layout

```text
skills/opencode-import/SKILL.md      # opencode workflow + safety rules
skills/antigravity-import/SKILL.md   # mapping table + workflow
skills/muse-code-import/SKILL.md     # mapping table + workflow
skills/mcp-import/SKILL.md           # MCP import workflow + safety rules
src/core.ts                          # opencode conversion core (v1 + v2)
src/core.test.ts                     # `bun test` (15 tests)
adapters/omp/index.ts                # /opencode-import extension
scripts/antigravity_to_omp.py        # brain transcript -> omp JSONL
scripts/muse_to_omp.py               # muse session.jsonl -> omp JSONL
scripts/mcp_to_omp.py                # foreign MCP defs -> mcp.json merge
LICENSE                              # MIT, this project
LICENSE.upstream                     # MIT attribution (opencode core)
```

## Limitations

- Antigravity `brain/` logs can lag a live conversation; import idle ones.
- Assistant `GENERIC` rows mix prose and tool output; kept as text,
  truncatable via `--max-text-chars`.
- Muse reasoning bodies are server-side encrypted and `task/output`
  chunks duplicate committed tool results; both are skipped, counts shown.
- MCP merge skips source-disabled entries unless `--include-disabled`;
  same-name entries already in the target are never touched.
- Stock-weight models keep portable reasoning; abliterated-weight
  reasoning never replays onto other hosts (enforced at import time by
  keeping it inside plain assistant text, never tool payloads).
```

