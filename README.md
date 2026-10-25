# omp_import_skill

Import foreign agent sessions into [omp](https://omp.sh) (`~/.omp/agent`)
as native JSONL sessions. Everything lives in this repo — no external
importer checkout. One shared provenance rule: **imported tool/output
history stays text — never synthesized `toolCall` blocks**, so replays
can't fake tool provenance.

| Skill | Source | Mechanism |
|---|---|---|
| `skills/opencode-import` | `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` (1.X: `session`/`message`/`part`; 2.X: `session_v2`/`session_message`) | In-repo: `src/core.ts` + `/opencode-import` extension at `adapters/omp`. Reads the DB with `sqlite3 -readonly`, idempotent registry. |
| `skills/antigravity-import` | `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl` (+ titles from `conversation_summaries.db`) | In-repo: `scripts/antigravity_to_omp.py` (stdlib only). Sidesteps the protobuf `steps.step_payload` blobs in `conversations/*.db`, which have no stable schema. |
| `skills/muse-code-import` | `~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl` (+ `session-index.db` for list/title/workspace) | In-repo: `scripts/muse_to_omp.py` (stdlib only). Maps framed `run`/`task` events in sequence order; reasoning is encrypted server-side, `task/output` chunks are result duplicates — both skipped. |
| `skills/mcp-import` | `~/.config/muse/settings.json`, `~/.gemini/mcp_config.json` | In-repo: `scripts/mcp_to_omp.py` (stdlib only). Adds names missing from `~/.omp/agent/mcp.json`; skips source-disabled entries by default and anything omp already discovers. |

The OpenCode core was originally sourced from
[pi-opencode-session-import](https://github.com/jms830/pi-opencode-session-import)
(MIT, see `LICENSE.upstream`) and is now maintained here.

## Install

```bash
# skills (all four)
ln -s /home/twilight/Projects/omp_import_skill/skills/opencode-import ~/.omp/agent/skills/opencode-import
ln -s /home/twilight/Projects/omp_import_skill/skills/mcp-import ~/.omp/agent/skills/mcp-import
ln -s /home/twilight/Projects/omp_import_skill/skills/antigravity-import ~/.omp/agent/skills/antigravity-import
ln -s /home/twilight/Projects/omp_import_skill/skills/muse-code-import ~/.omp/agent/skills/muse-code-import
```

Restart the session afterwards (skills and extensions load at startup).
Requires `sqlite3` on PATH.

## Use

```bash
/opencode-import                        # pick an OpenCode session (v1 + v2)
scripts/antigravity_to_omp.py <uuid> --dry-run          # preview
scripts/antigravity_to_omp.py <uuid> --cwd /path/to/project
scripts/muse_to_omp.py --list                           # browse muse sessions
scripts/muse_to_omp.py <uuid> --dry-run                 # preview
scripts/mcp_to_omp.py --dry-run                          # preview MCP merge
omp --resume <written-file>             # open the imported session
```

## Layout

```text
skills/opencode-import/SKILL.md      # opencode workflow + safety rules
skills/antigravity-import/SKILL.md   # mapping table + workflow
skills/muse-code-import/SKILL.md    # mapping table + workflow
src/core.ts                          # opencode conversion core (v1 + v2)
src/core.test.ts                     # `bun test`
adapters/omp/index.ts                # /opencode-import extension
scripts/antigravity_to_omp.py        # brain transcript -> omp JSONL
scripts/muse_to_omp.py               # muse session.jsonl -> omp JSONL
scripts/mcp_to_omp.py                # foreign MCP defs -> mcp.json merge
skills/mcp-import/SKILL.md           # MCP import workflow + safety rules
LICENSE.upstream                     # MIT attribution (opencode core)
```

## Limitations

- Antigravity `brain/` logs can lag a live conversation; import idle ones.
- Assistant `GENERIC` rows mix prose and tool output; kept as text,
  truncatable via `--max-text-chars`.
- Workspace defaults to `conversation_summaries.workspace_uris`;
  override with `--cwd`.
- Muse reasoning bodies are encrypted server-side and `task/output`
  chunks duplicate committed tool results; both are skipped, counts shown.
- MCP merge skips source-disabled servers unless `--include-disabled`;
  same-name entries already in the target are never touched.
