---
name: muse-code-import
description: Import a Meta Muse Code conversation into omp's native JSONL format. Use when the user wants to resume, reference, or continue a muse conversation inside omp. Converts the framed session.jsonl event log, never the live session store.
---

# Muse Code session import

Muse Code keeps per-conversation event logs at
`~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl`,
indexed by `~/.local/share/muse/session-index.db` (`sessions` table:
id, title, workspace_root, prompt_count, status). The log is a flat
sequence of framed records (`payload.kind` + `event.kind`), not chat
turns. Convert with this project's script — do not parse it by hand.

## Converter

`scripts/muse_to_omp.py` (stdlib only, sources read-only):

```bash
scripts/muse_to_omp.py --list [--limit 20]   # browse index
scripts/muse_to_omp.py <uuid> --dry-run       # preview
scripts/muse_to_omp.py <uuid> --cwd /path/to/project
```

Output: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`,
then `omp --resume <that-file>` (or `/resume <id-prefix>` in-session).

## Event mapping (sequence order)

| event | omp entry |
|---|---|
| `run` / `started` with `prompt` | `message` role `user` |
| `run` / `assistant_message_committed` | `message` role `assistant` (`text`) |
| `run` / `assistant_tool_calls_committed` | assistant text: `[muse tool call: name id=…]` + args |
| `run` / `tool_result_batch_committed` | assistant text: result bodies |
| `run` / `reasoning_committed` | skipped — content is encrypted |
| `task` / `output` chunks | skipped — duplicates tool results |
| everything else (scheduling, diagnostics, subagent control) | skipped + counted |

Same provenance rule as the other importers: tool history stays
**text**, never synthesized `toolCall` blocks.

## Limitations

- Reasoning bodies are encrypted server-side; imports keep the
  assistant's committed messages, not its hidden thinking.
- `task/output` chunks are dropped as duplicates of the committed
  tool-result batches they mirror.
- Convert idle sessions; the live writer appends while muse runs.
