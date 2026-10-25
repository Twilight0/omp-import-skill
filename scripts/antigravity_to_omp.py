#!/usr/bin/env python3
"""Antigravity brain transcript -> omp native session JSONL.

Reads (never writes):
  ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
  ~/.gemini/antigravity-cli/conversation_summaries.db   (title/workspace only)

Writes one file:
  ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
Resume it with:  omp --resume <file>
"""
import argparse
import json
import os
import re
import secrets
import sqlite3
import sys
import uuid
from datetime import datetime, timezone

BRAIN_ROOTS = [
    os.path.expanduser("~/.gemini/antigravity-cli/brain"),
    os.path.expanduser("~/.gemini/antigravity/brain"),
    os.path.expanduser("~/.gemini/Antigravity/brain"),
]
SUMMARY_DB = os.path.expanduser(
    "~/.gemini/antigravity-cli/conversation_summaries.db"
)
SESSIONS_ROOT = os.path.expanduser("~/.omp/agent/sessions")


def resolve_transcript(spec):
    """spec: conversation uuid, path to .db, or path to transcript jsonl."""
    if os.path.isfile(spec) and spec.endswith(".jsonl"):
        m = re.search(
            r"brain[\\/]([0-9a-f-]{36})[\\/]", spec.replace(os.sep, "/")
        )
        return spec, (m.group(1) if m else None)
    if spec.endswith(".db"):
        cid = os.path.basename(spec)[: -len(".db")]
    else:
        cid = spec
    for root in BRAIN_ROOTS:
        p = os.path.join(
            root, cid, ".system_generated", "logs", "transcript_full.jsonl"
        )
        if os.path.isfile(p):
            return p, cid
    raise FileNotFoundError(f"no brain transcript for {spec!r}")


def lookup_summary(cid):
    try:
        con = sqlite3.connect(f"file:{SUMMARY_DB}?mode=ro", uri=True)
        row = con.execute(
            "SELECT title, workspace_uris FROM conversation_summaries"
            " WHERE conversation_id = ?",
            (cid,),
        ).fetchone()
        con.close()
    except Exception:
        return None, None
    if not row:
        return None, None
    return row[0] or None, row[1] or None


def strip_user_wrapper(text):
    m = re.fullmatch(
        r"\s*<USER_REQUEST>\n?(.*?)\n?\s*(</USER_REQUEST>)?\s*$",
        text,
        re.DOTALL,
    )
    return m.group(1) if m else text


def entry_id():
    return secrets.token_hex(4)


def to_epoch_ms(iso):
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return int(datetime.now(timezone.utc).timestamp() * 1000)


def convert(transcript_path, cid, cwd, title, max_text_chars):
    entries = []
    leaf = None
    stats = {"user": 0, "assistant": 0, "compaction": 0, "unknown": 0}

    def append(etype, obj):
        nonlocal leaf
        eid = entry_id()
        obj.update(
            {
                "type": etype,
                "id": eid,
                "parentId": leaf,
                "timestamp": obj.get("timestamp")
                or datetime.now(timezone.utc).isoformat(),
            }
        )
        entries.append(obj)
        leaf = eid

    with open(transcript_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                step = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = step.get("type", "GENERIC")
            ts = step.get("created_at") or datetime.now(timezone.utc).isoformat()
            if t == "USER_INPUT":
                text = strip_user_wrapper(step.get("content", ""))
                if not text.strip():
                    continue
                append(
                    "message",
                    {
                        "timestamp": ts,
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": text}],
                            "timestamp": to_epoch_ms(ts),
                        },
                    },
                )
                stats["user"] += 1
            elif t in ("PLANNER_RESPONSE", "GENERIC"):
                text = step.get("content") or step.get("thinking") or ""
                if not text.strip():
                    continue
                if max_text_chars and len(text) > max_text_chars:
                    text = text[:max_text_chars] + "\n[…truncated]"
                append(
                    "message",
                    {
                        "timestamp": ts,
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": text}],
                            "timestamp": to_epoch_ms(ts),
                        },
                    },
                )
                stats["assistant"] += 1
            elif t == "CHECKPOINT":
                append(
                    "compaction",
                    {
                        "timestamp": ts,
                        "summary": step.get("content", ""),
                        "tokensBefore": 0,
                    },
                )
                stats["compaction"] += 1
            else:
                text = step.get("content") or step.get("thinking") or ""
                if text.strip():
                    append(
                        "message",
                        {
                            "timestamp": ts,
                            "message": {
                                "role": "assistant",
                                "content": [
                                    {
                                        "type": "text",
                                        "text": f"[{t}] {text}",
                                    }
                                ],
                                "timestamp": to_epoch_ms(ts),
                            },
                        },
                    )
                stats["unknown"] += 1
                print(f"warning: unmapped type {t}", file=sys.stderr)

    header = {
        "type": "session",
        "version": 3,
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cwd": cwd,
        "title": title or f"antigravity {cid[:8]}",
        "titleSource": "auto" if not title else "user",
        "parentSession": f"antigravity:{cid}",
    }
    return header, entries, stats


def bucket_for(cwd):
    home = os.path.expanduser("~")
    try:
        rel = os.path.relpath(cwd, home)
    except ValueError:
        rel = None
    if rel and not rel.startswith(".."):
        return "-" + rel.replace(os.sep, "-")
    return "--" + os.path.abspath(cwd).replace(os.sep, "-") + "--"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("conversation", help="uuid, .db path, or transcript path")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None, help="output .jsonl path")
    ap.add_argument("--max-text-chars", type=int, default=0,
                    help="truncate long assistant texts (0 = keep)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    tpath, cid = resolve_transcript(args.conversation)
    summary_title, _ws = lookup_summary(cid) if cid else (None, None)
    title = args.title or summary_title
    header, entries, stats = convert(
        tpath, cid or "?", os.path.abspath(args.cwd), title,
        args.max_text_chars,
    )
    print(f"transcript: {tpath}")
    print(f"entries: {len(entries)} " + json.dumps(stats))

    if args.dry_run:
        for e in entries[:2] + entries[-1:]:
            msg = e.get("message", {})
            body = (msg.get("content") or [{}])[0].get("text", "")[:120]
            print(f"  [{e['type']}/{msg.get('role', '-')}] {body!r}")
        return

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3] + "Z"
    out = args.out or os.path.join(
        SESSIONS_ROOT, bucket_for(os.path.abspath(args.cwd)),
        f"{stamp}_{header['id']}.jsonl",
    )
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        fh.write(json.dumps(header) + "\n")
        for e in entries:
            fh.write(json.dumps(e) + "\n")
    print(f"wrote: {out}")
    print(f"resume with: omp --resume {out}")


if __name__ == "__main__":
    main()
