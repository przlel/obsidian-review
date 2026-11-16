# MD Review — protocol for the agent

The Obsidian plugin "MD Review" stores review comments for `<note>.md` in
`<note>.review.json` next to the note. The user writes comments in Obsidian;
the agent (Claude, Codex or any other) reads the file, replies in the threads and
edits the note. The plugin watches the file and shows the replies within seconds.
It shows every author other than "user" as the agent, under the name from its
settings.

## File format

```json
{
  "version": 1,
  "note": "projects/plans/Plan-X.md",
  "comments": [
    {
      "id": "c_…",
      "createdAt": "2026-10-08T19:40:00.000Z",
      "state": "open | addressed | resolved",
      "readAt": "2026-10-08T19:41:00.000Z",
      "anchor": {
        "lineHint": 58, "lineCount": 3,
        "quote": "exact text of the commented lines",
        "prefix": "line before", "suffix": "line after",
        "section": "Plan > 2. Decisions (summary)",
        "selection": "optional: the exact selected text"
      },
      "thread": [
        { "id": "m_…", "author": "user", "at": "…Z", "text": "question" },
        { "id": "m_…", "author": "agent", "kind": "proposal | answer | done | question", "at": "…Z", "text": "reply" },
        { "id": "m_…", "author": "user", "at": "…Z", "text": "optional comment", "verdict": "accept | reject", "resolveAfterApply": true }
      ]
    }
  ]
}
```

### Pasted images

The user can paste (⌘V) or drop an image into a comment, a reply or an edited
message. The plugin saves it to `<note>.review-assets/` next to the note and puts
`![[<file name>]]` into the message text. The file name is
`YYYY-MM-DD HH-mm-ss <4 random chars>.<ext>`, unique in the vault, so the embed
uses the bare name and keeps working after the note moves or is renamed. The
folder follows its note: the plugin moves it on a rename in Obsidian. The agent reads each embedded image before it answers the
message. Removing an embed from a message does not delete the image file.

### Quote replies

The user answers single points of a message with quotes. Every list item of a
message (nested ones too) and every paragraph that starts with a number ("1.",
"2)") has a "❝ quote" button on hover; a numbered paragraph quotes itself with
the bullet lists under it. A text selection in a message shows a "❝ Quote"
button. Both append the point or the selection to the reply box as a `> ` quote
and an empty line, and the user writes the answer under it. The quote carries
the point number, with the parent point first for a sub-point: `> 1. › Context: …`. One reply can hold several quotes. The
format of `.review.json` does not change: the quotes are plain Markdown in
`text`. The agent answers each quote block separately, in the same order.

## Turns and message kinds

The plugin computes whose move it is; nothing stores it:

- **Agent's turn**: the last message is from the user (a question, a reply, or a
  verdict with an optional comment). The agent must act.
- **Your turn** (the user's): the last message is from the agent, or the state is
  `addressed`.
- **Resolved**: `state: "resolved"`. The user resolves. The agent skips resolved
  threads, except one whose last message is a user `accept` with
  `resolveAfterApply: true`: the agent still applies that change.

Every agent message carries `kind`, which decides the user's buttons:

- `proposal` — the agent proposes a change and waits for a verdict. The user sees
  the Accept / Reject flags.
- `answer` — the agent answers or explains; no change is proposed.
- `done` — the agent applied a change. Set `state` to `addressed` with it. The
  user checks the note and resolves, or replies to reopen.
- `question` — the agent asks the user something and waits for the answer.
  No change is proposed; the user replies in the thread.

Messages without `kind` (older files) count as `proposal`. Older files use
`author: "claude"`; both forms stay valid.

User verdicts: `accept` or `reject`, with an optional comment in `text`. The
plugin's "Send & Resolve" button sets `resolved` at once for every message. On an
`accept` message it also adds `resolveAfterApply: true`: the agent must still
apply the change. Older files may hold such a message in an
`open` thread. A user
message without a verdict is discussion. Older files may contain
`verdict: "discuss"`; treat it as discussion.

## How the agent processes a review

1. Read the note and its `.review.json`. Find each comment's lines by `quote`
   (the `lineHint` may be stale). Skip `resolved` comments, except one whose last
   message is a user `accept` with `resolveAfterApply: true`.
2. A comment needs work when its last message is from the user. A user message
   with `editedAt` later than the agent's last reply also needs work: the user
   changed the text after the answer. Deleted threads are simply gone.
3. Verdicts on the agent's last proposal:
   - `accept` → apply the change (and anything the comment adds), then append a
     `kind: "done"` message ("Done: …") and set `state` to `addressed`. When the
     accept message has `resolveAfterApply: true`, set or keep `state`
     `resolved` instead.
   - `reject` → do not change the note; read the optional reason; reply with
     `kind: "answer"` only if the reason asks something or needs a follow-up.
   - no verdict → answer the text; propose a concrete change if one follows.
4. A plain user comment → answer it. A change proposal is `kind: "proposal"`; wait
   for a verdict. Apply a change right away only when the comment explicitly asks
   for it; then reply with `kind: "done"` and set `addressed`.
5. Write rules:
   - Re-read the JSON right before writing and change only the threads you
     answer (the plugin writes the same file).
   - Append messages; never edit or delete user messages.
   - `author: "agent"` (or the agent's own lowercase name, e.g. `"claude"`),
     `kind` always set, `at`: current UTC time in ISO format with `Z`,
     `id`: `m_` + a short random string.
   - Never set `resolved`, except after applying an accept message with
     `resolveAfterApply: true`. Use `addressed` after any other change.
   - Do not touch `anchor.quote`: the plugin shows the old text as a diff when
     the lines change.
   - When your edit moves commented lines or renames their heading, update
     `anchor.lineHint` (the new first line) and `anchor.section` (the new
     heading path, "A > B") in the same write. Without it the plugin may not
     find the lines and shows the comment as outdated (for example, a
     section renamed and moved far down loses its comment).
   - Keep the JSON valid and 2-space indented; the plugin refuses to overwrite a
     broken file.
   - Write `anchor.quote`, `prefix` and `suffix` with LF line ends (`\n`), never
     CRLF. Give every comment and message an `id`; the plugin fills in a missing
     one and saves it with its next write.
6. Report in the conversation: which threads were answered, which changes were
   applied, which proposals wait for a verdict, which questions the agent opened.

## Threads opened by the agent

When the agent needs the user's answer about the note, it opens its own thread
on the lines the question is about. It does not write the question into the note
text and does not ask it only in the conversation. The plugin draws a thread
whose first message is from the agent in the "Agent question colour" (setting,
default blue), with the header "❓ <agent> asks". The turn is computed as usual:
the agent spoke last, so the thread is "Your turn" at once and counts as new.

- One question per thread. Anchor it on the lines it is about. A question about
  the whole note goes on its first heading.
- The first message has `kind: "question"`, or `kind: "proposal"` when the agent
  proposes a concrete change and wants Accept / Reject.
- The comment gets `id` `c_` + a short random string, `createdAt` (now, UTC with
  `Z`), `state: "open"` and no `readAt`. Without `readAt` the plugin shows it as
  new.
- The anchor must match the note exactly: `lineHint` (1-based first line),
  `lineCount`, `quote` (those lines joined with `\n`), `prefix` (the line
  before, or `""`), `suffix` (the line after, or `""`), `section` (the heading
  path "A > B" of the first line; headings inside fenced code do not count).
  `tools/open-thread.py` next to this file builds it.
- Append the comment to `comments`; never reorder or rewrite other comments.
- The agent's own thread follows the same rules afterwards: the user answers,
  the agent replies, only the user resolves.
