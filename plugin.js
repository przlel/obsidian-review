// Copyright 2026 Przemysław Lelakowski. SPDX-License-Identifier: Apache-2.0
// md-review Obsidian plugin: editor decorations, threads, panel, badges.

const obsidian = require('obsidian');
const { Plugin, ItemView, Notice, MarkdownView, MarkdownRenderer, Component, PluginSettingTab, Setting } = obsidian;
// Icon helper; a plain text fallback keeps older Obsidian versions working.
const setIcon = obsidian.setIcon || ((elx, _id) => {});
// Modifier key label for hints: "⌘" on macOS, "Ctrl+" elsewhere (the handlers accept both).
const modKey = () => (obsidian.Platform && obsidian.Platform.isMacOS ? '⌘' : 'Ctrl+');
const { StateField, StateEffect, EditorState } = require('@codemirror/state');
const { EditorView, ViewPlugin, Decoration, WidgetType, showTooltip } = require('@codemirror/view');

const VIEW_TYPE = 'md-review-panel';
// The copied prompt; {note}, {sidecar}, {waiting} and {protocol} are filled in.
const DEFAULT_PROMPT = 'Answer the review comments on "{note}" (threads in "{sidecar}"). {waiting} Follow the MD Review protocol: {protocol}. Write your replies into the JSON file.';
const DEFAULT_SETTINGS = { gutterPlus: true, selectionButton: true, accent: 'orange', askAccent: 'blue', textSize: 'small', agentName: 'Agent',
  agentMode: true, onboarded: false, activate: 'comments', promptTemplate: DEFAULT_PROMPT, protocolUrl: '' };
const ACCENTS = { orange: 'var(--color-orange)', blue: 'var(--color-blue)', green: 'var(--color-green)', red: 'var(--color-red)', theme: 'var(--interactive-accent)' };
const TEXT_SIZES = { small: 0.8, medium: 0.88 };
const setReview = StateEffect.define();
const setHover = StateEffect.define();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function shortTime(iso) {
  const d = new Date(iso || '');
  if (isNaN(d)) return '';
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? hm : d.toLocaleDateString() + ' ' + hm;
}
function rangeLabel(a, b) { return a === b ? `Line ${a}` : `Lines ${a}–${b}`; }
const VERDICT_LABELS = { accept: '✓ Accepted', reject: '✗ Rejected', discuss: '? Discuss' };
const KIND_LABELS = { proposal: 'Proposal', answer: 'Answer', done: 'Done', question: 'Question' };

// The + sits left of the hovered line (absolute position, outside the text),
// so it works in themes that hide or clip the editor gutter.
class PlusWidget extends WidgetType {
  constructor(plugin, line) { super(); this.plugin = plugin; this.line = line; }
  eq(other) { return other.line === this.line; }
  toDOM(view) {
    const b = el('span', 'mdr-plus', '+');
    b.setAttribute('aria-label', 'Comment on this line (drag for a range, Shift-click to extend)');
    b.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this.plugin.startDrag(view, this.line, e);
    });
    return b;
  }
  ignoreEvent() { return true; }
}

// Copy from a thread. Obsidian's window "copy" listener re-sends every copy that
// nobody handled to the focused element, here the editor; CodeMirror then copies
// its own (empty) note selection and clears the selection in the thread. So the
// thread writes the clipboard itself and marks the event handled. Text boxes
// keep the native copy.
function copyThreadSelection(e) {
  if (e.target.closest && e.target.closest('textarea, input')) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData || !e.currentTarget.contains(sel.anchorNode)) return;
  const html = el('div');
  html.appendChild(sel.getRangeAt(0).cloneContents());
  e.preventDefault();
  e.clipboardData.setData('text/plain', sel.toString());
  e.clipboardData.setData('text/html', html.innerHTML);
}

// ---------- quote reply: points of a rendered message ----------
// A point is a list item (any depth) or a paragraph that starts with a number
// ("1." / "2)"), which agents use as a point title above an unindented list.
const NUM_RE = /^\s*(\d+)[.)]\s/;
function ownText(node) {
  const c = node.cloneNode(true);
  c.querySelectorAll('.mdr-pq, ul, ol').forEach(x => x.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
}
const subLists = li => Array.from(li.children).filter(x => x.tagName === 'UL' || x.tagName === 'OL');
// "2." for the 2nd item of an ordered list (honours start=), "" otherwise.
function pointNumber(li) {
  const list = li.parentElement;
  if (!list || list.tagName !== 'OL') return '';
  const items = Array.from(list.children).filter(x => x.tagName === 'LI');
  return (parseInt(list.getAttribute('start') || '1', 10) + items.indexOf(li)) + '.';
}
function listLines(list, depth) {
  return Array.from(list.children).filter(x => x.tagName === 'LI').flatMap(li => [
    ' '.repeat(depth * 2) + (pointNumber(li) || '-') + ' ' + ownText(li),
    ...subLists(li).flatMap(l => listLines(l, depth + 1))
  ]);
}
const isHead = n => !!n && (/^H[1-6]$/.test(n.tagName) || (n.tagName === 'P' && NUM_RE.test(n.textContent)));
// A numbered paragraph with the bullet lists and paragraphs under it, up to the
// next head. An ordered list has numbers of its own, so it ends the section.
const endsHead = n => !n || isHead(n) || n.tagName === 'HR' || n.tagName === 'OL';
function headLines(p) {
  const out = [ownText(p)];
  for (let n = p.nextElementSibling; !endsHead(n); n = n.nextElementSibling) {
    if (n.tagName === 'UL') out.push(...listLines(n, 0));
    else if (n.tagName === 'P') out.push(ownText(n));
  }
  return out;
}
// Number of the point that contains a list item: its parent item, or the
// numbered paragraph above its top-level list. "" when there is none.
function parentPoint(li) {
  const list = li.parentElement;
  if (!list) return '';
  const up = list.parentElement && list.parentElement.closest('li');
  if (up && list.closest('.mdr-text') === up.closest('.mdr-text')) return pointLabel(up).trim();
  if (list.tagName === 'OL') return '';
  for (let n = list.previousElementSibling; n; n = n.previousElementSibling) {
    if (endsHead(n)) { const m = n.tagName === 'P' && NUM_RE.exec(n.textContent); return m ? m[1] + '.' : ''; }
  }
  return '';
}
// "1. › 2. " style prefix that tells which point a quote belongs to.
function pointLabel(li) {
  const parent = parentPoint(li), own = pointNumber(li);
  return [parent && parent + ' ›', own].filter(Boolean).join(' ') + (parent || own ? ' ' : '');
}
function pointText(li) {
  return [pointLabel(li) + ownText(li), ...subLists(li).flatMap(l => listLines(l, 1))].join('\n');
}
// A "❝ quote" button on every point of a rendered message.
function addPointQuotes(box, onQuote) {
  const add = (node, text) => {
    node.classList.add('mdr-point');
    const b = el('span', 'mdr-pq', '❝ quote');
    b.setAttribute('aria-label', 'Quote this point in the reply');
    b.onmousedown = e => e.preventDefault();
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); onQuote(text()); };
    node.appendChild(b);
  };
  for (const li of box.querySelectorAll('li')) add(li, () => pointText(li));
  for (const p of box.querySelectorAll(':scope > p')) if (NUM_RE.test(p.textContent)) add(p, () => headLines(p).join('\n'));
}

class ThreadWidget extends WidgetType {
  constructor(plugin, path, c, r, key) { super(); this.plugin = plugin; this.path = path; this.c = c; this.r = r; this.key = key; }
  eq(other) { return other.key === this.key; }
  // The component owns what the Markdown renderer attaches to the messages; it
  // is unloaded together with the widget.
  toDOM(view) {
    const w = el('div', 'mdr-wrap');
    // Focusable, so a click in the thread focuses the thread, not the editor.
    // When the click focuses an unfocused editor, CodeMirror moves the DOM
    // selection back to the note and a selection in the thread is lost.
    w.tabIndex = -1;
    w.addEventListener('copy', copyThreadSelection);
    w.mdrComp = new Component(); w.mdrComp.load();
    w.appendChild(this.plugin.renderThread(view, this.path, this.c, this.r, w.mdrComp));
    return w;
  }
  destroy(dom) { if (dom.mdrComp) dom.mdrComp.unload(); }
  ignoreEvent() { return true; }
}
class ComposerWidget extends WidgetType {
  constructor(plugin, composer) { super(); this.plugin = plugin; this.composer = composer; }
  eq(other) { return other.composer.id === this.composer.id; }
  toDOM(view) { const w = el('div', 'mdr-wrap'); w.appendChild(this.plugin.renderComposer(view, this.composer)); return w; }
  ignoreEvent() { return true; }
}

class MdReviewPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.applyLook();
    this.cache = new Map();          // notePath -> { data, mtime, broken }
    this.index = new Map();          // notePath -> { open, fresh }
    this.resolved = new Map();       // notePath -> { doc, ver, list }
    this.ver = new Map();            // notePath -> data version counter
    this.ui = { expanded: new Set(), collapsed: new Set(), flags: {}, composer: null, drag: null, lastSel: null, drafts: {}, editing: null, confirmDelete: null,
      manualOn: new Set(), manualOff: new Set() };
    this.queues = new Map();         // notePath -> tail of its write queue
    this.seen = new WeakSet();       // editors this plugin instance has painted
    this.reviewMode = false;
    this.readOnlyExt = [];
    this.lastNotePath = null;

    this.registerView(VIEW_TYPE, leaf => new ReviewPanel(leaf, this));
    this.registerEditorExtension(this.buildExtensions());
    this.registerEditorExtension(this.readOnlyExt);
    this.addSettingTab(new ReviewSettingTab(this.app, this));
    this.addRibbonIcon('message-square', 'Review comments', () => this.activatePanel());

    this.addCommand({ id: 'toggle-note-review', name: 'Start or stop review of this note',
      checkCallback: checking => { const p = this.activeNotePath(); if (!p) return false; if (!checking) this.toggleNoteReview(p); return true; } });
    this.addCommand({ id: 'add-comment', name: 'Add review comment on selected lines',
      editorCallback: (editor) => {
        const cm = editor.cm; if (!cm) return;
        const r = cm.state.selection.main;
        const a = cm.state.doc.lineAt(r.from).number, b = cm.state.doc.lineAt(r.to).number;
        this.openComposer(cm, a, b, r.empty ? null : cm.state.sliceDoc(r.from, r.to), r.empty ? null : [r.from, r.to]);
      } });
    this.addCommand({ id: 'toggle-review-mode', name: 'Toggle review mode (read-only editor)', callback: () => this.toggleReviewMode() });
    this.addCommand({ id: 'open-panel', name: 'Open review panel', callback: () => this.activatePanel() });
    this.addCommand({ id: 'collapse-all-threads', name: 'Collapse all threads in this note', callback: () => this.setAllCollapsed(this.lastNotePath, true) });
    this.addCommand({ id: 'expand-all-threads', name: 'Expand all open threads in this note', callback: () => this.setAllCollapsed(this.lastNotePath, false) });
    this.addCommand({ id: 'copy-agent-prompt', name: 'Copy prompt for the agent',
      checkCallback: checking => { if (!this.settings.agentMode || !this.lastNotePath) return false; if (!checking) this.copyPrompt(); return true; } });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mdr-status');
    this.statusEl.onclick = () => this.toggleReviewMode();

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.onActiveChange()));
    this.registerEvent(this.app.workspace.on('layout-change', () => { this.updateBadges(); this.addHeaderActions(); }));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.onRename(f, old)));
    this.registerEvent(this.app.vault.on('delete', f => this.onDelete(f)));
    this.registerInterval(window.setInterval(() => this.poll(), 1500));
    this.registerInterval(window.setInterval(() => this.scanVault(), 5 * 60 * 1000));
    // Obsidian's drag manager scrolls an editor while a dragged item sits near
    // its edge, and stops on 'dragend' at the drag source. When the source is
    // re-rendered during the drag (a thread widget, a Live Preview table),
    // 'dragend' never arrives and the editor keeps scrolling on its own. A
    // wheel turn or a pointer press means no drag is running, so the plugin
    // stops such a scroll.
    const stopStuckScroll = () => {
      const dm = this.app.dragManager, es = dm && dm.edgeScroll;
      if (!es) return;
      try { es.win.cancelAnimationFrame(es.frame); } catch (e) { /* window closed */ }
      dm.edgeScroll = null;
    };
    this.registerDomEvent(window, 'wheel', stopStuckScroll, { passive: true });
    this.registerDomEvent(window, 'pointerdown', stopStuckScroll, true);
    // refreshEditors: editors that were open before a plugin reload are painted
    // again, not only the active one.
    this.app.workspace.onLayoutReady(() => { this.ensurePanel(); this.scanVault(); this.onActiveChange(); this.addHeaderActions(); this.refreshEditors(); });
  }

  // Plugin colours and annotation size live in CSS variables on <body>.
  applyLook() {
    document.body.style.setProperty('--mdr-accent', ACCENTS[this.settings.accent] || ACCENTS.orange);
    document.body.style.setProperty('--mdr-ask', ACCENTS[this.settings.askAccent] || ACCENTS.blue);
    document.body.style.setProperty('--mdr-scale', String(TEXT_SIZES[this.settings.textSize] || TEXT_SIZES.medium));
  }
  onunload() {
    document.body.style.removeProperty('--mdr-accent');
    document.body.style.removeProperty('--mdr-ask');
    document.body.style.removeProperty('--mdr-scale'); this.app.workspace.detachLeavesOfType(VIEW_TYPE); document.querySelectorAll('.mdr-badge').forEach(b => b.remove());
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) if (leaf.view.mdrAction) { leaf.view.mdrAction.remove(); delete leaf.view.mdrAction; }
  }
  async saveSettings() { await this.saveData(this.settings); this.applyLook(); this.refreshEditors(); }

  // ---------- data ----------
  async loadNote(notePath) {
    const p = sidecarPath(notePath), a = this.app.vault.adapter;
    let entry;
    if (!(await a.exists(p))) {
      entry = { data: emptyData(notePath), mtime: 0, size: 0, broken: false };
    } else {
      const st = await a.stat(p), mtime = st ? st.mtime : 0, size = st ? st.size : 0;
      try { entry = { data: normalizeData(JSON.parse(await a.read(p)), notePath), mtime, size, broken: false }; }
      catch (e) { new Notice(`md-review: cannot parse ${p}. Fix the JSON; the plugin will not overwrite it.`); entry = { data: emptyData(notePath), mtime, size, broken: true }; }
    }
    this.cache.set(notePath, entry);
    this.ver.set(notePath, (this.ver.get(notePath) || 0) + 1);
    this.index.set(notePath, countOpen(entry.data));
    return entry.data;
  }
  data(notePath) { const e = this.cache.get(notePath); return e ? e.data : null; }

  // Read-modify-write on the freshest file, so the agent's edits are never lost.
  // Writes to one note run one after another (two quick clicks must not drop
  // each other's change). fn returns false when there is nothing to change,
  // e.g. the thread is gone; then nothing is written. Returns true only when
  // the change was saved, so callers keep the user's text otherwise.
  mutate(notePath, fn) {
    const run = (this.queues.get(notePath) || Promise.resolve()).then(() => this.mutateNow(notePath, fn));
    this.queues.set(notePath, run.catch(() => false));
    return run;
  }
  async mutateNow(notePath, fn) {
    try {
      await this.loadNote(notePath);
      const entry = this.cache.get(notePath);
      if (entry.broken) { new Notice('md-review: the review file is broken; change not saved. Your text stays in the box.'); return false; }
      if (fn(entry.data) === false) return false;
      entry.data.note = notePath;
      const p = sidecarPath(notePath), a = this.app.vault.adapter;
      await a.write(p, JSON.stringify(entry.data, null, 2) + '\n');
      const st = await a.stat(p);
      entry.mtime = st ? st.mtime : Date.now(); entry.size = st ? st.size : 0;
      this.ver.set(notePath, (this.ver.get(notePath) || 0) + 1);
      this.index.set(notePath, countOpen(entry.data));
      this.refreshNote(notePath);
      return true;
    } catch (e) {
      console.error('md-review: write failed', e);
      new Notice('md-review: cannot save the review file: ' + e.message + '. Your text stays in the box.');
      return false;
    }
  }
  find(data, id) { return data.comments.find(c => c.id === id); }

  async poll() {
    for (const notePath of new Set(this.openNotePaths())) {
      const st = await this.app.vault.adapter.stat(sidecarPath(notePath)).catch(() => null);
      const mtime = st ? st.mtime : 0, size = st ? st.size : 0;
      const entry = this.cache.get(notePath);
      // Size too: a write inside the same timestamp tick keeps the mtime.
      if (!entry || entry.mtime !== mtime || entry.size !== size) { await this.loadNote(notePath); this.refreshNote(notePath); }
    }
  }
  async scanVault() {
    const a = this.app.vault.adapter;
    const walk = async (dir) => {
      let listing; try { listing = await a.list(dir); } catch (e) { return; }
      for (const f of listing.files) if (/\.review\.json$/i.test(f)) {
        const notePath = notePathOfSidecar(f);
        if (!this.cache.has(notePath)) await this.loadNote(notePath);
      }
      for (const d of listing.folders) if (!d.split('/').pop().startsWith('.')) await walk(d);
    };
    await walk('');
    this.updateBadges();
  }
  async onRename(file, oldPath) {
    if (!/\.md$/i.test(oldPath)) return;
    const now = file.path, ui = this.ui;
    // Everything that remembers the old path follows the note.
    if (this.lastNotePath === oldPath) this.lastNotePath = now;
    for (const k of ['composer', 'lastSel']) if (ui[k] && ui[k].path === oldPath) ui[k].path = now;
    for (const set of [ui.manualOn, ui.manualOff]) if (set.delete(oldPath)) set.add(now);
    const key = 'new:' + oldPath; if (ui.drafts[key] != null) { ui.drafts['new:' + now] = ui.drafts[key]; delete ui.drafts[key]; }
    await this.moveAssets(oldPath, now);
    const a = this.app.vault.adapter, from = sidecarPath(oldPath), to = sidecarPath(now);
    if (await a.exists(from)) {
      const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase();
      if (!caseOnly && (await a.exists(to, true))) {
        new Notice(`md-review: ${to} already exists, so the comments stayed in ${from}. Move or merge them by hand.`);
      } else {
        // A case-only rename goes through a temporary name: on macOS and Windows
        // the target "exists" already (same file, other case).
        if (caseOnly) { const tmp = from + '.mdr-tmp'; await a.rename(from, tmp); await a.rename(tmp, to); }
        else await a.rename(from, to);
        this.cache.delete(oldPath); this.index.delete(oldPath); this.resolved.delete(oldPath);
        await this.mutate(now, d => { d.note = now; });
      }
    }
    this.refreshNote(now);
  }
  // A deleted note takes its comments and pasted images to the trash too, so
  // a later note with the same name does not inherit them. A note moved
  // outside Obsidian (a script, git, sync) also arrives as a delete; a tool that
  // moves the review file does it right after the note, so the plugin waits and acts
  // only when the note is still gone and the review file is still there.
  async onDelete(file) {
    if (!/\.md$/i.test(file.path)) return;
    await new Promise(r => setTimeout(r, 2000));
    const v = this.app.vault, fm = this.app.fileManager;
    if (v.getAbstractFileByPath(file.path)) return;
    for (const p of [sidecarPath(file.path), assetsDir(file.path)]) {
      const f = v.getAbstractFileByPath(p);
      if (!f) continue;
      try { if (fm && fm.trashFile) await fm.trashFile(f); else await v.trash(f, true); }
      catch (e) { new Notice(`md-review: cannot move ${p} to the trash: ${e.message}`); }
    }
    this.cache.delete(file.path); this.index.delete(file.path); this.resolved.delete(file.path);
    this.updateBadges(); this.refreshPanels(); this.updateStatus();
  }

  // The pasted-images folder follows its note. When a parent folder is renamed,
  // the images already moved with it and there is nothing to do.
  async moveAssets(oldPath, newPath) {
    const v = this.app.vault, from = assetsDir(oldPath), to = assetsDir(newPath);
    const f = v.getAbstractFileByPath(from);
    if (!f) return;
    const there = v.getAbstractFileByPath(to);
    if (there && there !== f) { new Notice(`md-review: ${to} already exists, so the pasted images stayed in ${from}.`); return; }
    try { await v.rename(f, to); } catch (e) { new Notice(`md-review: cannot move ${from} to ${to}: ${e.message}`); }
  }

  // ---------- pasted images ----------
  // Paste (Cmd/Ctrl+V) or drop an image into a comment or reply box: the image is saved
  // to <note>.review-assets/ and an embed ![[<name>]] goes in at the caret.
  // Text paste (also dictation) keeps the default behaviour.
  bindImages(ta, notePath) {
    const images = list => Array.from(list || []).filter(f => /^image\//.test(f.type));
    const insert = async files => {
      for (const f of files) {
        let name;
        try { name = await this.saveImage(notePath, f); }
        catch (e) { new Notice('md-review: cannot save the image: ' + e.message); continue; }
        const s = ta.selectionStart, end = ta.selectionEnd, v = ta.value;
        const snippet = (s && !/\s$/.test(v.slice(0, s)) ? '\n' : '') + `![[${name}]]\n`;
        ta.value = v.slice(0, s) + snippet + v.slice(end);
        ta.selectionStart = ta.selectionEnd = s + snippet.length;
      }
      ta.dispatchEvent(new Event('input'));
      ta.focus();
    };
    ta.addEventListener('paste', e => {
      const files = images(e.clipboardData && e.clipboardData.files);
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation(); insert(files);
    });
    ta.addEventListener('dragover', e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
    });
    ta.addEventListener('drop', e => {
      const files = images(e.dataTransfer && e.dataTransfer.files);
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation(); insert(files);
    });
  }
  async saveImage(notePath, file) {
    const v = this.app.vault, dir = assetsDir(notePath);
    if (!v.getAbstractFileByPath(dir)) await v.createFolder(dir);
    const name = assetName(new Date(), imageExt(file.type, file.name), Math.random().toString(36).slice(2, 6));
    await v.createBinary(`${dir}/${name}`, await file.arrayBuffer());
    return name;
  }

  // ---------- workspace helpers ----------
  openNotePaths() {
    return this.app.workspace.getLeavesOfType('markdown').map(l => l.view.file && l.view.file.path).filter(Boolean);
  }
  // The note path of a note's main editor; null for every other editor. Live
  // Preview edits each table cell in a nested editor that reports the same
  // note (editorInfoField), and Canvas cards and embeds run these extensions
  // too: threads drawn there would resolve against a one-line document.
  pathOf(view) {
    try {
      const info = view.state.field(obsidian.editorInfoField, false);
      if (info && info.file) return info.file.extension === 'md' && info.editor && info.editor.cm === view ? info.file.path : null;
    } catch (e) { /* older API */ }
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) if (leaf.view.editor && leaf.view.editor.cm === view) return leaf.view.file && leaf.view.file.path;
    return null;
  }
  activeNotePath() { const mv = this.app.workspace.getActiveViewOfType(MarkdownView); return mv && mv.file ? mv.file.path : null; }

  // ---------- review on or off per note ----------
  // A note shows the +, the selection button, the left margin and its threads
  // only while review is on for it. "Activate review" decides the default; the
  // header button or the command switches one note for this session.
  isActive(path) {
    if (!path) return false;
    if (this.ui.manualOff.has(path)) return false;
    if (this.ui.manualOn.has(path)) return true;
    const mode = this.settings.activate;
    if (mode === 'always') return true;
    if (mode === 'demand') return false;
    const d = this.data(path);
    return !!(d && d.comments.length);
  }
  setNoteReview(path, on) {
    if (!path) return;
    this.ui.manualOn.delete(path); this.ui.manualOff.delete(path);
    (on ? this.ui.manualOn : this.ui.manualOff).add(path);
    if (!on && this.ui.composer && this.ui.composer.path === path) this.ui.composer = null;
    this.refreshNote(path); this.addHeaderActions();
  }
  toggleNoteReview(path) { this.setNoteReview(path, !this.isActive(path)); }
  // A button in each note's header starts or stops the review of that note.
  addHeaderActions() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!view || !view.addAction || !view.file) continue;
      if (!view.mdrAction) view.mdrAction = view.addAction('message-square', 'Start or stop review of this note', () => view.file && this.toggleNoteReview(view.file.path));
      const on = this.isActive(view.file.path);
      view.mdrAction.toggleClass('mdr-action-on', on);
      view.mdrAction.setAttribute('aria-label', on ? 'Stop review of this note' : 'Start review of this note');
    }
  }
  async onActiveChange() {
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mv && mv.file) {
      this.lastNotePath = mv.file.path;
      if (!this.cache.has(mv.file.path)) await this.loadNote(mv.file.path);
      this.refreshNote(mv.file.path);
    }
    this.refreshPanels(); this.updateStatus();
  }
  refreshNote(notePath) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view.file && leaf.view.file.path === notePath && leaf.view.editor && leaf.view.editor.cm) this.refreshView(leaf.view.editor.cm);
    }
    this.refreshPanels(); this.updateStatus(); this.updateBadges(); this.addHeaderActions();
  }
  refreshEditors() { for (const p of new Set(this.openNotePaths())) this.refreshNote(p); }

  // Anchor positions per note. A reply or a state change keeps the note text,
  // so each comment's position is reused from a memo keyed by its anchor.
  resolvedFor(notePath, doc) {
    const data = this.data(notePath); if (!data) return [];
    const ver = this.ver.get(notePath) || 0, hit = this.resolved.get(notePath);
    if (hit && hit.doc === doc && hit.ver === ver) return hit.list;
    const prev = hit && hit.doc === doc ? hit.memo : new Map(), memo = new Map();
    let lines = null, paths = null;
    const list = data.comments.map(c => {
      const key = JSON.stringify(c.anchor);
      let r = prev.get(key);
      if (!r) {
        if (!lines) { lines = doc.toString().split('\n'); paths = headingPaths(lines); }
        r = resolveAnchor(c.anchor, lines, paths);
      }
      memo.set(key, r);
      return { c, r };
    });
    this.resolved.set(notePath, { doc, ver, list, memo });
    return list;
  }
  refreshView(view) {
    const notePath = this.pathOf(view); if (!notePath) return;
    if (!this.cache.has(notePath)) { this.loadNote(notePath).then(() => this.refreshView(view)); return; }
    const active = this.isActive(notePath);
    const anchors = active ? this.resolvedFor(notePath, view.state.doc) : [];
    try { view.dispatch({ effects: setReview.of({ path: notePath, anchors, active, stamp: Math.random() }) }); } catch (e) { /* view destroyed */ }
  }

  // ---------- editor extensions ----------
  buildExtensions() {
    const plugin = this;
    const reviewField = StateField.define({
      create() { return { value: null, deco: Decoration.none }; },
      update(v, tr) {
        for (const e of tr.effects) if (e.is(setReview)) return { value: e.value, deco: plugin.buildDecorations(tr.state, e.value) };
        return tr.docChanged ? { value: v.value, deco: v.deco.map(tr.changes) } : v;
      },
      provide: f => EditorView.decorations.from(f, v => v.deco)
    });
    this.reviewField = reviewField;
    const activeIn = state => { const v = state.field(reviewField, false); return !!(v && v.value && v.value.active); };
    // The left margin for the + exists only while review is on for the note.
    const activeClass = EditorView.editorAttributes.compute([reviewField], state => activeIn(state) ? { class: 'mdr-active' } : {});
    const hoverField = StateField.define({
      create() { return 0; },
      update(v, tr) { for (const e of tr.effects) if (e.is(setHover)) return e.value; return v; }
    });
    const plusDecorations = EditorView.decorations.compute(['doc', hoverField, reviewField], state => {
      const n = state.field(hoverField);
      if (!plugin.settings.gutterPlus || plugin.ui.drag || !n || n > state.doc.lines || !activeIn(state)) return Decoration.none;
      const line = state.doc.line(n);
      return Decoration.set([
        Decoration.line({ class: 'mdr-line-hover' }).range(line.from),
        Decoration.widget({ widget: new PlusWidget(plugin, n), side: -1 }).range(line.from)
      ], true);
    });
    // Tracks the hovered line on the whole scroller, so the + stays visible
    // while the pointer moves from the text to the left margin.
    const hoverTracker = ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.move = e => {
          if (!plugin.settings.gutterPlus || !activeIn(view.state) || !plugin.pathOf(view)) return;
          const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
          // Over a thread widget (block type is not text) no + is shown.
          const isText = block && (Array.isArray(block.type) || block.type === 0);
          const n = isText ? view.state.doc.lineAt(Math.min(block.to, view.state.doc.length)).number : 0;
          if (n !== view.state.field(hoverField)) view.dispatch({ effects: setHover.of(n) });
        };
        this.leave = () => { if (view.state.field(hoverField)) view.dispatch({ effects: setHover.of(0) }); };
        view.scrollDOM.addEventListener('mousemove', this.move);
        view.scrollDOM.addEventListener('mouseleave', this.leave);
      }
      destroy() {
        this.view.scrollDOM.removeEventListener('mousemove', this.move);
        this.view.scrollDOM.removeEventListener('mouseleave', this.leave);
      }
    });
    const selectionTip = StateField.define({
      create: () => null,
      update(tip, tr) {
        if (!tr.selection && !tr.docChanged && !tr.effects.some(e => e.is(setReview))) return tip;
        return plugin.selectionTooltip(tr.state);
      },
      provide: f => showTooltip.from(f)
    });
    const docWatcher = EditorView.updateListener.of(u => {
      if (!u.docChanged) return;
      clearTimeout(u.view.mdrTimer);
      u.view.mdrTimer = setTimeout(() => plugin.refreshView(u.view), 400);
    });
    const firstPaint = EditorView.updateListener.of(u => {
      if (plugin.seen.has(u.view)) return;
      plugin.seen.add(u.view);
      setTimeout(() => plugin.refreshView(u.view), 0);
    });
    // The open composer keeps document positions, not line numbers: text added
    // or removed above it (by the user or the agent) moves them along.
    const composerTracker = EditorView.updateListener.of(u => {
      const comp = plugin.ui.composer;
      if (!u.docChanged || !comp || comp.view !== u.view) return;
      const from = u.changes.mapPos(comp.from, 1), to = u.changes.mapPos(comp.to, -1);
      if (to < from) { comp.gone = true; return; }
      comp.from = from; comp.to = to;
      comp.start = u.state.doc.lineAt(from).number; comp.end = u.state.doc.lineAt(to).number;
      if (comp.range) comp.range = [u.changes.mapPos(comp.range[0], 1), u.changes.mapPos(comp.range[1], -1)];
    });
    return [reviewField, activeClass, hoverField, plusDecorations, hoverTracker, selectionTip, docWatcher, firstPaint, composerTracker];
  }

  buildDecorations(state, v) {
    if (!v || !v.active) return Decoration.none;
    const doc = state.doc, ranges = [];
    const clamp = n => Math.min(Math.max(1, n), doc.lines);
    // Threads and the composer go below a table or callout that contains their
    // last line: Live Preview draws those blocks as one widget, which hides
    // anything placed inside.
    let lines = null;
    const below = n => { lines = lines || doc.toString().split('\n'); return doc.line(blockEnd(lines, clamp(n))).to; };
    const comp = this.ui.composer && this.ui.composer.path === v.path ? this.ui.composer : null;
    const sel = (this.ui.drag && this.ui.drag.path === v.path) ? this.ui.drag : comp;
    const selected = new Set();
    if (sel) {
      const a = clamp(sel.start), b = clamp(sel.end);
      for (let n = a; n <= b; n++) {
        selected.add(n);
        ranges.push(Decoration.line({ class: 'mdr-line-sel' + (n === a ? ' mdr-first' : '') + (n === b ? ' mdr-last' : '') }).range(doc.line(n).from));
      }
    }
    for (const { c, r } of v.anchors) {
      const showLines = r.status !== 'outdated' && (c.state !== 'resolved' || this.ui.expanded.has(c.id));
      if (showLines) {
        const cls = c.state === 'resolved' ? 'mdr-line-done' : 'mdr-line-hl' + (startedByAgent(c) ? ' mdr-line-ask' : '');
        const a = clamp(r.start), b = clamp(r.end);
        for (let n = a; n <= b; n++) if (!selected.has(n)) {
          ranges.push(Decoration.line({ class: cls + (n === a ? ' mdr-first' : '') + (n === b ? ' mdr-last' : '') }).range(doc.line(n).from));
        }
        // A partial text selection is marked inside the lines instead of being quoted.
        const sel = c.anchor.selection;
        if (r.status === 'ok' && sel && sel.trim() !== (c.anchor.quote || '').trim()) {
          const from = doc.line(clamp(r.start)).from, text = doc.sliceString(from, doc.line(clamp(r.end)).to);
          const i = text.indexOf(sel);
          if (i >= 0 && sel.length) ranges.push(Decoration.mark({ class: 'mdr-sel-mark' }).range(from + i, from + i + sel.length));
        }
      }
      const key = [v.path, c.id, c.state, c.thread.length, (c.thread[c.thread.length - 1] || {}).at, c.readAt, r.status, r.start, r.end, r.current || '',
        this.ui.expanded.has(c.id), this.ui.collapsed.has(c.id), isUnread(c), c.thread.map(m => m.id + (m.editedAt || '') + (m.kind || '')).join(','),
        this.ui.editing || '', this.ui.confirmDelete || '', this.agentName()].join('|');
      ranges.push(Decoration.widget({ widget: new ThreadWidget(this, v.path, c, r, key), block: true, side: 1 }).range(below(r.end)));
    }
    if (comp) {
      const rg = comp.range;
      if (rg && rg[0] < rg[1] && rg[1] <= doc.length && comp.selection && comp.selection.trim() !== windowText(doc.toString().split('\n'), comp.start, comp.end - comp.start + 1).trim()) {
        ranges.push(Decoration.mark({ class: 'mdr-sel-mark mdr-sel-new' }).range(rg[0], rg[1]));
      }
      ranges.push(Decoration.widget({ widget: new ComposerWidget(this, comp), block: true, side: 2 }).range(below(comp.end)));
    }
    return Decoration.set(ranges, true);
  }

  selectionTooltip(state) {
    if (!this.settings.selectionButton || this.ui.drag || this.ui.composer) return null;
    const rv = this.reviewField && state.field(this.reviewField, false);
    if (!rv || !rv.value || !rv.value.active) return null;
    const r = state.selection.main; if (r.empty) return null;
    const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
    return { pos: r.head, above: r.head === r.from, strictSide: false, arrow: false,
      create: (view) => {
        if (!this.pathOf(view)) return { dom: el('span', 'mdr-hidden') };
        const dom = el('button', 'mdr-sel-btn', '＋ Comment');
        dom.onmousedown = e => e.preventDefault();
        dom.onclick = e => { e.preventDefault(); this.openComposer(view, a, b, view.state.sliceDoc(r.from, r.to), [r.from, r.to]); };
        return { dom };
      } };
  }

  startDrag(view, line, event) {
    const path = this.pathOf(view); if (!path) return;
    const last = this.ui.lastSel;
    if (event.shiftKey && last && last.path === path) { this.openComposer(view, Math.min(last.start, line), Math.max(last.end, line), null); return; }
    this.ui.composer = null;
    this.ui.drag = { path, origin: line, start: line, end: line };
    this.refreshView(view);
    const move = e => {
      const d = this.ui.drag; if (!d) return;
      const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
      const n = view.state.doc.lineAt(block.from).number;
      const s = Math.min(d.origin, n), en = Math.max(d.origin, n);
      if (s !== d.start || en !== d.end) { d.start = s; d.end = en; this.refreshView(view); }
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      const d = this.ui.drag; this.ui.drag = null;
      if (d) this.openComposer(view, d.start, d.end, null);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  openComposer(view, start, end, selection, range) {
    const path = this.pathOf(view); if (!path) return;
    if (!this.isActive(path)) { this.ui.manualOn.add(path); this.ui.manualOff.delete(path); this.addHeaderActions(); }
    const doc = view.state.doc, a = Math.max(1, Math.min(start, doc.lines)), b = Math.max(a, Math.min(end, doc.lines));
    this.ui.composer = { id: newId('k_'), path, view, start: a, end: b, from: doc.line(a).from, to: doc.line(b).to, selection, range: range || null };
    this.ui.lastSel = { path, start, end };
    this.refreshView(view);
    setTimeout(() => { const t = view.dom.querySelector('.mdr-composer textarea'); if (t) t.focus(); }, 30);
  }
  closeComposer(view) { this.ui.composer = null; this.refreshView(view); view.focus(); }

  // ---------- actions ----------
  // The composer and its text stay until the comment is saved.
  async addComment(view, comp, text) {
    if (comp.gone) { new Notice('md-review: the commented lines were deleted, so the comment is not saved. Your text stays in the box; close it and comment again.'); return; }
    const doc = view.state.doc, lines = doc.toString().split('\n');
    const paths = headingPaths(lines);
    const start = comp.from != null ? doc.lineAt(Math.min(comp.from, doc.length)).number : comp.start;
    const end = Math.max(start, comp.to != null ? doc.lineAt(Math.min(comp.to, doc.length)).number : comp.end);
    const at = nowIso();
    const ok = await this.mutate(comp.path, d => { d.comments.push({
      id: newId('c_'), createdAt: at, state: 'open', readAt: at,
      anchor: buildAnchor(lines, paths, start, end, comp.selection),
      thread: [{ id: newId('m_'), author: 'user', at, text }]
    }); });
    if (!ok) return;
    delete this.ui.drafts['new:' + comp.path];
    if (this.ui.composer === comp) this.ui.composer = null;
    try { view.dispatch({ selection: { anchor: view.state.selection.main.head } }); } catch (e) { /* view gone */ }
    this.refreshView(view);
  }
  // Re-anchors a comment to the lines of the current editor selection; the
  // thread stays as it is.
  async reattach(view, path, id) {
    const sel = view.state.selection.main;
    if (sel.empty) { new Notice('Select the new place in the note first, then click "Attach to selection".'); return; }
    const doc = view.state.doc, lines = doc.toString().split('\n');
    const start = doc.lineAt(sel.from).number, end = doc.lineAt(sel.to).number;
    const text = view.state.sliceDoc(sel.from, sel.to);
    await this.mutate(path, d => { const c = this.find(d, id); if (!c) return false; c.anchor = buildAnchor(lines, headingPaths(lines), start, end, text); });
  }
  agentName() { return (this.settings.agentName || '').trim() || 'Agent'; }
  // Send is the only commit: the optional verdict flag rides on the message.
  // Send & Resolve (resolve = true) closes the thread at once. After Accept the
  // message also carries resolveAfterApply: the agent still applies the change
  // in the resolved thread.
  // The draft is taken out before the save, so the re-render after a saved
  // reply shows an empty box; a failed save puts it back (the box itself is
  // not re-rendered then and still shows the text).
  // A verdict answers the agent message the user saw (seenAgentId). When the
  // file already holds a newer agent message, the verdict is not saved: the
  // thread re-renders with the new message and the user decides again.
  async reply(path, id, text, verdict, resolve, seenAgentId) {
    const draft = this.ui.drafts[id], flag = this.ui.flags[id];
    delete this.ui.drafts[id]; delete this.ui.flags[id];
    if (resolve) this.ui.expanded.delete(id);
    let stale = false;
    const ok = await this.mutate(path, d => {
      const c = this.find(d, id); if (!c) return false;
      if (verdict && seenAgentId != null && lastAgentId(c) !== seenAgentId) { stale = true; return false; }
      const msg = { id: newId('m_'), author: 'user', at: nowIso(), text: text || '' };
      if (verdict) msg.verdict = verdict;
      if (resolve && verdict === 'accept') msg.resolveAfterApply = true;
      c.thread.push(msg);
      c.readAt = msg.at;
      if (resolve) c.state = 'resolved';
      else if (c.state === 'addressed') c.state = 'open';
    });
    if (!ok) {
      if (draft != null) this.ui.drafts[id] = draft;
      if (flag) this.ui.flags[id] = flag;
    }
    if (stale) {
      if (resolve) this.ui.expanded.add(id);
      new Notice(`md-review: ${this.agentName()} wrote a new message in this thread. Your verdict was not saved; read the new message and decide again.`);
      this.refreshNote(path);
    }
  }
  // Resolve and Reopen set the state the button showed, never toggle it: a
  // second click, or a change from the agent in between, cannot flip it back.
  // Resolving always collapses the thread, even when it was expanded earlier
  // with "show" or from the panel.
  async setResolved(path, id, resolved) {
    if (resolved) this.ui.expanded.delete(id);
    await this.mutate(path, d => {
      const c = this.find(d, id); if (!c) return false;
      const want = resolved ? 'resolved' : 'open';
      if (c.state === want) return false;
      c.state = want; c.readAt = nowIso();
    });
  }
  async editMessage(path, id, msgId, text) {
    const ok = await this.mutate(path, d => {
      const c = this.find(d, id); const m = c && c.thread.find(x => x.id === msgId);
      if (!m || m.author !== 'user') return false;
      m.text = text; m.editedAt = nowIso();
    });
    if (!ok) return;
    delete this.ui.drafts['edit:' + msgId];
    this.ui.editing = null;
    this.refreshNote(path);
  }
  // Deleting the first message deletes the whole thread.
  async deleteMessage(path, id, msgId) {
    this.ui.confirmDelete = null;
    await this.mutate(path, d => {
      const c = this.find(d, id); if (!c) return false;
      const i = c.thread.findIndex(x => x.id === msgId);
      if (i < 0 || c.thread[i].author !== 'user') return false;
      if (i === 0) d.comments = d.comments.filter(x => x.id !== id);
      else c.thread.splice(i, 1);
    });
  }
  async markRead(path, id) {
    const c = this.find(this.data(path) || { comments: [] }, id);
    if (!c || !isUnread(c)) return;
    await this.mutate(path, d => { const x = this.find(d, id); if (!x) return false; x.readAt = nowIso(); });
  }

  // ---------- rendering ----------
  renderThread(view, path, c, r, comp) {
    const box = el('div', 'mdr-thread');
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => view.requestMeasure());
      ro.observe(box); comp.register(() => ro.disconnect());
    }
    box.dataset.state = c.state;
    if (startedByAgent(c)) box.dataset.origin = 'agent';
    const start = Math.max(1, r.start), end = Math.max(start, r.end);
    if (c.state !== 'resolved' && this.ui.collapsed.has(c.id)) {
      box.appendChild(this.renderCollapsedOpen(view, path, c, start, end));
      return box;
    }
    if (c.state === 'resolved' && !this.ui.expanded.has(c.id)) {
      const pending = pendingApply(c) ? ` · ${this.agentName()} applies the accepted change` : '';
      const line = el('div', 'mdr-collapsed', `✓ Resolved · ${rangeLabel(start, end)} · ${c.thread.length} message(s)${pending} · show`);
      line.onclick = () => { this.ui.expanded.add(c.id); this.refreshView(view); };
      box.appendChild(line);
      return box;
    }

    const agent = this.agentName(), turn = turnOf(c);
    box.dataset.turn = turn;
    const head = el('div', 'mdr-head');
    head.appendChild(el('span', 'mdr-head-title', startedByAgent(c) ? `❓ ${agent} asks · ${rangeLabel(start, end)}` : '💬 ' + rangeLabel(start, end)));
    head.appendChild(this.turnChip(c));
    const verdict = lastVerdict(c);
    if (verdict && turn === 'agent') head.appendChild(el('span', 'mdr-chip mdr-v-' + verdict, VERDICT_LABELS[verdict] || verdict));
    if (r.status === 'changed' || r.status === 'outdated') head.appendChild(el('span', 'mdr-chip mdr-st-' + r.status, r.status === 'changed' ? 'Changed' : 'Outdated'));
    if (isUnread(c)) {
      const fresh = el('span', 'mdr-chip mdr-new', '● New · mark read');
      fresh.onclick = () => this.markRead(path, c.id);
      head.appendChild(fresh);
    }
    head.appendChild(el('span', 'mdr-spacer'));
    if (c.state === 'resolved') {
      const hide = el('span', 'mdr-link', 'hide');
      hide.onclick = () => { this.ui.expanded.delete(c.id); this.refreshView(view); };
      head.appendChild(hide);
    } else {
      const fold = el('span', 'mdr-link', '▴ collapse');
      fold.title = 'Alt-click: collapse all threads in this note';
      fold.onclick = e => { if (e.altKey) this.setAllCollapsed(path, true); else { this.ui.collapsed.add(c.id); this.refreshView(view); this.refreshPanels(); } };
      head.appendChild(fold);
    }
    const res = el('button', 'mdr-btn mdr-btn-flat', c.state === 'resolved' ? 'Reopen' : '✓ Resolve');
    res.onclick = () => this.setResolved(path, c.id, c.state !== 'resolved');
    head.appendChild(res);
    box.appendChild(head);

    if (r.status === 'changed') {
      const diff = el('div', 'mdr-quote mdr-diff');
      for (const p of diffParts(c.anchor.quote, r.current)) diff.appendChild(el(p.op === 'eq' ? 'span' : p.op, '', p.text));
      box.appendChild(diff);
      box.appendChild(el('div', 'mdr-note', 'The commented text changed after the comment (red: before, green: now).'));
    } else if (r.status === 'outdated') {
      box.appendChild(el('div', 'mdr-quote', c.anchor.quote));
      const where = r.where === 'section' ? `at the section "${c.anchor.section}"` : `near its old line ${r.start}`;
      box.appendChild(el('div', 'mdr-note', `The commented lines are gone. Shown ${where}. Select the new place in the note, then attach.`));
      const attach = el('button', 'mdr-btn', 'Attach to selection');
      attach.onmousedown = e => e.preventDefault();
      attach.onclick = () => this.reattach(view, path, c.id);
      box.appendChild(attach);
    }

    c.thread.forEach((m, idx) => {
      const row = el('div', 'mdr-msg');
      const fromAgent = isAgent(m);
      row.appendChild(el('div', 'mdr-av ' + (fromAgent ? 'mdr-av-agent' : 'mdr-av-user'), fromAgent ? agent.charAt(0).toUpperCase() : 'Y'));
      const body = el('div', 'mdr-msg-body');
      const who = el('div', 'mdr-who', fromAgent ? agent : 'You');
      who.appendChild(el('span', 'mdr-time', shortTime(m.at) + (m.editedAt ? ' · edited' : '')));
      if (fromAgent && KIND_LABELS[m.kind]) who.appendChild(el('span', 'mdr-chip mdr-kind-' + m.kind, KIND_LABELS[m.kind]));
      if (m.verdict) who.appendChild(el('span', 'mdr-chip mdr-v-' + m.verdict, VERDICT_LABELS[m.verdict] || m.verdict));
      const own = m.author === 'user';
      if (own && this.ui.editing !== m.id && this.ui.confirmDelete !== m.id) {
        const tools = el('span', 'mdr-msg-tools');
        const edit = el('span', 'mdr-link', 'Edit');
        edit.onclick = () => { this.ui.editing = m.id; this.ui.confirmDelete = null; this.refreshView(view); };
        const del = el('span', 'mdr-link mdr-danger', 'Delete');
        del.onclick = () => { this.ui.confirmDelete = m.id; this.ui.editing = null; this.refreshView(view); };
        tools.append(edit, del);
        who.appendChild(tools);
      }
      body.appendChild(who);
      if (own && this.ui.editing === m.id) {
        const ta = el('textarea', 'mdr-input');
        const draftKey = 'edit:' + m.id;
        ta.rows = 2; ta.value = this.ui.drafts[draftKey] != null ? this.ui.drafts[draftKey] : m.text;
        this.bindImages(ta, path);
        const save = el('button', 'mdr-btn mod-cta', 'Save');
        const cancel = el('button', 'mdr-btn', 'Cancel');
        const ok = () => ta.value.trim().length > 0 || !!m.verdict;
        ta.oninput = () => { this.ui.drafts[draftKey] = ta.value; save.disabled = !ok(); };
        save.onclick = () => { if (ok()) this.editMessage(path, c.id, m.id, ta.value.trim()); };
        cancel.onclick = () => { delete this.ui.drafts[draftKey]; this.ui.editing = null; this.refreshView(view); };
        ta.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.click(); if (e.key === 'Escape') cancel.click(); };
        const bar = el('div', 'mdr-row mdr-row-tight');
        bar.append(el('span', 'mdr-spacer'), cancel, save);
        body.append(ta, bar);
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 20);
      } else if (m.text) {
        body.appendChild(this.renderText(view, path, m.text, comp, text => this.quoteInto(box, text)));
      }
      if (own && this.ui.confirmDelete === m.id) {
        const bar = el('div', 'mdr-row mdr-row-tight mdr-confirm');
        bar.appendChild(el('span', '', idx === 0 ? 'Delete the whole thread?' : 'Delete this message?'));
        const yes = el('button', 'mdr-btn mdr-btn-danger', 'Delete');
        const no = el('button', 'mdr-btn', 'Cancel');
        yes.onclick = () => this.deleteMessage(path, c.id, m.id);
        no.onclick = () => { this.ui.confirmDelete = null; this.refreshView(view); };
        bar.append(el('span', 'mdr-spacer'), no, yes);
        body.appendChild(bar);
      }
      row.appendChild(body);
      box.appendChild(row);
    });

    if (c.state === 'resolved') return box;
    if (this.settings.agentMode) {
      const next = el('div', 'mdr-next mdr-next-' + turn, (turn === 'you' ? '→ ' : '⏳ ') + nextStep(c, agent));
      // The agent reads the threads only when asked: the waiting thread offers the prompt.
      if (turn === 'agent') {
        const copy = el('button', 'mdr-btn mdr-next-copy', 'Copy prompt for your agent');
        copy.title = `Paste it to ${agent}; the reply appears here`;
        copy.onclick = () => this.copyPrompt(path);
        next.appendChild(copy);
      }
      box.appendChild(next);
    }
    box.appendChild(this.renderReplyBox(path, c));
    this.bindSelectionQuote(box, comp);
    return box;
  }

  // Message text as Obsidian Markdown: code blocks, lists, links. Rendering is
  // async, so the editor re-measures the widget height when it finishes. The
  // editor does not handle clicks inside widgets, so internal links open here.
  renderText(view, path, text, comp, onQuote) {
    const box = el('div', 'mdr-text mdr-md markdown-rendered');
    const done = MarkdownRenderer.render
      ? MarkdownRenderer.render(this.app, text, box, path, comp)
      : MarkdownRenderer.renderMarkdown(text, box, path, comp);
    Promise.resolve(done).then(() => { if (onQuote) addPointQuotes(box, onQuote); view.requestMeasure(); }, () => { box.textContent = text; });
    // Embedded images load after the render finishes and change the height.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => view.requestMeasure());
      ro.observe(box); comp.register(() => ro.disconnect());
    }
    box.addEventListener('click', e => {
      const emb = e.target.closest('.internal-embed.image-embed');
      if (emb && emb.getAttribute('src')) { e.preventDefault(); this.app.workspace.openLinkText(emb.getAttribute('src'), path, true); return; }
      const a = e.target.closest('a.internal-link');
      if (!a) return;
      e.preventDefault();
      this.app.workspace.openLinkText(a.getAttribute('data-href') || a.getAttribute('href'), path, e.metaKey || e.ctrlKey);
    });
    return box;
  }

  // Quote reply: a point or a selection of a message goes into the thread's
  // reply box as a "> " quote, followed by an empty line for the answer (without
  // it Markdown would continue the quote with the answer).
  quoteInto(box, text) {
    const ta = box.querySelector('textarea.mdr-reply');
    if (!ta || !text.trim()) return;
    const quote = text.trim().split('\n').map(l => '> ' + l).join('\n');
    const v = ta.value.replace(/\s+$/, '');
    ta.value = (v ? v + '\n\n' : '') + quote + '\n\n';
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }
  // A "❝ Quote" button above a text selection inside the thread's messages.
  bindSelectionQuote(box, comp) {
    const btn = el('button', 'mdr-selq', '❝ Quote');
    box.appendChild(btn);
    const inMsg = n => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && e.closest('.mdr-text') && box.contains(e)); };
    const hide = () => { btn.style.display = 'none'; };
    const place = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !inMsg(sel.anchorNode) || !inMsg(sel.focusNode)) { hide(); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect(), b = box.getBoundingClientRect();
      btn.style.display = 'block';
      const top = r.top - b.top - btn.offsetHeight - 4;
      btn.style.top = (top >= 0 ? top : r.bottom - b.top + 4) + 'px';
      btn.style.left = Math.max(4, Math.min(r.right - b.left - btn.offsetWidth, b.width - btn.offsetWidth - 4)) + 'px';
    };
    box.addEventListener('mouseup', () => setTimeout(place, 0));
    comp.registerDomEvent(document, 'selectionchange', () => { if (btn.style.display === 'block') { const s = window.getSelection(); if (!s || s.isCollapsed || !inMsg(s.anchorNode)) hide(); } });
    btn.onmousedown = e => e.preventDefault();
    btn.onclick = () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      const a = sel && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      const li = a && a.closest('.mdr-text li');
      hide();
      if (sel) sel.removeAllRanges();
      this.quoteInto(box, (li ? pointLabel(li) : '') + text);
    };
  }

  // One line for an open thread the user collapsed: where, whose turn, how
  // many messages, and the start of the first message. A click expands it.
  renderCollapsedOpen(view, path, c, start, end) {
    const line = el('div', 'mdr-collapsed mdr-collapsed-open');
    line.title = 'Click to expand · Alt-click: expand all open threads in this note';
    line.appendChild(el('span', 'mdr-collapsed-where', (startedByAgent(c) ? '❓ ' : '💬 ') + rangeLabel(start, end)));
    line.appendChild(this.turnChip(c));
    if (isUnread(c)) line.appendChild(el('span', 'mdr-chip mdr-new', '● New'));
    const first = (c.thread[0] && c.thread[0].text || '').replace(/!\[\[[^\]]*\]\]/g, '🖼').replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();
    line.appendChild(el('span', 'mdr-snippet', first));
    line.appendChild(el('span', 'mdr-collapsed-count', `${c.thread.length} msg · ▾ show`));
    line.onclick = e => { if (e.altKey) this.setAllCollapsed(path, false); else { this.ui.collapsed.delete(c.id); this.refreshView(view); this.refreshPanels(); } };
    return line;
  }
  // Collapse (true) or expand (false) every thread of a note. Expanding shows
  // the open threads; resolved ones stay one line, as by default.
  setAllCollapsed(path, collapse) {
    const d = path && this.data(path);
    if (!d) { new Notice('Open a note with review comments first.'); return; }
    for (const c of d.comments) {
      if (c.state === 'resolved') { if (collapse) this.ui.expanded.delete(c.id); }
      else if (collapse) this.ui.collapsed.add(c.id); else this.ui.collapsed.delete(c.id);
    }
    this.refreshNote(path);
  }
  allCollapsed(path) {
    const d = path && this.data(path);
    const open = d ? d.comments.filter(c => c.state !== 'resolved') : [];
    return open.length > 0 && open.every(c => this.ui.collapsed.has(c.id));
  }

  turnChip(c) {
    if (!this.settings.agentMode) return el('span', 'mdr-chip mdr-turn-' + (c.state === 'resolved' ? 'resolved' : 'open'), c.state === 'resolved' ? 'Resolved' : 'Open');
    const t = turnOf(c);
    return el('span', 'mdr-chip mdr-turn-' + t, t === 'you' ? 'Your turn' : t === 'agent' ? `${this.agentName()}'s turn` : 'Resolved');
  }

  // Reply box. Under a proposal it carries the Accept / Reject flags. Send (or
  // Enter) commits. The Resolve button next to Send becomes "Send & Resolve"
  // (or Cmd/Ctrl+Enter) once there is something to send.
  renderReplyBox(path, c) {
    const foot = el('div', 'mdr-foot');
    const ta = el('textarea', 'mdr-input mdr-reply');
    ta.rows = 1;
    const mod = modKey();
    ta.placeholder = `Reply… (Enter to send, ${mod}Enter to send and resolve, Shift+Enter for a new line, ${mod}V or drop to attach an image)`;
    ta.value = this.ui.drafts[c.id] || '';
    this.bindImages(ta, path);
    const row = el('div', 'mdr-row mdr-row-tight');
    const send = el('button', 'mdr-btn mod-cta', 'Send');
    const resolveBtn = el('button', 'mdr-btn mdr-btn-ok');
    const agentOn = this.settings.agentMode;
    const verdictMode = agentOn && needsVerdict(c), checkMode = agentOn && needsCheck(c);
    let summary = null;
    const flagBtns = [];
    const canSend = () => !!ta.value.trim() || (verdictMode && !!this.ui.flags[c.id]);
    const update = () => {
      send.disabled = !canSend();
      const f = this.ui.flags[c.id];
      resolveBtn.textContent = canSend() ? 'Send & Resolve' : checkMode ? '✓ Looks good — Resolve' : '✓ Resolve';
      resolveBtn.title = verdictMode && f === 'accept' ? `Resolves now; ${this.agentName()} still applies the change` : '';
      for (const b of flagBtns) {
        const on = b.dataset.flag === f;
        b.classList.toggle('is-on', on);
        b.firstChild.textContent = on ? '☑' : '☐';
      }
      if (summary) summary.textContent = f ? (f === 'accept' ? 'sends ✓ Accept' : 'sends ✗ Reject') + (ta.value.trim() ? ' + comment' : '') : 'no flag = discussion';
    };
    // The agent message on screen when the box was drawn; the verdict answers it.
    const seen = lastAgentId(c);
    const submit = () => {
      if (!canSend()) return;
      this.reply(path, c.id, ta.value.trim(), verdictMode ? this.ui.flags[c.id] : undefined, false, seen);
    };
    const submitAndResolve = () => {
      if (!canSend()) { this.setResolved(path, c.id, true); return; }
      this.reply(path, c.id, ta.value.trim(), verdictMode ? this.ui.flags[c.id] : undefined, true, seen);
    };
    if (verdictMode) {
      row.appendChild(el('span', 'mdr-hint', 'Verdict:'));
      for (const [k, label] of [['accept', 'Accept'], ['reject', 'Reject']]) {
        const b = el('span', 'mdr-flag mdr-flag-' + k);
        b.dataset.flag = k;
        b.append(el('span', 'mdr-flag-box', '☐'), document.createTextNode(label));
        b.onclick = () => { this.ui.flags[c.id] = this.ui.flags[c.id] === k ? undefined : k; update(); ta.focus(); };
        flagBtns.push(b); row.appendChild(b);
      }
      row.appendChild(el('span', 'mdr-spacer'));
      summary = el('span', 'mdr-hint');
      row.append(summary, send, resolveBtn);
    } else if (checkMode) {
      send.textContent = 'Send (reopens)';
      send.classList.remove('mod-cta');
      row.append(el('span', 'mdr-spacer'), send, resolveBtn);
    } else {
      row.append(el('span', 'mdr-spacer'), send, resolveBtn);
    }
    // The box grows with its text (quotes make it long), up to about 14 lines.
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px'; };
    ta.oninput = () => { this.ui.drafts[c.id] = ta.value; update(); grow(); };
    if (ta.value.includes('\n')) requestAnimationFrame(grow);
    ta.onkeydown = e => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) submitAndResolve(); else submit();
    };
    send.onclick = submit;
    resolveBtn.onclick = submitAndResolve;
    update();
    foot.append(ta, row);
    return foot;
  }

  renderComposer(view, comp) {
    const box = el('div', 'mdr-thread mdr-composer');
    const head = el('div', 'mdr-head');
    head.appendChild(el('span', 'mdr-head-title', '💬 New comment · ' + rangeLabel(comp.start, comp.end)));
    box.appendChild(head);
    const ta = el('textarea', 'mdr-input');
    ta.rows = 3; ta.placeholder = 'Leave a comment';
    // One draft per note: a new + or Shift-click carries the text over, Esc keeps it.
    const draftKey = 'new:' + comp.path;
    ta.value = this.ui.drafts[draftKey] || '';
    this.bindImages(ta, comp.path);
    const foot = el('div', 'mdr-row');
    const mod = modKey();
    const hint = el('span', 'mdr-hint', `${mod}Enter to submit · Esc closes and keeps the text · ${mod}V or drop to attach an image`);
    const cancel = el('button', 'mdr-btn', 'Cancel');
    const submit = el('button', 'mdr-btn mod-cta', 'Comment');
    submit.disabled = !ta.value.trim();
    ta.oninput = () => { this.ui.drafts[draftKey] = ta.value; submit.disabled = !ta.value.trim(); };
    const go = () => { const t = ta.value.trim(); if (!t) return; this.addComment(view, comp, t); };
    submit.onclick = go;
    cancel.onclick = () => { delete this.ui.drafts[draftKey]; this.closeComposer(view); };
    ta.onkeydown = e => { if (e.isComposing) return; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } if (e.key === 'Escape') { e.preventDefault(); this.closeComposer(view); } };
    foot.append(hint, el('span', 'mdr-spacer'), cancel, submit);
    box.append(ta, foot);
    return box;
  }

  // ---------- panel, status, badges ----------
  async activatePanel() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
  // Adds the Review tab to the right sidebar (next to Outline) without focusing it.
  async ensurePanel() {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length) return;
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: false });
  }
  // A panel tab that was never shown is a deferred view without requestRender;
  // it renders itself when it opens.
  refreshPanels() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (typeof leaf.view.requestRender === 'function') leaf.view.requestRender(); }
  updateStatus() {
    const p = this.lastNotePath, n = p ? this.index.get(p) : null;
    const parts = [];
    if (n && n.mine && this.settings.agentMode) parts.push(`💬 ${n.mine} your turn${n.fresh ? ' · ' + n.fresh + ' new' : ''}`);
    else if (n && n.open) parts.push(`💬 ${n.open} open`);
    if (this.reviewMode) parts.push('🔒 Review mode');
    this.statusEl.setText(parts.join('  '));
    this.statusEl.toggleClass('mdr-hidden', parts.length === 0);
  }
  updateBadges() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
        const items = leaf.view.fileItems || {};
        for (const p of Object.keys(items)) {
          const host = items[p].selfEl || items[p].titleEl; if (!host) continue;
          let badge = host.querySelector(':scope > .mdr-badge');
          const n = this.index.get(p);
          if (!n || !n.open) { if (badge) badge.remove(); continue; }
          if (!badge) { badge = el('span', 'mdr-badge'); host.appendChild(badge); }
          badge.textContent = n.fresh ? `${n.open} · ${n.fresh} new` : `${n.open}`;
          badge.classList.toggle('mdr-has-new', n.fresh > 0);
        }
      }
    } catch (e) { console.warn('md-review: explorer badges unavailable', e); }
  }
  toggleReviewMode() {
    this.reviewMode = !this.reviewMode;
    this.readOnlyExt.length = 0;
    if (this.reviewMode) this.readOnlyExt.push(EditorState.readOnly.of(true));
    this.app.workspace.updateOptions();
    new Notice(this.reviewMode ? 'Review mode on: the editor is read-only.' : 'Review mode off.');
    this.updateStatus();
  }
  // The prompt names the note, its review file, the threads that wait for the
  // agent (line and the start of the last user message) and where the rules are.
  buildPrompt(p) {
    const d = this.data(p) || { comments: [] };
    const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view.file && l.view.file.path === p);
    const cm = leaf && leaf.view.editor && leaf.view.editor.cm;
    const where = new Map((cm ? this.resolvedFor(p, cm.state.doc) : []).map(x => [x.c.id, x.r.start]));
    const waiting = d.comments.filter(c => turnOf(c) === 'agent' || pendingApply(c)).map(c => {
      const last = [...c.thread].reverse().find(m => !isAgent(m) && (m.text || '').trim()) || {};
      let t = (last.text || (pendingApply(c) ? 'accepted proposal' : c.anchor.quote) || '').replace(/!\[\[[^\]]*\]\]/g, '[image]').replace(/\s+/g, ' ').trim();
      if (t.length > 40) t = t.slice(0, 40).trimEnd() + '…';
      return `L${where.get(c.id) || c.anchor.lineHint} "${t}"`;
    });
    const n = waiting.length;
    const waitText = n ? `${n} thread${n > 1 ? 's' : ''} wait${n > 1 ? '' : 's'} for you: ${waiting.join(', ')}.` : 'No thread waits for you right now.';
    const url = (this.settings.protocolUrl || '').trim();
    const protocol = 'the md-review skill' + (url ? ` (without the skill, read ${url})` : '');
    return (this.settings.promptTemplate || DEFAULT_PROMPT)
      .replace(/\{note\}/g, p).replace(/\{sidecar\}/g, sidecarPath(p)).replace(/\{waiting\}/g, waitText).replace(/\{protocol\}/g, protocol);
  }
  async copyPrompt(path) {
    const p = path || this.lastNotePath; if (!p) { new Notice('Open a note first.'); return; }
    await navigator.clipboard.writeText(this.buildPrompt(p));
    new Notice('Prompt for the agent copied.');
    this.promptCopied = true; this.refreshPanels();
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => { this.promptCopied = false; this.refreshPanels(); }, 1500);
  }
  async jumpTo(path, c) {
    let leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view.file && l.view.file.path === path);
    if (!leaf) {
      if (!this.app.vault.getAbstractFileByPath(path)) { new Notice(`md-review: ${path} no longer exists.`); return; }
      await this.app.workspace.openLinkText(path, '', false); leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view.file && l.view.file.path === path);
    }
    if (!leaf) return;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (!this.isActive(path)) this.setNoteReview(path, true);
    const ed = leaf.view.editor, cm = ed && ed.cm; if (!cm) return;
    const item = this.resolvedFor(path, cm.state.doc).find(x => x.c.id === c.id);
    const start = item ? item.r.start : c.anchor.lineHint, end = item ? item.r.end : start;
    if (c.state === 'resolved') this.ui.expanded.add(c.id);
    this.ui.collapsed.delete(c.id);
    ed.setCursor({ line: start - 1, ch: 0 });
    ed.scrollIntoView({ from: { line: start - 1, ch: 0 }, to: { line: end - 1, ch: 0 } }, true);
    this.refreshView(cm);
  }
}

class ReviewPanel extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.filter = plugin.settings.agentMode ? 'you' : 'open'; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Review'; }
  getIcon() { return 'message-square'; }
  async onOpen() {
    // A click on the panel activates it, which re-renders the panel between mousedown and mouseup and
    // drops the click. Defer re-rendering while the pointer is pressed inside the panel.
    this.pressed = false;
    const release = () => { this.pressed = false; if (this.pending) { this.pending = false; setTimeout(() => this.render(), 0); } };
    this.registerDomEvent(this.contentEl, 'pointerdown', () => { this.pressed = true; });
    this.registerDomEvent(document, 'pointerup', release);
    this.registerDomEvent(document, 'pointercancel', release);
    this.render();
  }
  async onClose() { this.hidePeek(); }
  // Hover preview of a card: the last message of the thread, shortened.
  showPeek(card, c) {
    this.hidePeek();
    const last = c.thread[c.thread.length - 1];
    if (!last) return;
    const agent = this.plugin.agentName();
    const hasText = m => !!(m.text || '').trim();
    // A verdict-only message (Accept / Reject without a comment) becomes a
    // status line; the body shows the latest message that has text.
    const shown = hasText(last) ? last : [...c.thread].reverse().find(hasText) || last;
    const pop = document.body.createDiv('mdr-peek mdr-peek-' + turnOf(c) + (startedByAgent(c) ? ' mdr-card-ask' : ''));
    const head = pop.createDiv('mdr-peek-head');
    head.appendChild(this.plugin.turnChip(c));
    head.createSpan({ cls: 'mdr-peek-count', text: `${c.thread.length} msg · L${c.anchor.lineHint}` });
    const who = (m, parent) => {
      const row = parent.createDiv('mdr-peek-who-row');
      row.createSpan({ cls: 'mdr-peek-who' + (isAgent(m) ? ' is-agent' : ''), text: isAgent(m) ? agent : 'You' });
      row.createSpan({ cls: 'mdr-time', text: shortTime(m.at) });
      if (isAgent(m) && KIND_LABELS[m.kind]) row.createSpan({ cls: 'mdr-chip mdr-kind-' + m.kind, text: KIND_LABELS[m.kind] });
      if (m.verdict) row.createSpan({ cls: 'mdr-chip mdr-v-' + m.verdict, text: VERDICT_LABELS[m.verdict] || m.verdict });
      return row;
    };
    if (shown !== last) who(last, pop.createDiv('mdr-peek-status'));
    const body = pop.createDiv('mdr-peek-body');
    who(shown, body);
    let text = (shown.text || '').replace(/!\[\[[^\]]*\]\]/g, '🖼').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > 600) text = text.slice(0, 600).trimEnd() + '…';
    body.createDiv({ cls: 'mdr-peek-text', text: text || '(no text)' });
    // Left of the panel when there is room, otherwise under the card.
    const r = card.getBoundingClientRect(), w = Math.min(400, window.innerWidth - 16);
    pop.style.width = w + 'px';
    const left = r.left - w - 10;
    if (left >= 8) { pop.style.left = left + 'px'; pop.style.top = Math.max(8, Math.min(r.top, window.innerHeight - pop.offsetHeight - 8)) + 'px'; }
    else { pop.style.left = Math.max(8, r.right - w) + 'px'; pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px'; }
    this.peek = pop;
  }
  hidePeek() { clearTimeout(this.peekTimer); if (this.peek) { this.peek.remove(); this.peek = null; } }
  // Header item: icon plus a label that the container query hides when the panel is narrow.
  headItem(parent, tag, cls, icon, label, aria) {
    const e = parent.createEl(tag, { cls, attr: { 'aria-label': aria } });
    const i = e.createSpan('mdr-ico'); setIcon(i, icon);
    e.createSpan({ cls: 'mdr-label', text: label });
    return e;
  }
  // First run: what the plugin does and whether an agent answers the comments.
  renderWelcome(root) {
    const box = root.createDiv('mdr-welcome');
    box.createDiv({ cls: 'mdr-welcome-title', text: 'Welcome to MD Review' });
    box.createDiv({ text: 'Comment on lines of a note and discuss them in threads, like a review on GitHub. The comments live in a JSON file next to the note.' });
    box.createDiv({ cls: 'mdr-welcome-q', text: 'Does an AI agent answer your comments?' });
    const row = box.createDiv('mdr-row');
    const pick = async agentMode => {
      Object.assign(this.plugin.settings, { agentMode, onboarded: true });
      this.filter = agentMode ? 'you' : 'open';
      await this.plugin.saveSettings(); this.plugin.refreshPanels(); this.plugin.updateStatus();
    };
    row.createEl('button', { cls: 'mdr-btn mod-cta', text: 'Yes, an agent replies' }).onclick = () => pick(true);
    row.createEl('button', { cls: 'mdr-btn', text: 'No, I review by hand' }).onclick = () => pick(false);
    box.createDiv({ cls: 'mdr-hint', text: 'With an agent, threads show whose turn it is, and you accept or reject its proposals. You can change this in the settings.' });
  }
  // Empty note: how to start a review.
  renderSteps(root, agentOn) {
    const box = root.createDiv('mdr-steps');
    box.createDiv({ cls: 'mdr-steps-title', text: 'No comments yet. To comment:' });
    const ol = box.createEl('ol');
    ol.createEl('li', { text: 'Hover a line and click the + on its left; drag the + to take several lines.' });
    ol.createEl('li', { text: 'Or select text and click "＋ Comment".' });
    ol.createEl('li', { text: 'Or run the command "Add review comment on selected lines".' });
    if (agentOn) ol.createEl('li', { text: 'Then click "Copy prompt" and paste it to your agent. Its replies appear in the threads.' });
  }
  requestRender() { if (this.pressed) this.pending = true; else this.render(); }
  render() {
    this.hidePeek();
    const root = this.contentEl; root.empty(); root.addClass('mdr-panel');
    const plugin = this.plugin, agent = plugin.agentName();
    const path = plugin.lastNotePath, data = path ? plugin.data(path) : null;
    const head = root.createDiv('mdr-panel-head');
    head.createSpan({ text: 'Review' });
    const n = path ? plugin.index.get(path) : null;
    if (n && n.mine && plugin.settings.agentMode) {
      const cnt = head.createSpan({ cls: 'mdr-count', attr: { 'aria-label': `${n.mine} thread(s) wait for you` } });
      setIcon(cnt.createSpan('mdr-ico'), 'message-square');
      cnt.createSpan({ text: String(n.mine) });
      cnt.createSpan({ cls: 'mdr-label', text: ' your turn' });
    }
    if (path && plugin.data(path) && plugin.data(path).comments.some(c => c.state !== 'resolved')) {
      const all = plugin.allCollapsed(path);
      const fold = this.headItem(head, 'button', 'mdr-btn mdr-fold-all', all ? 'chevrons-up-down' : 'chevrons-down-up',
        all ? 'Expand all' : 'Collapse all', all ? 'Expand all open threads in the note' : 'Collapse all threads in the note to one line each');
      fold.onclick = () => plugin.setAllCollapsed(path, !all);
    }
    const agentOn = plugin.settings.agentMode;
    if (agentOn) {
      const copied = !!plugin.promptCopied;
      const copy = this.headItem(head, 'button', 'mdr-btn mdr-copy' + (copied ? ' mdr-copied' : ''), copied ? 'check' : 'clipboard-copy',
        copied ? 'Copied' : 'Copy prompt', 'Copy the prompt for the agent');
      copy.onclick = () => plugin.copyPrompt();
    }
    if (!plugin.settings.onboarded) this.renderWelcome(root);
    if (!path) { root.createDiv({ cls: 'mdr-hint', text: 'Open a note to see its review.' }); return; }
    root.createDiv({ cls: 'mdr-panel-file', text: path });

    const active = plugin.isActive(path);
    const comments = data ? data.comments : [];
    if (!active) {
      const off = root.createDiv('mdr-off');
      off.createDiv({ text: comments.length ? `Review is off for this note (${comments.length} thread${comments.length > 1 ? 's' : ''} hidden).` : 'Review is off for this note.' });
      const start = off.createEl('button', { cls: 'mdr-btn mod-cta', text: 'Start review of this note' });
      start.onclick = () => plugin.setNoteReview(path, true);
    }
    if (!comments.length) { if (active) this.renderSteps(root, agentOn); return; }
    const by = t => comments.filter(c => turnOf(c) === t);
    const groups = agentOn
      ? { you: by('you'), agent: by('agent'), resolved: by('resolved'), all: comments }
      : { open: comments.filter(c => c.state !== 'resolved'), resolved: by('resolved'), all: comments };
    if (!groups[this.filter]) this.filter = agentOn ? 'you' : 'open';
    const tabs = root.createDiv('mdr-filters');
    const tabList = agentOn ? [['you', 'Your turn'], ['agent', agent], ['resolved', 'Resolved'], ['all', 'All']] : [['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']];
    for (const [k, label] of tabList) {
      const count = groups[k].length;
      const b = tabs.createEl('button', { cls: (this.filter === k ? 'is-active ' : '') + (k === 'you' && count ? 'mdr-tab-alert' : '') });
      b.createSpan({ text: label });
      if (k !== 'all') b.createSpan({ cls: 'mdr-tab-count', text: String(count) });
      if (k === 'you' && groups.you.some(isUnread)) b.createSpan({ cls: 'mdr-dot mdr-tab-dot' });
      b.onclick = () => { this.filter = k; this.render(); };
    }
    if (agentOn && this.filter !== 'you' && groups.you.length) {
      const nudge = root.createDiv({ cls: 'mdr-nudge', text: `→ ${groups.you.length} thread(s) wait for you · show` });
      nudge.onclick = () => { this.filter = 'you'; this.render(); };
    }

    const list = root.createDiv('mdr-list');
    const items = groups[this.filter] || comments;
    if (!items.length) { list.createDiv({ cls: 'mdr-hint', text: this.filter === 'you' ? 'Nothing waits for you.' : 'No comments in this view.' }); return; }
    const leaf = plugin.app.workspace.getLeavesOfType('markdown').find(l => l.view.file && l.view.file.path === path);
    const cm = leaf && leaf.view.editor && leaf.view.editor.cm;
    const resolved = cm ? plugin.resolvedFor(path, cm.state.doc) : [];
    for (const c of items) {
      const r = (resolved.find(x => x.c.id === c.id) || {}).r || { status: 'ok', start: c.anchor.lineHint, end: c.anchor.lineHint + (c.anchor.lineCount || 1) - 1 };
      const turn = turnOf(c);
      const card = list.createDiv('mdr-card mdr-card-' + turn + (startedByAgent(c) ? ' mdr-card-ask' : ''));
      const top = card.createDiv('mdr-card-top');
      top.createSpan({ cls: 'mdr-card-lines', text: 'L' + r.start + (r.end !== r.start ? '–' + r.end : '') });
      top.appendChild(plugin.turnChip(c));
      const v = lastVerdict(c);
      if (v && turn !== 'you') top.createSpan({ cls: 'mdr-chip mdr-v-' + v, text: VERDICT_LABELS[v] || v });
      if (r.status === 'changed' || r.status === 'outdated') top.createSpan({ cls: 'mdr-chip mdr-st-' + r.status, text: r.status });
      if (isUnread(c)) top.createSpan({ cls: 'mdr-dot', attr: { 'aria-label': `New reply from ${agent}` } });
      card.createDiv({ cls: 'mdr-card-quote', text: (c.anchor.quote || '').split('\n')[0] });
      card.createDiv({ cls: 'mdr-card-text', text: (startedByAgent(c) ? `❓ ${agent}: ` : '') + ((c.thread[0] || {}).text || '') });
      if (agentOn) card.createDiv({ cls: 'mdr-card-next mdr-next-' + turn, text: (turn === 'you' ? '→ ' : turn === 'agent' ? '⏳ ' : '') + nextStep(c, agent) });
      card.onclick = () => { this.hidePeek(); plugin.jumpTo(path, c); };
      card.addEventListener('mouseenter', () => { clearTimeout(this.peekTimer); this.peekTimer = setTimeout(() => this.showPeek(card, c), 300); });
      card.addEventListener('mouseleave', () => this.hidePeek());
    }
  }
}

class ReviewSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    new Setting(containerEl).setName('Agent replies').setDesc('An AI agent answers the comments: threads show whose turn it is, proposals get Accept / Reject, and the panel offers the prompt. Off: plain open and resolved threads.')
      .addToggle(t => t.setValue(this.plugin.settings.agentMode).onChange(async v => { this.plugin.settings.agentMode = v; this.plugin.settings.onboarded = true; await this.plugin.saveSettings(); this.plugin.refreshPanels(); this.plugin.updateStatus(); this.display(); }));
    new Setting(containerEl).setName('Activate review').setDesc('When a note shows the +, the selection button and its threads. The button in the note header switches one note on or off.')
      .addDropdown(d => d.addOptions({ comments: 'In notes with comments', demand: 'On demand', always: 'Always' })
        .setValue(this.plugin.settings.activate).onChange(async v => { this.plugin.settings.activate = v; await this.plugin.saveSettings(); this.plugin.addHeaderActions(); this.plugin.refreshPanels(); }));
    new Setting(containerEl).setName('Line + button').setDesc('Show a + left of the hovered line; drag it to comment a range.')
      .addToggle(t => t.setValue(this.plugin.settings.gutterPlus).onChange(async v => { this.plugin.settings.gutterPlus = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Comment button on text selection').setDesc('Show "＋ Comment" next to a text selection.')
      .addToggle(t => t.setValue(this.plugin.settings.selectionButton).onChange(async v => { this.plugin.settings.selectionButton = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Agent name').setDesc('Shown for replies written by the agent (any author other than "user").')
      .addText(t => t.setPlaceholder('Agent').setValue(this.plugin.settings.agentName).onChange(async v => { this.plugin.settings.agentName = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Review colour').setDesc('Colour of the +, the line markers and the threads.')
      .addDropdown(d => d.addOptions({ orange: 'Orange', blue: 'Blue', green: 'Green', red: 'Red', theme: 'Theme accent' })
        .setValue(this.plugin.settings.accent).onChange(async v => { this.plugin.settings.accent = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Agent question colour').setDesc('Colour of the threads the agent opens with its own question.')
      .addDropdown(d => d.addOptions({ blue: 'Blue', green: 'Green', orange: 'Orange', red: 'Red', theme: 'Theme accent' })
        .setValue(this.plugin.settings.askAccent).onChange(async v => { this.plugin.settings.askAccent = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Thread text size').setDesc('Relative to the note text.')
      .addDropdown(d => d.addOptions({ small: 'Small (80%)', medium: 'Medium (88%)' })
        .setValue(this.plugin.settings.textSize).onChange(async v => { this.plugin.settings.textSize = v; await this.plugin.saveSettings(); }));
    if (!this.plugin.settings.agentMode) return;
    new Setting(containerEl).setName('Prompt template').setDesc('Text of "Copy prompt". {note}: the note, {sidecar}: its review file, {waiting}: the threads that wait for the agent, {protocol}: where the rules are.')
      .addTextArea(t => { t.inputEl.rows = 5; t.inputEl.addClass('mdr-setting-wide');
        t.setValue(this.plugin.settings.promptTemplate).onChange(async v => { this.plugin.settings.promptTemplate = v.trim() || DEFAULT_PROMPT; await this.plugin.saveData(this.plugin.settings); }); })
      .addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('Restore the default').onClick(async () => { this.plugin.settings.promptTemplate = DEFAULT_PROMPT; await this.plugin.saveData(this.plugin.settings); this.display(); }));
    new Setting(containerEl).setName('Protocol link').setDesc('A link to the review file format, for agents without the md-review skill. Goes into {protocol}.')
      .addText(t => t.setPlaceholder('https://…').setValue(this.plugin.settings.protocolUrl).onChange(async v => { this.plugin.settings.protocolUrl = v.trim(); await this.plugin.saveData(this.plugin.settings); }));
  }
}

module.exports = MdReviewPlugin;
module.exports.default = MdReviewPlugin;
// Pure helpers, exported for the Node tests in test/core.test.js.
module.exports.core = { lastAgentId, resolveAnchor, blockEnd, resolveAll, headingPaths, buildAnchor, countOpen, isUnread, needsVerdict, needsCheck, turnOf, agentKind, startedByAgent, lastVerdict, pendingApply, nextStep, normalizeData, diffParts, sidecarPath, assetsDir, imageExt, assetName };
