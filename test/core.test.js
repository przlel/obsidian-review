// Run: node test/core.test.js  (after ./build.sh, which writes dist/main.js)
const Module = require('module');
const path = require('path');
const assert = require('assert');
const stub = { Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, MarkdownView: class {}, Setting: class {},
  StateField: { define: () => ({}) }, StateEffect: { define: () => ({ of: v => v }) }, EditorState: {},
  EditorView: {}, Decoration: {}, WidgetType: class {}, GutterMarker: class {}, gutter: () => ({}), showTooltip: {} };
const orig = Module._load;
Module._load = function (req, ...rest) { return ['obsidian', '@codemirror/state', '@codemirror/view'].includes(req) ? stub : orig.call(this, req, ...rest); };
const main = require(path.join(__dirname, '../dist/main.js'));
const { resolveAnchor, headingPaths, buildAnchor, countOpen, isUnread, needsVerdict, needsCheck, turnOf, startedByAgent, lastVerdict, pendingApply, nextStep, normalizeData, diffParts, sidecarPath, assetsDir, imageExt, assetName, blockEnd, lastAgentId } = main.core;

const doc = [
  '# Plan', '', '## 1. Goal', 'Alpha line one.', 'Alpha line two.', '',
  '## 2. Decisions', '- Size limits per upload and per user account.', '  (note N7). Start values: 4,000 kilobytes.', '- (note N7)', '- Other point.', '- (note N7)', ''
];
const P = headingPaths(doc);
const anchorAt = (s, e) => buildAnchor(doc, P, s, e);
let passed = 0; const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

t('heading paths', () => { assert.strictEqual(P[3], 'Plan > 1. Goal'); assert.strictEqual(P[7], 'Plan > 2. Decisions'); });
t('same place', () => { const r = resolveAnchor(anchorAt(8, 9), doc, P); assert.deepStrictEqual([r.status, r.start, r.end], ['ok', 8, 9]); });
t('moved down after insertion above', () => {
  const a = anchorAt(8, 9); const d2 = doc.slice(0, 3).concat(['New 1', 'New 2', 'New 3'], doc.slice(3));
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start, r.end], ['ok', 11, 12]);
});
t('moved up after deletion above', () => {
  const a = anchorAt(8, 9); const d2 = doc.slice(0, 3).concat(doc.slice(5));
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start], ['ok', 6]);
});
t('duplicate line picked by prefix/suffix', () => {
  const a = anchorAt(12, 12); const d2 = ['Intro'].concat(doc);
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.strictEqual(r.start, 13);
  const a2 = anchorAt(10, 10); const r2 = resolveAnchor(a2, d2, headingPaths(d2)); assert.strictEqual(r2.start, 11);
});
t('changed text found by similarity', () => {
  const a = anchorAt(8, 9); const d2 = doc.slice(); d2[8] = '  (note N7). Start values: 3,000 kilobytes.';
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start, r.end], ['changed', 8, 9]);
  const diff = diffParts(a.quote, r.current); assert.ok(diff.some(p => p.op === 'del' && p.text.includes('4')) && diff.some(p => p.op === 'ins' && p.text.includes('3')));
});
t('changed and moved', () => {
  const a = anchorAt(8, 9); const d2 = doc.slice(); d2[7] = '- Size limits per upload and per whole user account.'; const d3 = ['x', 'y'].concat(d2);
  const r = resolveAnchor(a, d3, headingPaths(d3)); assert.deepStrictEqual([r.status, r.start], ['changed', 10]);
});
t('outdated after deletion falls back to section heading', () => {
  const a = anchorAt(8, 9); const d2 = doc.slice(0, 7).concat(['- Completely different content here.', ''], doc.slice(9, 9));
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start], ['outdated', 7]);
});
t('outdated without section falls back to the old line, clamped', () => {
  const a = anchorAt(4, 5); const d2 = ['# Other', 'Nothing alike.'];
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start, r.where], ['outdated', 2, 'line']);
});
t('outdated never lands in the frontmatter', () => {
  const a = anchorAt(1, 1); const d2 = ['---', 'project: x', 'tags: []', '---', '', '# Other', 'Nothing alike.'];
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start], ['outdated', 5]);
});
// Regression: the agent renamed the heading, reworded the paragraph
// and moved the section far down.
const cacheText = ['### Cache behaviour', '', 'Search results differ because the edge cache keeps its own copy. Entries expire after ten minutes. Sample checks: hits 412 = 412, misses 37 = 37.', ''];
const checkDoc = ['---', 'project: shop', '---', '# Release check', '## Known differences'].concat(cacheText, ['## Open questions', 'None.']);
t('section renamed and moved far away: found by the global search', () => {
  const ap = headingPaths(checkDoc); const a = buildAnchor(checkDoc, ap, 6, 9);
  const filler = []; for (let i = 0; i < 80; i++) filler.push('Filler line ' + i + ' about unrelated tables.');
  const moved = ['---', 'project: shop', '---', '# Release check', '## Overview'].concat(filler, ['## Appendix: minor items',
    '### Cache behaviour: expected and accepted', '', 'Search results differ because the edge cache keeps its own copy. This is expected. Entries expire after ten minutes. Sample checks: hits 412 = 412, misses 37 = 37.', '', '## Open questions', 'None.']);
  const r = resolveAnchor(a, moved, headingPaths(moved)); assert.deepStrictEqual([r.status, r.start], ['changed', 87]);
});
t('section renamed, text rewritten: outdated at the renamed heading', () => {
  const ap = headingPaths(checkDoc); const a = buildAnchor(checkDoc, ap, 6, 9);
  const d2 = ['---', 'project: shop', '---', '# Release check', '## Known differences', '### Cache behaviour: accepted', '', 'Totally new words here.', '', '## Open questions', 'None.'];
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start, r.where], ['outdated', 6, 'section']);
});
t('one-line quote moved to another section far away', () => {
  const big = ['# Doc']; for (let i = 0; i < 200; i++) big.push(i % 40 === 0 ? '## Part ' + i : 'Plain line ' + i + '.');
  big.splice(20, 0, 'The retry policy applies only to idempotent requests.');
  const a = buildAnchor(big, headingPaths(big), 21, 21);
  const d2 = big.slice(); d2.splice(20, 1); d2.splice(180, 0, 'The retry policy applies only to idempotent HTTP requests.');
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start], ['changed', 181]);
});
t('threads: unread, verdict, counts', () => {
  const d = normalizeData({ comments: [
    { id: 'a', state: 'open', readAt: '2026-10-08T10:00:00Z', anchor: anchorAt(4, 4), thread: [{ author: 'user', at: '2026-10-08T09:00:00Z', text: 'q' }, { author: 'claude', at: '2026-10-08T11:00:00Z', text: 'a' }] },
    { id: 'b', state: 'resolved', anchor: anchorAt(5, 5), thread: [{ author: 'user', at: '2026-10-08T09:00:00Z', text: 'q' }] },
    { id: 'c', state: 'addressed', readAt: '2026-10-08T12:00:00Z', anchor: anchorAt(8, 8), thread: [{ author: 'claude', at: '2026-10-08T11:00:00+02:00', text: 'done' }] }
  ] }, 'n.md');
  assert.ok(isUnread(d.comments[0])); assert.ok(needsVerdict(d.comments[0])); assert.ok(!isUnread(d.comments[2]));
  assert.deepStrictEqual(countOpen(d), { open: 2, fresh: 1, mine: 2 });
});
t('turns, kinds and verdict flags', () => {
  const u = (text, extra) => Object.assign({ author: 'user', at: '2026-10-08T09:00:00Z', text }, extra);
  const g = (text, kind, author) => ({ author: author || 'agent', at: '2026-10-08T10:00:00Z', text, kind });
  const d = normalizeData({ comments: [
    { id: 'new', state: 'open', thread: [u('q')] },
    { id: 'prop', state: 'open', thread: [u('q'), g('proposal', 'proposal')] },
    { id: 'legacy', state: 'open', thread: [u('q'), g('no kind', undefined, 'claude')] },
    { id: 'ans', state: 'open', thread: [u('q'), g('answer', 'answer')] },
    { id: 'done', state: 'addressed', thread: [u('q'), g('Done: x', 'done')] },
    { id: 'acc', state: 'open', thread: [u('q'), g('p', 'proposal'), u('fine by me', { verdict: 'accept' })] },
    { id: 'res', state: 'resolved', thread: [u('q'), g('Done', 'done')] }
  ] }, 'n.md');
  const by = id => d.comments.find(c => c.id === id);
  assert.deepStrictEqual(d.comments.map(turnOf), ['agent', 'you', 'you', 'you', 'you', 'agent', 'resolved']);
  assert.ok(needsVerdict(by('prop')) && needsVerdict(by('legacy')) && !needsVerdict(by('ans')) && !needsVerdict(by('done')));
  assert.ok(needsCheck(by('done')) && !needsCheck(by('prop')));
  assert.strictEqual(lastVerdict(by('acc')), 'accept');
  assert.strictEqual(nextStep(by('acc'), 'Agent'), 'Accepted — Agent applies it');
  assert.strictEqual(nextStep({ state: 'open', thread: [u('q'), g('p', 'proposal'), u('', { verdict: 'accept', resolveAfterApply: true })] }, 'Agent'),
    'Accepted — Agent applies it, then resolves');
  const sentResolved = { state: 'resolved', thread: [u('q'), g('p', 'proposal'), u('', { verdict: 'accept', resolveAfterApply: true })] };
  assert.ok(pendingApply(sentResolved) && !pendingApply(by('res')) && !pendingApply(by('acc')));
  assert.strictEqual(nextStep(sentResolved, 'Agent'), 'Resolved — Agent applies the accepted change');
  assert.strictEqual(nextStep({ ...sentResolved, thread: [...sentResolved.thread, g('Done: x', 'done')] }, 'Agent'), 'Resolved');
  assert.strictEqual(nextStep(by('done'), 'Agent'), 'Check the change, then resolve');
  assert.strictEqual(by('legacy').thread[1].author, 'claude');
  assert.deepStrictEqual(countOpen(d), { open: 6, fresh: 5, mine: 4 });
});
t('thread opened by the agent with a question', () => {
  const q = { author: 'agent', kind: 'question', at: '2026-10-25T10:00:00Z', text: 'Which window applies?' };
  const d = normalizeData({ comments: [{ id: 'ask', state: 'open', anchor: anchorAt(4, 4), thread: [q] }] }, 'n.md');
  const c = d.comments[0];
  assert.ok(startedByAgent(c) && turnOf(c) === 'you' && isUnread(c) && !needsVerdict(c) && !needsCheck(c));
  assert.strictEqual(nextStep(c, 'Agent'), 'Question from Agent — answer it');
  assert.deepStrictEqual(countOpen(d), { open: 1, fresh: 1, mine: 1 });
  c.thread.push({ author: 'user', at: '2026-10-25T10:05:00Z', text: 'The 30-day one.' });
  assert.ok(startedByAgent(c) && turnOf(c) === 'agent');
  assert.strictEqual(nextStep(c, 'Agent'), 'Waiting for Agent');
});
t('sidecar path', () => assert.strictEqual(sidecarPath('my project/plans/A.md'), 'my project/plans/A.review.json'));
t('performance on a 600-line note', () => {
  const big = []; for (let i = 0; i < 600; i++) big.push(i % 50 === 0 ? '## Section ' + i : 'Line number ' + i + ' with some words in it.');
  const bp = headingPaths(big); const a = buildAnchor(big, bp, 300, 302); big[300] = 'Line number 300 with other words in it.';
  const t0 = Date.now(); for (let k = 0; k < 20; k++) resolveAnchor(a, big, bp); const ms = (Date.now() - t0) / 20;
  console.log('   fuzzy resolve avg ms:', ms.toFixed(1)); assert.ok(ms < 100);
});
t('long quote: edited lines found fast, rewritten text fast', () => {
  const big = []; for (let i = 0; i < 600; i++) big.push(i % 40 === 0 ? '## Part ' + i : '- item ' + i + ' describes component number ' + i + ' and its duties.');
  const bp = headingPaths(big); const a = buildAnchor(big, bp, 200, 228);
  const edited = big.slice(); edited[205] = '- item 205 now describes something else.'; edited[220] = '- item 220 changed too.';
  let t0 = Date.now(); const r = resolveAnchor(a, edited, headingPaths(edited)); const ms1 = Date.now() - t0;
  assert.deepStrictEqual([r.status, r.start], ['changed', 200]);
  const rewritten = big.map((l, i) => i >= 199 && i < 228 ? 'Totally new line ' + i : l);
  t0 = Date.now(); const r2 = resolveAnchor(a, rewritten, headingPaths(rewritten)); const ms2 = Date.now() - t0;
  assert.strictEqual(r2.status, 'outdated');
  console.log('   29-line quote ms (edited, rewritten):', ms1, ms2); assert.ok(ms1 < 300 && ms2 < 300);
});
t('pasted image folder and name', () => {
  assert.strictEqual(assetsDir('work/x/Plan.md'), 'work/x/Plan.review-assets');
  assert.strictEqual(imageExt('image/png', 'image.png'), 'png');
  assert.strictEqual(imageExt('image/jpeg', ''), 'jpg');
  assert.strictEqual(imageExt('', 'Shot.HEIC'), 'heic');
  assert.strictEqual(imageExt('', ''), 'png');
  assert.strictEqual(assetName(new Date(2026, 10, 2, 9, 3, 7), 'png', 'k3f9'), '2026-11-02 09-03-07 k3f9.png');
});
const table = ['# T', '', '| # | Severity | Defect |', '|---|---|---|', '| D1 | high | First bug. |', '| D2 | low | Second bug. |', '', 'After.'];
t('table row survives Obsidian table formatting', () => {
  const a = buildAnchor(table, headingPaths(table), 6, 6);
  const fmt = table.slice(); fmt[2] = '| #   | Severity | Defect      |'; fmt[3] = '| --- | -------- | ----------- |';
  fmt[4] = '| D1  | high     | First bug.  |'; fmt[5] = '| D2  | low      | Second bug. |';
  const r = resolveAnchor(a, fmt, headingPaths(fmt)); assert.deepStrictEqual([r.status, r.start, r.end], ['ok', 6, 6]);
});
t('thread widget goes below a table or callout', () => {
  assert.strictEqual(blockEnd(table, 5), 6); assert.strictEqual(blockEnd(table, 3), 6); assert.strictEqual(blockEnd(table, 8), 8);
  const call = ['Intro', '> [!note] Title', '> body one', '> body two', 'After'];
  assert.strictEqual(blockEnd(call, 3), 4);
  const quote = ['Intro', '> plain quote', '> second', 'After'];
  assert.strictEqual(blockEnd(quote, 2), 2);
});
t('a common line at the old place needs its context', () => {
  const d = ['# A', '| a | b |', '|---|---|', '| 1 | 2 |', '', '# B', '| c | d |', '|---|---|', '| 3 | 4 |'];
  const a = buildAnchor(d, headingPaths(d), 8, 8);
  const d3 = ['# A', '| a | b |', '|---|---|', '| 1 | 2 |', '| 1 | 2 |', '| 1 | 2 |', '| x | y |', '|---|---|', '', '# B', '| c | d |', '|---|---|', '| 3 | 4 |'];
  const r = resolveAnchor(a, d3, headingPaths(d3)); assert.deepStrictEqual([r.status, r.start], ['ok', 12]);
  // Both neighbours edited, the line itself unique: it stays in place.
  const d4 = doc.slice(); d4[6] = '## 2. Decisions (renamed)'; d4[8] = '  (note N8). Start values: 4,000 kilobytes.';
  const b = anchorAt(8, 8); const r4 = resolveAnchor(b, d4, headingPaths(d4)); assert.deepStrictEqual([r4.status, r4.start], ['ok', 8]);
});
t('missing ids are stable across loads and unique', () => {
  const raw = '{"comments":[{"state":"open","createdAt":"2026-01-01T00:00:00Z","anchor":{"lineHint":1,"lineCount":1,"quote":"x"},"thread":[{"author":"agent","at":"2026-01-01T00:00:00Z","text":"q1"}]},' +
    '{"state":"open","createdAt":"2026-01-01T00:00:00Z","anchor":{"lineHint":1,"lineCount":1,"quote":"x"},"thread":[{"author":"agent","at":"2026-01-01T00:00:00Z","text":"q2"}]},' +
    '{"id":"dup","state":"open","thread":[]},{"id":"dup","state":"open","thread":[]}]}';
  const a = normalizeData(JSON.parse(raw), 'n.md'), b = normalizeData(JSON.parse(raw), 'n.md');
  assert.deepStrictEqual(a.comments.map(c => c.id), b.comments.map(c => c.id));
  assert.strictEqual(a.comments[0].thread[0].id, b.comments[0].thread[0].id);
  assert.strictEqual(new Set(a.comments.map(c => c.id)).size, 4);
  assert.strictEqual(a.comments[2].id, 'dup');
});
t('CRLF anchors match LF editor lines', () => {
  const a = anchorAt(8, 9); a.quote = a.quote.replace(/\n/g, '\r\n') + ''; a.prefix += '\r'; a.suffix += '\r';
  const d = normalizeData({ comments: [{ id: 'c', anchor: a, thread: [] }] }, 'n.md');
  const r = resolveAnchor(d.comments[0].anchor, doc, P); assert.deepStrictEqual([r.status, r.start, r.end], ['ok', 8, 9]);
});
t('a section prefix must end at a word boundary', () => {
  const d = ['# Plan', '## Step 1', 'Gone text that is long enough.', '## Step 12', 'Other text here.'];
  const a = buildAnchor(d, headingPaths(d), 3, 3);
  const d2 = ['# Plan', '## Step 12', 'Other text here.', '## Notes', 'Nothing alike at all.', 'More lines.'];
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.strictEqual(r.status, 'outdated'); assert.strictEqual(r.where, 'line');
  const d3 = ['# Plan', '## Step 1: setup', 'Unrelated words only.'];
  const r3 = resolveAnchor(a, d3, headingPaths(d3)); assert.deepStrictEqual([r3.status, r3.where, r3.start], ['outdated', 'section', 2]);
});
const original = 'Each plugin bundles its own copy of shared code. The middle way keeps plugins small. **Recommended: the middle way; needs a shared loader.**';
const rewrite = 'Each plugin bundles its own copy of shared code. The middle way keeps plugins small. **Revised: fully separate plugins; each plugin ships every library, and the installer removes duplicate files on disk.**';
t('a rewritten line keeps its block ID', () => {
  const d = ['# Q', '', '- **Q3.** Short one. ^q3', '- **Q4.** Shared code ties plugins together. ^q4', '- **Q5.** Next. ^q5'];
  const a = buildAnchor(d, headingPaths(d), 4, 4);
  const d2 = ['# Q', '', 'Inserted paragraph.', '', '- **Q3.** Short one. ^q3', 'Another insert.', '- **Q4.** ' + rewrite + ' ^q4', '- **Q5.** Next, changed too. ^q5'];
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start, r.end], ['changed', 7, 7]);
});
t('a rewritten line between unchanged neighbours stays in place', () => {
  const d = ['# Q', 'Intro line that stays.', original, 'Closing line that stays.'];
  const a = buildAnchor(d, headingPaths(d), 3, 3);
  const d2 = d.slice(); d2[2] = rewrite;
  const r = resolveAnchor(a, d2, headingPaths(d2)); assert.deepStrictEqual([r.status, r.start, r.end], ['changed', 3, 3]);
  const d3 = ['# Q', '', original, ''];
  const a3 = buildAnchor(d3, headingPaths(d3), 3, 3);
  const d4 = d3.slice(); d4[2] = rewrite;
  assert.strictEqual(resolveAnchor(a3, d4, headingPaths(d4)).status, 'outdated');
  const d5 = d.slice(); d5[2] = 'Totally new words.';
  assert.strictEqual(resolveAnchor(a, d5, headingPaths(d5)).status, 'outdated');
});
t('last agent message id for the verdict check', () => {
  assert.strictEqual(lastAgentId({ thread: [{ id: 'm1', author: 'user' }] }), '');
  assert.strictEqual(lastAgentId({ thread: [{ id: 'm1', author: 'user' }, { id: 'm2', author: 'agent' }, { id: 'm3', author: 'user' }] }), 'm2');
  assert.strictEqual(lastAgentId({ thread: [{ id: 'm2', author: 'claude' }, { id: 'm4', author: 'agent' }] }), 'm4');
});
console.log(`${passed} tests passed`);
