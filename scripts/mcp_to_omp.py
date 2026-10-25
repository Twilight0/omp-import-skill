#!/usr/bin/env python3
"""Import foreign MCP server definitions into omp's native mcp.json.

Reads (never writes):
  ~/.config/muse/settings.json            (muse-code mcpServers)
  ~/.gemini/mcp_config.json                (gemini mcpServers map)

Writes (with timestamped backup):
  ~/.omp/agent/mcp.json                    (or --out)

Already covered by omp's own discovery — left alone, reported as such:
  opencode.json, codex config.toml, gemini settings.json, claude,
  cursor, windsurf, vscode, root mcp.json fallbacks.
Anthropic IDE note: Antigravity stores no file-based MCP config that was
found (checked ~/.config/Antigravity); nothing to import there.

Merge rule: add names missing from the target; never modify or delete
existing entries. Muse `enabled: false` is preserved as omp `enabled: false`.
"""
import argparse
import copy
import datetime
import json
import os
import sys

MUSE_SETTINGS = os.path.expanduser("~/.config/muse/settings.json")
GEMINI_MCP = os.path.expanduser("~/.gemini/mcp_config.json")
DEFAULT_OUT = os.path.expanduser("~/.omp/agent/mcp.json")
SCHEMA_URL = ("https://raw.githubusercontent.com/can1357/oh-my-pi/main"
              "/packages/coding-agent/src/config/mcp-schema.json")

AUTO_COVERED = ["opencode", "codex", "gemini-settings", "claude", "cursor",
                "windsurf", "vscode"]


def load_json(path):
    with open(path) as fh:
        return json.load(fh)


def map_muse_server(defn):
    """Muse {mode, transport, command, args, env, url, headers, enabled} -> omp."""
    if not isinstance(defn, dict):
        return None
    out = {}
    transport = defn.get("transport", "stdio")
    if transport == "stdio":
        if not defn.get("command"):
            return None
        out["command"] = defn["command"]
        if isinstance(defn.get("args"), list):
            out["args"] = defn["args"]
        if isinstance(defn.get("env"), dict):
            out["env"] = {k: str(v) for k, v in defn["env"].items()}
    elif transport in ("streamable_http", "http"):
        if not defn.get("url"):
            return None
        out["type"] = "http"
        out["url"] = defn["url"]
    elif transport == "sse":
        if not defn.get("url"):
            return None
        out["type"] = "sse"
        out["url"] = defn["url"]
    else:
        return None
    if isinstance(defn.get("headers"), dict):
        out["headers"] = {k: str(v) for k, v in defn["headers"].items()}
    if defn.get("enabled") is False:
        out["enabled"] = False
    return out


def map_generic_server(defn):
    """Best-effort {command,...}/{url,...} -> omp entry."""
    if not isinstance(defn, dict):
        return None
    if defn.get("command"):
        out = {"command": defn["command"]}
        for key in ("args", "env", "cwd", "timeout", "enabled", "headers"):
            if defn.get(key) is not None:
                out[key] = defn[key]
        return out
    if defn.get("url"):
        out = {"type": defn.get("type", "http"), "url": defn["url"]}
        for key in ("headers", "timeout", "enabled"):
            if defn.get(key) is not None:
                out[key] = defn[key]
        return out
    return None


def collect(source):
    """Return {name: omp_entry} for one source, skipping unmappable."""
    if source == "muse":
        data = load_json(MUSE_SETTINGS).get("mcpServers", {})
        return {n: m for n, m in
                ((n, map_muse_server(d)) for n, d in data.items()) if m}
    if source == "gemini-mcp":
        data = load_json(GEMINI_MCP).get("mcpServers", {})
        return {n: m for n, m in
                ((n, map_generic_server(d)) for n, d in data.items()) if m}
    raise ValueError(f"unknown source {source!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", action="append",
                    choices=["muse", "gemini-mcp"],
                    help="repeatable; default: all")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--include-disabled", action="store_true",
                    help="also import entries the source has disabled")
    args = ap.parse_args()

    sources = args.source or ["muse", "gemini-mcp"]
    wanted = {}
    for source in sources:
        try:
            for name, entry in collect(source).items():
                wanted.setdefault(name, (source, entry))
        except FileNotFoundError as exc:
            print(f"skip {source}: {exc}", file=sys.stderr)
    if os.path.isfile(args.out):
        target = load_json(args.out)
    else:
        target = {"$schema": SCHEMA_URL, "mcpServers": {}}
    target.setdefault("mcpServers", {})
    existing = target["mcpServers"]

    added, skipped = [], []
    for name, (source, entry) in wanted.items():
        if name in existing:
            skipped.append(f"{name} (already in target, from {source})")
        elif entry.get("enabled") is False and not args.include_disabled:
            skipped.append(f"{name} (disabled in {source}; use --include-disabled)")
        else:
            added.append((name, source, entry))

    print(f"already covered by omp discovery (no action): "
          f"{', '.join(AUTO_COVERED)}")
    print(f"planned adds: {len(added)}, skipped: {len(skipped)}")
    for name, source, _entry in added:
        print(f"  + {name} (from {source})")
    for line in skipped:
        print(f"  = {line}")

    if args.dry_run or not added:
        return
    if os.path.isfile(args.out):
        backup = f"{args.out}.bak.{datetime.datetime.now().strftime('%Y%m%dT%H%M%S')}"
        with open(backup, "w") as fh:
            json.dump(load_json(args.out), fh, indent=2)
            fh.write("\n")
        print(f"backup: {backup}")

    merged = copy.deepcopy(target)
    for name, _source, entry in added:
        merged["mcpServers"][name] = entry
    with open(args.out, "w") as fh:
        json.dump(merged, fh, indent=2)
        fh.write("\n")
    print(f"wrote: {args.out} ({len(merged['mcpServers'])} servers)")
    print("reload with /mcp reload (session restart also works)")


if __name__ == "__main__":
    main()
