---
name: md-review
description: Process review comments the user left on a Markdown note with the Obsidian "MD Review" plugin (stored in <note>.review.json next to the note) - answer in the threads, apply accepted changes, mark them addressed. Use when the user says "read the review of", "answer the review comments", "check the comments on the note", or pastes the plugin's "Copy prompt" text. Also use it to open question threads whenever a note you wrote holds questions the user must answer.
---

# MD Review — answer review comments

The user reviews notes in Obsidian with the plugin "MD Review". Comments for
`<note>.md` live in `<note>.review.json` in the same folder. The plugin watches that
file, so replies you write appear in Obsidian within seconds.

The full file format and rules are in `PROTOCOL.md` in this skill's folder. Read it
before the first write in a session.

## Step 1: Locate the files

- The user names a note, or pastes the plugin prompt:
  `Answer the review comments on "<note path>" (threads in "<sidecar path>") ...`.
  Paths in the prompt are relative to the vault root.
- The vault root is the folder that contains `.obsidian/`. When the paths do not
  resolve from the current folder, walk up from it until you find `.obsidian/`, or
  ask the user for the vault path.
- Without a note name, list sidecars in the vault:
  ```bash
  find "<vault>" -name "*.review.json" -not -path "*/.obsidian/*"
  ```
  and ask which note to process if there is more than one with open threads.

## Step 2: Read the protocol, the note and the sidecar

1. Read `PROTOCOL.md` (this skill's folder).
2. Read the note and its `.review.json`.
3. For each comment find its current lines by `anchor.quote` (`lineHint` may be
   stale). Skip comments with `state: "resolved"`, except one whose last message
   is a user `accept` with `resolveAfterApply: true` (the user clicked "Send &
   Resolve"): that change still needs applying.
4. Read every image a message embeds as `![[<file name>]]` before you answer that
   message: the user pastes screenshots as part of the comment. The file is
   `<note folder>/<note name>.review-assets/<file name>`; when it is not there, find
   it with `find "<vault>" -name "<file name>"`.

## Step 3: Decide what each thread needs

- Last message from the user → it needs an answer.
- A user message with `editedAt` later than your last reply → answer again.
- Verdicts on your last proposal (a verdict message may also carry a comment;
  apply what the comment adds):
  - `accept` → apply the change to the note, append a `kind: "done"` message
    "Done: …", set `state` to `addressed`; when the accept message has
    `resolveAfterApply: true`, set or keep `state` `resolved` instead and list the
    thread as resolved in the report;
  - `reject` → leave the note unchanged; reply (`kind: "answer"`) only if the
    reason asks something;
  - no verdict (or legacy `discuss`) → answer; propose a concrete change if one
    follows.
- A plain comment that asks for a change explicitly → apply it, reply with
  `kind: "done"` and set `addressed`. Otherwise reply with `kind: "answer"` or
  `kind: "proposal"` and wait for a verdict.
- A user message made of `> ` quote blocks, each followed by the user's text,
  answers several points of an earlier message. Treat each quote block with the
  text under it as a separate answer, and reply point by point in the same order:
  one paragraph per quote, starting with the point number in bold (`**2.**`).
  A quote with no text under it is a point the user did not answer yet.

## Step 4: Write the replies

1. Re-read the `.review.json` right before writing (the plugin writes the same
   file) and change only the threads you answer.
2. Append messages: `{"id": "m_<random>", "author": "agent", "kind": "proposal|answer|done|question", "at": "<UTC ISO with Z>", "text": "..."}`.
   `kind` is required: it decides the user's buttons (Accept / Reject under a
   proposal, "Looks good — Resolve" under done).
3. Never edit or delete user messages, never set `resolved` (except for an
   applied accept with `resolveAfterApply: true`), never change
   `anchor.quote`. Keep the JSON valid, 2-space indented.
4. When an applied change moves the commented lines or renames their heading,
   set `anchor.lineHint` to the new first line and `anchor.section` to the new
   heading path ("A > B") in the same write; keep `anchor.quote` as it was.
5. Write the reply in the language of the user's comment. The plugin renders
   replies as Markdown in the context of the note, so wikilinks such as
   `[[#^k36|K36]]` work inside a thread.
6. Write a reply with several points as a Markdown numbered list: `1. **Title.**`,
   with its sub-points as a bullet list indented by 3 spaces under it. The user
   answers by quoting a point with the plugin's quote button, and the quote then
   carries the point number.

A safe way to append, with Python's standard library:
```bash
python3 - <<'EOF'
import json, datetime, secrets
p = "<vault>/<folder>/<note>.review.json"
d = json.load(open(p, encoding="utf-8"))
c = next(x for x in d["comments"] if x["id"] == "<comment id>")
c["thread"].append({"id": "m_" + secrets.token_hex(4), "author": "agent", "kind": "<proposal|answer|done>",
  "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
  "text": "<reply>"})
# c["state"] = "addressed"   # only with kind "done", after applying a change
open(p, "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
EOF
```

## Step 5: Ask your own questions in new threads

When you need the user's answer about the note (an open point, a missing
decision, an unclear requirement), open your own thread on the lines it is
about, one question per thread. Do not write the question into the note and do
not ask it only in the conversation. A question about the whole note goes on its
first heading. Rules: `PROTOCOL.md`, section "Threads opened by the agent".

Open each thread with the script in this skill's folder, right after you last read
the sidecar. It builds the anchor the same way as the plugin, creates the sidecar when
the note has none yet, and never opens a second agent thread on the same lines while
the first is not resolved.
```bash
python3 "<this skill's folder>/tools/open-thread.py" "<full path to note.md>" \
  --block q20 --kind question --text "<question>"
# or --lines 12-14 for lines without a block ID; --kind proposal when you want Accept / Reject
```

## Step 6: Report

Tell the user in the conversation: which threads you answered, which changes you
applied to the note (with line references), which proposals wait for a verdict and
which questions you opened. The plugin shows the replies without a reload.

## Example

User: "read the review of Projects/Team offsite plan".

1. Files: `Projects/Team offsite plan.md` and `Projects/Team offsite plan.review.json`.
2. Comment `c_…` on lines 12–14 asks "Why two days and not three?" — no verdict,
   no explicit change request → reply with the reasoning and a proposal.
3. Comment `c_…` with a user `accept` under your proposal → edit the note,
   append "Done: …", set `addressed`.
4. Report both threads to the user.

## Edge cases

- **Broken JSON**: the plugin refuses to overwrite it. Fix the JSON syntax only if
  the intent is obvious; otherwise tell the user what is broken.
- **Quote not found** (the lines changed or were deleted): answer anyway; mention
  that the commented text is no longer in the note.
- **User asks you to close a thread**: then setting `resolved` is allowed for that
  thread; say so in the report.
