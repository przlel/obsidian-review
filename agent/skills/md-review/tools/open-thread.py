#!/usr/bin/env python3
# Copyright 2026 Przemysław Lelakowski. SPDX-License-Identifier: Apache-2.0
"""Open an agent thread (question or proposal) on lines of a note, as the MD Review plugin expects.

Usage:
  open-thread.py <note.md> --block q20 --text "<question>" [--kind question|proposal]
  open-thread.py <note.md> --lines 12-14 --text "<question>" [--kind question|proposal]

<note.md> is an absolute path or a path relative to the current folder. The vault root is the
vault registered in Obsidian (`obsidian.json`) that contains the note, else the outermost
folder above the note that contains `.obsidian/`. `--block` anchors on the line that
ends with `^<id>`. The anchor is built like `buildAnchor` and `headingPaths` in the plugin's
`core.js`. The sidecar `<note>.review.json` is created when missing. A thread that is not
resolved and has the same anchor quote is never opened twice.

Needs Python 3.8 or newer and nothing outside the standard library.
"""
import argparse, datetime, json, os, re, secrets, sys


def registry_paths():
    """Where Obsidian keeps its list of vaults, per platform."""
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return [os.path.join(home, "Library", "Application Support", "obsidian", "obsidian.json")]
    if sys.platform.startswith("win"):
        return [os.path.join(os.environ.get("APPDATA", ""), "obsidian", "obsidian.json")]
    config = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return [os.path.join(config, "obsidian", "obsidian.json"),
            os.path.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
            os.path.join(home, "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json")]


def registered_vaults():
    for registry in registry_paths():
        try:
            return [v["path"] for v in json.load(open(registry, encoding="utf-8"))["vaults"].values()]
        except (OSError, ValueError, KeyError):
            continue
    return []


def vault_root(path):
    # A vault registered in Obsidian wins: a stray nested .obsidian/ folder must not shorten the path.
    path = os.path.abspath(path)
    inside = [v for v in registered_vaults() if path.startswith(v.rstrip("/\\") + os.sep)]
    if inside:
        return max(inside, key=len)
    found, d = None, os.path.dirname(path)
    while d != os.path.dirname(d):
        if os.path.isdir(os.path.join(d, ".obsidian")):
            found = d
        d = os.path.dirname(d)
    if not found:
        sys.exit(f"no Obsidian vault contains {path}")
    return found


def heading_paths(lines):
    stack, fence, paths = [], False, []
    for l in lines:
        if re.match(r"^\s*(```|~~~)", l):
            fence = not fence
        elif not fence:
            m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", l)
            if m:
                while stack and stack[-1][0] >= len(m.group(1)):
                    stack.pop()
                stack.append((len(m.group(1)), m.group(2)))
        paths.append(" > ".join(h for _, h in stack))
    return paths


def main():
    a = argparse.ArgumentParser(description="Open an MD Review agent thread on lines of a note.")
    a.add_argument("note")
    g = a.add_mutually_exclusive_group(required=True)
    g.add_argument("--block", help="block ID without the caret, e.g. q20")
    g.add_argument("--lines", help="1-based line or range, e.g. 12 or 12-14")
    a.add_argument("--text", required=True)
    a.add_argument("--kind", default="question", choices=["question", "proposal"])
    o = a.parse_args()

    note = os.path.abspath(o.note)
    lines = open(note, encoding="utf-8").read().split("\n")
    if o.block:
        hits = [i for i, l in enumerate(lines, 1) if l.rstrip().endswith("^" + o.block)]
        if len(hits) != 1:
            sys.exit(f"block ^{o.block}: {len(hits)} matches, expected 1")
        start = end = hits[0]
    else:
        start, end = (int(x) for x in o.lines.split("-")) if "-" in o.lines else (int(o.lines),) * 2
    if not 1 <= start <= end <= len(lines):
        sys.exit(f"lines {start}-{end} outside the note ({len(lines)} lines)")

    paths = heading_paths(lines)
    anchor = {"lineHint": start, "lineCount": end - start + 1,
              "quote": "\n".join(lines[start - 1:end]),
              "prefix": lines[start - 2] if start > 1 else "",
              "suffix": lines[end] if end < len(lines) else "",
              "section": paths[start - 1]}

    root = vault_root(note)
    sidecar = re.sub(r"\.md$", "", note) + ".review.json"
    rel = os.path.relpath(note, root).replace(os.sep, "/")
    d = json.load(open(sidecar, encoding="utf-8")) if os.path.exists(sidecar) \
        else {"version": 1, "note": rel, "comments": []}
    for c in d["comments"]:
        if c.get("state") != "resolved" and c["anchor"].get("quote") == anchor["quote"] \
                and c["thread"] and c["thread"][0].get("author") != "user":
            print(f"SKIP open agent thread {c['id']} already on line {start}")
            return

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    cid = "c_" + secrets.token_hex(4)
    d["comments"].append({"id": cid, "createdAt": now, "state": "open", "anchor": anchor,
                          "thread": [{"id": "m_" + secrets.token_hex(4), "author": "agent",
                                      "kind": o.kind, "at": now, "text": o.text}]})
    with open(sidecar, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    print(f"OPENED {cid} on line {start} ({anchor['section']})")


if __name__ == "__main__":
    main()
