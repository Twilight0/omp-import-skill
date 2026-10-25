#!/usr/bin/env python3
"""Muse session.jsonl -> omp native session JSONL.

Reads (never writes):
  ~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl
  ~/.local/share/muse/session-index.db   (list + title/workspace only)

Event mapping (sequence order):
  run/started with prompt              -> user message
  run/assistant_message_committed       -> assistant message (text)
  run/assistant_tool_calls_committed    -> assistant text: [muse tool call: ...]
  run/tool_result_batch_committed       -> assistant text: result bodies
  run/reasoning_committed               -> skipped (content is encrypted)
  task/output chunks                    -> skipped (duplicates tool results)
  everything else                       -> skipped + counted

Tool history stays text, never synthesized toolCall blocks.
"""
import argparse
import json
import os
import secrets
import sqlite3
import sys
import uuid
from datetime import datetime, timezone

DATA_ROOT = os.path.expanduser("~/.local/share/muse/sessions")
INDEX_DB = os.path.expanduser("~/.local/share/muse/session-index.db")
SESSIONS_ROOT = os.path.expanduser("~/.omp/agent/sessions")


def list_sessions(limit=50):
    con = sqlite3.connect(f"file:{INDEX_DB}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT session_id, title, workspace_root, prompt_count, status,"
        " datetime(updated_at_us/1000000,'unixepoch'), session_log_path"
        " FROM sessions ORDER BY updated_at_us DESC LIMIT ?",
        (limit,),
    ).fetchall()
    con.close()
    return rows


def resolve_log(spec):
    if os.path.isfile(spec):
        return spec, None
    con = sqlite3.connect(f"file:{INDEX_DB}?mode=ro", uri=True)
    row = con.execute(
        "SELECT session_log_path, title, workspace_root FROM sessions"
        " WHERE session_id = ?",
        (spec,),
    ).fetchone()
    con.close()
    if not row:
        raise FileNotFoundError(f"no muse session {spec!r}")
    return row[0], {"title": row[1], "cwd": row[2]}


def entry_id():
    return secrets.token_hex(4)


def to_iso(us):
    try:
        return datetime.fromtimestamp(us / 1_000_000, timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def to_epoch_ms(us):
    try:
        return int(us / 1000)
    except Exception:
        return int(datetime.now(timezone.utc).timestamp() * 1000)


def convert(log_path, meta, cwd, title, max_text_chars):
    entries = []
    leaf = None
    stats = {"user": 0, "assistant": 0, "tool": 0, "results": 0, "skipped": 0}

    def append(etype, obj):
        nonlocal leaf
        eid = entry_id()
        entries.append({**obj, "type": etype, "id": eid,
                        "parentId": leaf, "timestamp": obj.get("timestamp")})
        leaf = eid

    def text_block(text):
        if max_text_chars and len(text) > max_text_chars:
            text = text[:max_text_chars] + "\n[…truncated]"
        return {"role": "assistant", "content": [{"type": "text", "text": text}]}

    with open(log_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["skipped"] += 1
                continue
            payload = rec.get("payload")
            if not isinstance(payload, dict):
                stats["skipped"] += 1
                continue
            kind = payload.get("kind")
            event = payload.get("event")
            if not isinstance(event, dict):
                stats["skipped"] += 1
                continue
            ekind = event.get("kind")
            ts = to_iso(rec.get("recorded_at", 0))
            ms = to_epoch_ms(rec.get("recorded_at", 0))

            if kind == "run" and ekind == "started" and event.get("prompt"):
                text = event["prompt"].strip()
                if not text:
                    stats["skipped"] += 1
                    continue
                append("message", {"timestamp": ts, "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": text}],
                    "timestamp": ms}})
                stats["user"] += 1
            elif kind == "run" and ekind == "assistant_message_committed":
                text = (event.get("text") or "").strip()
                if not text:
                    stats["skipped"] += 1
                    continue
                msg = text_block(text)
                msg["timestamp"] = ms
                append("message", {"timestamp": ts, "message": msg})
                stats["assistant"] += 1
            elif kind == "run" and ekind == "assistant_tool_calls_committed":
                calls = event.get("tool_calls") or []
                if not calls:
                    stats["skipped"] += 1
                    continue
                for call in calls:
                    name = call.get("name", "unknown")
                    args = call.get("args", "")
                    cid = call.get("call_id", "unknown")
                    msg = text_block(
                        f"[muse tool call: {name} id={cid}]\nargs: {args}")
                    msg["timestamp"] = ms
                    append("message", {"timestamp": ts, "message": msg})
                    stats["tool"] += 1
            elif kind == "run" and ekind == "tool_result_batch_committed":
                results = event.get("results") or []
                if not results:
                    stats["skipped"] += 1
                    continue
                for res in results:
                    text = (res.get("text") or "").strip()
                    if not text:
                        continue
                    msg = text_block(text)
                    msg["timestamp"] = ms
                    append("message", {"timestamp": ts, "message": msg})
                    stats["results"] += 1
            else:
                stats["skipped"] += 1

    header = {
        "type": "session",
        "version": 3,
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cwd": os.path.abspath(cwd or (meta or {}).get("cwd") or os.getcwd()),
        "title": title or (meta or {}).get("title") or "muse session",
        "titleSource": "user" if title else "auto",
        "parentSession": f"muse:{os.path.basename(os.path.dirname(log_path))}",
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
    ap.add_argument("session", nargs="?", help="muse uuid or session.jsonl path")
    ap.add_argument("--list", action="store_true", help="list muse sessions")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--max-text-chars", type=int, default=8000,
                    help="truncate long texts (0 = keep)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.list or not args.session:
        for sid, title, ws, prompts, status, updated, _path in list_sessions(args.limit):
            print(f"{(title or sid)[:60]} · {status} · {updated} ·"
                  f" {prompts} prompts · {ws} · {sid}")
        return

    log_path, meta = resolve_log(args.session)
    header, entries, stats = convert(log_path, meta, args.cwd, args.title,
                                     args.max_text_chars)
    print(f"transcript: {log_path}")
    print(f"entries: {len(entries)} " + json.dumps(stats))

    if args.dry_run:
        for e in entries[:3] + entries[-1:]:
            msg = e.get("message", {})
            body = (msg.get("content") or [{}])[0].get("text", "")[:120]
            print(f"  [{e['type']}/{msg.get('role', '-')}] {body!r}")
        return

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3] + "Z"
    out = args.out or os.path.join(
        SESSIONS_ROOT, bucket_for(header["cwd"]),
        f"{stamp}_{header['id']}.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        fh.write(json.dumps(header) + "\n")
        for e in entries:
            fh.write(json.dumps(e) + "\n")
    print(f"wrote: {out}")
    print(f"resume with: omp --resume {out}")


if __name__ == "__main__":
    main()
