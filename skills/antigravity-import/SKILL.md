---
name: antigravity-import
description: Import a Google Antigravity (agy) conversation into omp's native JSONL format. Use when the user wants to resume, reference, or continue an Antigravity conversation inside omp. Converts the human-readable brain transcript, never the protobuf step blobs.
---

# Antigravity conversation import

Antigravity CLI keeps per-conversation SQLite under
`~/.gemini/antigravity-cli/conversations/<uuid>.db`, but `steps.step_payload`
is protobuf — no stable schema, brittle to decode. Beside each `.db` there is
a human-readable log (93 present on this machine):

```text
~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
```

Convert that. Fall back to `conversation_summaries.db` (same dir,
`conversation_summaries` table) for title / workspace / timestamps.

## Converter

`scripts/antigravity_to_omp.py` (stdlib only, sources read-only):

```bash
# preview
scripts/antigravity_to_omp.py <uuid-or-.db-path> --dry-run
# convert into this project's session bucket
scripts/antigravity_to_omp.py <uuid-or-.db-path> --cwd /path/to/project
```

Output: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`,
then `omp --resume <that-file>` (or `/resume <id-prefix>` in-session).

## Entry mapping

| transcript `type` | omp entry |
|---|---|
| `USER_INPUT` | `message` role `user`; strip `<USER_REQUEST>` wrapper |
| `PLANNER_RESPONSE` | `message` role `assistant` (`content`, else `thinking`) |
| `GENERIC` | `message` role `assistant` (`content`) |
| `CHECKPOINT` | `compaction` entry, `summary` = content |
| anything else | assistant text with `[TYPE]` prefix + stderr count |

IDs: 8-hex-char entry ids chained via `parentId`; header `version: 3`
with fresh UUID session id. Same provenance rule as opencode-import:
tool/output history stays **text**, never synthesized `toolCall` blocks.

## Limitations

- `brain/` logs may lag the `.db` for a live conversation; prefer idle ones.
- Assistant `GENERIC` rows mix prose and tool output; the converter keeps
  both as text (`--max-text-chars` truncates long ones).
- Workspace comes from `conversation_summaries.workspace_uris`; override
  with `--cwd` when it points elsewhere.
