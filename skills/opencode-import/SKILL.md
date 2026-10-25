---
name: opencode-import
description: Import an OpenCode session (1.X and 2.X stores) into omp's native JSONL format. Use when the user wants to resume, reference, or continue an OpenCode conversation inside omp. Conversion code lives in this project (src/, adapters/), not in an external repo.
---

# OpenCode session import

OpenCode stores sessions in SQLite at
`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`.
1.X uses tables `session`, `message`, `part`; 2.X adds `session_v2` +
`session_message` (content inline, no `part` rows). Both stores are listed
(UNION ALL, `v1`/`v2` marker) and converted — omp cannot read either
format directly. Convert with this project's own code — do not hand-roll
SQL and do not pull an external importer.

## Layout (this project)

```text
src/core.test.ts       # 15 tests, run with `bun test`
adapters/omp/index.ts  # /opencode-import slash-command extension
LICENSE.upstream       # MIT attribution for the vendored core
```

## Install (once)

```bash
ln -s /home/twilight/Projects/omp_import_skill/adapters/omp ~/.omp/agent/extensions/opencode-import
```

Requires `sqlite3` on PATH; omp runs the adapter on Bun. The adapter
resolves its types from the running omp host (`@oh-my-pi/pi-coding-agent`);
`bun test` covers `src/core.ts` standalone.

## Usage (inside omp, after a session restart)

```text
/opencode-import                 # interactive selector
/opencode-import ses_xxx         # one session
/opencode-import list [search]   # browse (--cwd, --since, --limit)
/opencode-import all --dry-run   # preview bulk import
/opencode-import all             # bulk import, idempotent
/opencode-import open ses_xxx    # switch to already-imported session
```

## Safety properties (keep them)

- DB opened `-readonly`; import asserts source mtime unchanged.
- OpenCode tool history is serialized as **text** inside assistant
  messages — never re-emitted as runtime `toolCall` blocks. Do not
  "upgrade" this: replayed tool calls would fake provenance.
- Registry: `~/.omp/agent/opencode-import-registry.json` prevents
  double-imports. `--force` reimports; `--max-tool-chars 0` drops
  historical tool output.

## Fallback (extension refused)

Only if the user refuses the extension, the raw material is
`session` → header, `message` (`role`, `parentID`) → entries,
`part` (`text` | `reasoning` | `tool`) → content; `step-start`,
`step-finish`, `patch`, `compaction` parts are runtime bookkeeping,
skip them.
