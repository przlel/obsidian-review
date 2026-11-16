// Copyright 2026 Przemysław Lelakowski. SPDX-License-Identifier: Apache-2.0
// md-review core: pure functions shared by the plugin and the Node tests.
// Depends only on `diff_match_patch` (vendored, injected by build.sh).

const DMP = new diff_match_patch();
DMP.Diff_Timeout = 0.05;

// A changed quote is re-attached when its similarity reaches this value.
const FUZZY_THRESHOLD = 0.7;
// Lower bar for text rewritten in place between unchanged neighbour lines.
const IN_PLACE_THRESHOLD = 0.4;
// Lines around the last known position that the fuzzy search also checks.
const NEARBY_LINES = 60;
// Quotes with this many lines are pre-ranked by shared lines; only the best
// candidates get the character diff (a long quote diffed against every window
// took seconds and froze the editor).
const LINE_RANK_MIN_LINES = 3;
const MAX_DIFF_CANDIDATES = 8;

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function sidecarPath(notePath) { return notePath.replace(/\.md$/i, '') + '.review.json'; }
function notePathOfSidecar(path) { return path.replace(/\.review\.json$/i, '.md'); }
// Pasted images live in <note>.review-assets/ next to the note. The file name
// is unique in the vault (time + random suffix), so a bare-name embed
// ![[<name>]] resolves wherever the note and the folder move.
function assetsDir(notePath) { return notePath.replace(/\.md$/i, '') + '.review-assets'; }
const IMAGE_EXTS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/heic': 'heic' };
function imageExt(type, name) {
  if (IMAGE_EXTS[type]) return IMAGE_EXTS[type];
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : 'png';
}
function assetName(date, ext, suffix) {
  const p = n => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return `${day} ${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())} ${suffix}.${ext}`;
}
function emptyData(notePath) { return { version: 1, note: notePath, comments: [] }; }
function timeOf(iso) { const t = Date.parse(iso || ''); return isNaN(t) ? 0 : t; }

// Short stable hash (djb2, base 36) for ids derived from content.
function hashId(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const stripCr = t => typeof t === 'string' ? t.replace(/\r/g, '') : t;

function normalizeData(data, notePath) {
  if (!data || typeof data !== 'object') data = emptyData(notePath);
  if (!Array.isArray(data.comments)) data.comments = [];
  data.version = data.version || 1;
  data.note = data.note || notePath;
  // Missing ids are derived from the thread's time and position, so they stay
  // the same on every load and are written with the next save.
  const used = new Set();
  data.comments.forEach((c, ci) => {
    c.state = ['open', 'addressed', 'resolved'].includes(c.state) ? c.state : 'open';
    c.thread = Array.isArray(c.thread) ? c.thread : [];
    c.anchor = c.anchor || { lineHint: 1, lineCount: 1, quote: '', prefix: '', suffix: '', section: '' };
    // CodeMirror lines have no "\r"; an anchor written from a CRLF file would never match.
    for (const k of ['quote', 'prefix', 'suffix', 'selection']) c.anchor[k] = stripCr(c.anchor[k]);
    if (!c.id || used.has(c.id)) c.id = 'c_' + hashId(`${c.createdAt || ''}|${ci}|${c.anchor.quote || ''}`);
    used.add(c.id);
    c.thread.forEach((m, mi) => {
      if (!m.id || used.has(m.id)) m.id = 'm_' + hashId(`${c.id}|${m.at || ''}|${mi}`);
      used.add(m.id);
      // Any author other than "user" is the agent ("claude" in older files).
      m.author = m.author && m.author !== 'user' ? String(m.author) : 'user';
      m.text = m.text || '';
    });
  });
  return data;
}

// Heading path ("A > B > C") for every line; fenced code blocks are skipped.
function headingPaths(lines) {
  const paths = new Array(lines.length);
  const stack = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (/^\s*(```|~~~)/.test(t)) {
      fence = !fence;
    } else if (!fence) {
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
      if (m) {
        const level = m[1].length;
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, text: m[2] });
      }
    }
    paths[i] = stack.map(h => h.text).join(' > ');
  }
  return paths;
}

function windowText(lines, start, count) { return lines.slice(start - 1, start - 1 + count).join('\n'); }

function similarity(a, b) {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - DMP.diff_levenshtein(DMP.diff_main(a, b, false)) / max;
}

// Upper bound of similarity(): the edit distance is at least the length difference.
function lengthBound(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? Math.min(a.length, b.length) / max : 1;
}
function normLine(l) { return l.trim().replace(/\s+/g, ' '); }
// Dice coefficient of the two line multisets.
function lineDice(quoteBag, quoteCount, winLines) {
  const left = new Map(quoteBag);
  let shared = 0;
  for (const l of winLines) {
    const k = normLine(l), n = left.get(k);
    if (n) { shared++; left.set(k, n - 1); }
  }
  return (2 * shared) / (quoteCount + winLines.length);
}

function buildAnchor(lines, paths, start, end, selection) {
  const anchor = {
    lineHint: start,
    lineCount: end - start + 1,
    quote: windowText(lines, start, end - start + 1),
    prefix: start > 1 ? lines[start - 2] : '',
    suffix: end < lines.length ? lines[end] : '',
    section: paths[start - 1] || ''
  };
  if (selection) anchor.selection = selection;
  return anchor;
}

// Leaf heading of a path ("A > B" → "b"), normalized for comparison.
function leafOf(path) {
  const parts = (path || '').split(' > ');
  return normLine(parts[parts.length - 1] || '').toLowerCase();
}
// A renamed heading still counts as the same section when one leaf heading
// starts with the other ("Cache behaviour" → "Cache behaviour: accepted").
function sameSection(path, section) {
  if (path === section) return true;
  const a = leafOf(section), b = leafOf(path);
  // The shorter heading must end at a word boundary: "Step 1" is not "Step 12".
  const prefixOf = (x, y) => y.startsWith(x) && !/[\p{L}\p{N}]/u.test(y.charAt(x.length));
  return !!a && !!b && (a === b || prefixOf(a, b) || prefixOf(b, a));
}
// Whitespace- and padding-insensitive form of a text, for table rows that the
// table editor re-padded ("| a |" vs "| a   |", "|---|" vs "| --- |").
function loose(text) {
  return (text || '').replace(/-{3,}/g, '---').replace(/\s+/g, ' ').replace(/ ?\| ?/g, '|').trim();
}
// Last line of the block that Live Preview draws as one widget (a table or a
// callout) and that contains line n; n itself for any other line. A thread
// anchored inside such a block is drawn below it, because the block widget
// hides decorations placed inside it.
function blockEnd(lines, n) {
  const at = i => lines[i - 1] || '';
  const isRow = l => /^\s*\|/.test(l), isQuote = l => /^\s*>/.test(l);
  let end = n;
  if (isRow(at(n))) {
    while (end < lines.length && isRow(at(end + 1))) end++;
    return end;
  }
  if (isQuote(at(n))) {
    let start = n;
    while (start > 1 && isQuote(at(start - 1))) start--;
    if (!/^\s*>\s*\[!/.test(at(start))) return n;
    while (end < lines.length && isQuote(at(end + 1))) end++;
  }
  return end;
}
// First line after a YAML frontmatter block (1 when there is none). Obsidian
// draws frontmatter as the properties panel, so nothing may anchor there.
function bodyStart(lines) {
  if (lines[0] !== '---') return 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') return Math.min(i + 2, lines.length);
  }
  return 1;
}
// Block ID at the end of a line ("text ^q4" → "q4"), or null.
function blockId(line) {
  const m = /\s\^([A-Za-z0-9-]+)\s*$/.exec(line || '');
  return m ? m[1] : null;
}
function wordBag(text) {
  const bag = new Map();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w) bag.set(w, (bag.get(w) || 0) + 1);
  return bag;
}
// Dice coefficient of two word multisets; cheap pre-ranking for short quotes.
function bagDice(a, aCount, b) {
  let shared = 0, bCount = 0;
  for (const [w, n] of b) { bCount += n; shared += Math.min(n, a.get(w) || 0); }
  return aCount + bCount ? (2 * shared) / (aCount + bCount) : 0;
}

// Finds where a comment belongs in the current text. Order: same place →
// exact quote elsewhere (prefix/suffix/section break ties) → similar text in
// the same (possibly renamed) section or near the old place → similar text
// anywhere ("changed") → section heading, else the old line below the
// frontmatter ("outdated"). Line numbers are 1-based.
function resolveAnchor(anchor, lines, paths) {
  const quote = anchor.quote || '';
  const count = Math.max(1, anchor.lineCount || quote.split('\n').length);
  const total = lines.length;
  const hint = anchor.lineHint || 1;
  const fits = s => s >= 1 && s + count - 1 <= total;

  // The old place counts only when the line before or after it still matches:
  // a common line ("---", a table separator) may have moved away and been
  // replaced by an identical one.
  const before = s => (s > 1 ? lines[s - 2] : '') === (anchor.prefix || '');
  const after = s => (s + count - 1 < total ? lines[s - 1 + count] : '') === (anchor.suffix || '');
  if (fits(hint) && windowText(lines, hint, count) === quote && (before(hint) || after(hint))) {
    return { status: 'ok', start: hint, end: hint + count - 1 };
  }

  const first = quote.split('\n')[0];
  const exact = [];
  for (let s = 1; s + count - 1 <= total; s++) {
    if (lines[s - 1] === first && windowText(lines, s, count) === quote) exact.push(s);
  }
  if (exact.length) {
    const score = s =>
      (before(s) ? 2 : 0) +
      (after(s) ? 2 : 0) +
      (paths[s - 1] === anchor.section ? 1 : 0) -
      Math.abs(s - hint) / 1e6;
    exact.sort((a, b) => score(b) - score(a));
    return { status: 'ok', start: exact[0], end: exact[0] + count - 1 };
  }

  // Same text with other spacing: Obsidian's table editor pads every cell
  // and separator when the user clicks into a table.
  const lq = loose(quote);
  if (lq) {
    const lfirst = loose(first), near = [];
    for (let s = 1; s + count - 1 <= total; s++) {
      if (loose(lines[s - 1]) === lfirst && loose(windowText(lines, s, count)) === lq) near.push(s);
    }
    if (near.length) {
      near.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
      return { status: 'ok', start: near[0], end: near[0] + count - 1 };
    }
  }

  // An Obsidian block ID ("… ^q4") names one block of the note, so a quote
  // that carried one belongs to the line that carries it now, however much
  // the text around the ID changed.
  const changedAt = s => ({ status: 'changed', start: s, end: s + count - 1, current: windowText(lines, s, count) });
  const qlines = quote.split('\n');
  for (let k = 0; k < qlines.length; k++) {
    const id = blockId(qlines[k]);
    if (!id) continue;
    const hits = [];
    for (let i = 0; i < total; i++) if (blockId(lines[i]) === id) hits.push(i + 1);
    if (hits.length === 1 && fits(hits[0] - k)) return changedAt(hits[0] - k);
    break;
  }
  // Rewritten in place: the same number of lines still sits between the old
  // neighbours, and at least one neighbour is more than a blank line.
  const solid = (anchor.prefix || '').trim() || (anchor.suffix || '').trim();
  if (fits(hint) && solid && before(hint) && after(hint) &&
      similarity(quote, windowText(lines, hint, count)) >= IN_PLACE_THRESHOLD) return changedAt(hint);

  const ranked = count >= LINE_RANK_MIN_LINES;
  const bag = new Map();
  if (ranked) for (const l of quote.split('\n')) { const k = normLine(l); bag.set(k, (bag.get(k) || 0) + 1); }
  const words = wordBag(quote);
  // Word bags per line, built once: a window's bag merges its lines' bags.
  const lineBags = new Array(total);
  const windowBag = (s, size) => {
    const out = new Map();
    for (let i = s - 1; i < s - 1 + size; i++) {
      const b = lineBags[i] || (lineBags[i] = wordBag(lines[i]));
      for (const [w, n] of b) out.set(w, (out.get(w) || 0) + n);
    }
    return out;
  };
  let wordCount = 0; for (const n of words.values()) wordCount += n;
  const inSectionAt = s => sameSection(paths[s - 1], anchor.section);
  // local: the old section (or its renamed heading) and NEARBY_LINES around
  // the old place; global: the whole note, pre-ranked so only the best
  // candidates get the character diff.
  let wholeNote = true;
  const search = local => {
    let candidates = [];
    for (let s = 1; s <= total; s++) {
      const inSection = inSectionAt(s);
      if (local && !inSection && Math.abs(s - hint) > NEARBY_LINES) { wholeNote = false; continue; }
      for (const size of [count, count - 1, count + 1]) {
        if (size < 1 || s + size - 1 > total) continue;
        const text = windowText(lines, s, size);
        if (lengthBound(quote, text) < FUZZY_THRESHOLD) continue;
        const rank = ranked ? lineDice(bag, count, lines.slice(s - 1, s - 1 + size)) : bagDice(words, wordCount, windowBag(s, size));
        if ((ranked || !local) && rank === 0) continue;
        candidates.push({ start: s, size, text, inSection, rank });
      }
    }
    // Only the best-ranked candidates get the character diff; the local search
    // keeps more of them, because a short quote may share few words.
    candidates = candidates.sort((a, b) => b.rank - a.rank).slice(0, local && !ranked ? 3 * MAX_DIFF_CANDIDATES : MAX_DIFF_CANDIDATES);
    let best = null;
    for (const c of candidates) {
      const sim = similarity(quote, c.text) + (c.inSection ? 0.02 : 0);
      if (!best || sim > best.sim) best = { start: c.start, size: c.size, sim, text: c.text };
    }
    return best && best.sim >= FUZZY_THRESHOLD ? best : null;
  };
  // When the local search already covered every line (a note without
  // headings), the global search would repeat it.
  const best = search(true) || (wholeNote ? null : search(false));
  if (best) {
    return { status: 'changed', start: best.start, end: best.start + best.size - 1, current: best.text };
  }

  const body = bodyStart(lines);
  let at = 0;
  for (let i = body - 1; i < total && !at; i++) {
    if (paths[i] === anchor.section && /^#{1,6}\s/.test(lines[i])) at = i + 1;
  }
  for (let i = body - 1; i < total && !at; i++) {
    if (/^#{1,6}\s/.test(lines[i]) && sameSection(paths[i], anchor.section)) at = i + 1;
  }
  const where = at ? 'section' : 'line';
  if (!at) at = Math.max(body, Math.min(hint, total));
  return { status: 'outdated', start: at, end: at, where };
}

function resolveAll(data, text) {
  const lines = text.split('\n');
  const paths = headingPaths(lines);
  return data.comments.map(c => ({ c, r: resolveAnchor(c.anchor, lines, paths) }));
}

function diffParts(a, b) {
  const d = DMP.diff_main(a, b, false);
  DMP.diff_cleanupSemantic(d);
  return d.map(([op, text]) => ({ op: op === 1 ? 'ins' : op === -1 ? 'del' : 'eq', text }));
}

const KINDS = ['proposal', 'answer', 'done', 'question'];
function isAgent(m) { return !!m && m.author !== 'user'; }
// A thread the agent opened with its own question; drawn in the question colour.
function startedByAgent(c) { return isAgent(c.thread[0]); }
function lastAgentIndex(c) {
  for (let i = c.thread.length - 1; i >= 0; i--) if (isAgent(c.thread[i])) return i;
  return -1;
}
// Id of the agent's last message, '' when the agent has not written yet.
function lastAgentId(c) {
  const i = lastAgentIndex(c);
  return i >= 0 ? c.thread[i].id || '' : '';
}
// Kind of the agent's last message; messages without a kind count as proposals.
function agentKind(c) {
  const i = lastAgentIndex(c);
  if (i < 0) return null;
  return KINDS.includes(c.thread[i].kind) ? c.thread[i].kind : 'proposal';
}
// Whose move it is: 'resolved'; 'you' when the agent spoke last or marked the
// thread done; 'agent' when the user spoke last.
function turnOf(c) {
  if (c.state === 'resolved') return 'resolved';
  if (c.state === 'addressed') return 'you';
  return isAgent(c.thread[c.thread.length - 1]) ? 'you' : 'agent';
}
// The agent's unanswered proposal: the composer offers the Accept / Reject flags.
function needsVerdict(c) { return turnOf(c) === 'you' && c.state !== 'addressed' && agentKind(c) === 'proposal'; }
// The agent reports a change as done: the user checks it and resolves.
function needsCheck(c) { return turnOf(c) === 'you' && (c.state === 'addressed' || agentKind(c) === 'done'); }
function lastVerdict(c) {
  for (let i = c.thread.length - 1; i >= 0; i--) if (!isAgent(c.thread[i]) && c.thread[i].verdict) return c.thread[i].verdict;
  return null;
}
// Resolved with "Send & Resolve" on Accept: the agent still applies the change
// and keeps the thread resolved.
function pendingApply(c) {
  const last = c.thread[c.thread.length - 1];
  return c.state === 'resolved' && !!last && !isAgent(last) && last.verdict === 'accept' && !!last.resolveAfterApply;
}
// One line about the next step, shown in the thread and on the panel card.
function nextStep(c, agent) {
  const t = turnOf(c);
  if (t === 'resolved') return pendingApply(c) ? `Resolved — ${agent} applies the accepted change` : 'Resolved';
  if (t === 'agent') {
    const last = c.thread[c.thread.length - 1], v = last.verdict;
    if (v === 'accept') return `Accepted — ${agent} applies it` + (last.resolveAfterApply ? ', then resolves' : '');
    if (v === 'reject') return `Rejected — ${agent} reads the reason`;
    return `Waiting for ${agent}`;
  }
  if (needsCheck(c)) return 'Check the change, then resolve';
  if (needsVerdict(c)) return 'Proposal — accept, reject or reply';
  if (agentKind(c) === 'question') return `Question from ${agent} — answer it`;
  return 'Answered — reply or resolve';
}
function isUnread(c) {
  const i = lastAgentIndex(c);
  return i >= 0 && timeOf(c.thread[i].at) > timeOf(c.readAt);
}
// open: not resolved; fresh: unread agent replies; mine: threads waiting for the user.
function countOpen(data) {
  let open = 0, fresh = 0, mine = 0;
  for (const c of data.comments) {
    if (c.state === 'resolved') continue;
    open++;
    if (isUnread(c)) fresh++;
    if (turnOf(c) === 'you') mine++;
  }
  return { open, fresh, mine };
}
