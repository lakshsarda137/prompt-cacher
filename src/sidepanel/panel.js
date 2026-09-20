import * as db from '../db/db.js';
import { PromptSearch } from '../search/index.js';

const $ = (id) => document.getElementById(id);
const CLAUDE_URL = /^https:\/\/claude\.ai\//;
const CONTENT_SCRIPTS = [
  'src/content/selectors.js',
  'src/content/bridge.js',
  'src/content/extract.js',
  'src/content/composer.js',
  'src/content/main.js',
];

const state = {
  prompts: [],
  filesById: new Map(),
  search: new PromptSearch(),
  query: '',
  form: null, // see openForm()
};

// ---------------------------------------------------------------------------
// Icons (inline SVG, stroke = currentColor)

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  stack: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
};

const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function icon(name) {
  const span = document.createElement('span');
  span.dataset.icon = name;
  span.innerHTML = svg(name);
  return span;
}

// Fills static <span data-icon="…"></span> placeholders in the HTML.
function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]:empty')) node.innerHTML = svg(node.dataset.icon);
}

function extLabel(name) {
  const ext = (name.split('.').pop() || '').toUpperCase();
  return ext && ext.length <= 5 && ext !== name.toUpperCase() ? ext : 'FILE';
}

// ---------------------------------------------------------------------------
// Helpers

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k.includes('-')) node.setAttribute(k, v);
    else if (v !== undefined && v !== null) node[k] = v;
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function showStatus(target, text, isError = false) {
  const box = $(target);
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('error', isError);
}

function defaultTitle(promptText, names) {
  const firstLine = (promptText || '').split('\n').find((l) => l.trim())?.trim();
  if (firstLine) return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  return names[0] || 'Untitled prompt';
}

async function activeClaudeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !CLAUDE_URL.test(tab.url || '')) throw new Error('Switch to a claude.ai tab first.');
  return tab;
}

// Sends a message to our content script, injecting it first if the tab predates the
// extension being installed or reloaded.
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// ---------------------------------------------------------------------------
// Library view

async function loadLibrary() {
  const [prompts, files] = await Promise.all([db.getAll('prompts'), db.getAll('files')]);
  state.prompts = prompts;
  state.filesById = new Map(files.map((f) => [f.id, f]));
  state.search.setDocuments(prompts, state.filesById);
  await renderResults();
  renderLibrarySize();
}

async function renderLibrarySize() {
  try {
    const { usage } = await navigator.storage.estimate();
    $('library-size').textContent = `${state.prompts.length} saved · ${formatBytes(usage)} on disk`;
  } catch {
    $('library-size').textContent = `${state.prompts.length} saved`;
  }
}

let renderToken = 0;
async function renderResults() {
  const token = ++renderToken;
  let ordered;
  if (state.query.trim()) {
    const hits = await state.search.search(state.query);
    if (token !== renderToken) return;
    const byId = new Map(state.prompts.map((p) => [p.id, p]));
    ordered = hits.map((h) => byId.get(h.id)).filter(Boolean);
  } else {
    ordered = [...state.prompts].sort(
      (a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt),
    );
  }

  $('results').replaceChildren(...ordered.map(renderItem));
  $('empty').hidden = ordered.length > 0;
  if (state.prompts.length) {
    $('empty-title').textContent = 'No matches';
    $('empty-body').textContent = 'Try a different word, a filename, or a tag.';
  } else {
    $('empty-title').textContent = 'No saved prompts yet';
    $('empty-body').textContent = 'Write a prompt and attach files in claude.ai, then click “Save prompt” above the message box.';
  }
}

const MAX_CHIPS = 4;

function renderItem(prompt) {
  const files = prompt.fileIds.map((id) => state.filesById.get(id)).filter(Boolean);
  const anyMissing = files.some((f) => f.missing);
  const preview = (prompt.promptText || '').replace(/\s+/g, ' ').trim();

  const deleteButton = el('button', { class: 'btn btn-icon danger', title: 'Delete', 'aria-label': 'Delete' }, icon('trash'));
  deleteButton.addEventListener('click', async () => {
    if (deleteButton.classList.contains('armed')) {
      await db.deletePrompt(prompt.id);
      await loadLibrary();
      return;
    }
    deleteButton.classList.add('armed');
    deleteButton.replaceChildren('Delete?');
    setTimeout(() => {
      deleteButton.classList.remove('armed');
      deleteButton.replaceChildren(icon('trash'));
    }, 3500);
  });

  const chips = files.slice(0, MAX_CHIPS).map((f) => el('span', {
    class: `chip${f.missing ? ' missing' : ''}`,
    title: `${f.name}\n${formatBytes(f.size)} · ${f.mode === 'copy' ? 'saved copy' : 'linked from disk'}${f.missing ? ' · not found on disk' : ''}`,
  }, el('span', { class: 'ext', textContent: extLabel(f.name) }), el('span', { class: 'chip-name', textContent: f.name })));
  if (files.length > MAX_CHIPS) {
    chips.push(el('span', { class: 'chip more', textContent: `+${files.length - MAX_CHIPS} more`, title: files.slice(MAX_CHIPS).map((f) => f.name).join('\n') }));
  }

  const meta = [];
  for (const t of prompt.tags || []) meta.push(el('span', { class: 'tag', textContent: `#${t}` }));
  meta.push(prompt.lastUsedAt ? `Used ${prompt.useCount}× · ${timeAgo(prompt.lastUsedAt)}` : `Saved ${timeAgo(prompt.createdAt)}`);

  return el('li', { class: 'card' },
    el('h2', { class: 'card-title', textContent: prompt.title || 'Untitled prompt' }),
    preview ? el('p', { class: 'card-preview', textContent: preview }) : null,
    chips.length ? el('div', { class: 'chips' }, chips) : null,
    el('div', { class: 'card-foot' },
      el('div', { class: 'card-meta' }, meta),
      el('button', {
        class: 'btn btn-icon', title: anyMissing ? 'Re-link missing files' : 'Edit', 'aria-label': 'Edit',
        onclick: () => openEditForm(prompt),
      }, icon(anyMissing ? 'link' : 'edit')),
      deleteButton,
      el('button', { class: 'btn btn-primary', textContent: 'Insert', title: 'Insert into the claude.ai message box', onclick: () => insertPrompt(prompt) })),
  );
}

// ---------------------------------------------------------------------------
// Insert

async function resolveReferenceFile(record) {
  const handle = record.handle;
  if (!handle) throw new Error(`“${record.name}” has no linked file. Use Re-link files.`);
  let permission = await handle.queryPermission({ mode: 'read' });
  if (permission !== 'granted') permission = await handle.requestPermission({ mode: 'read' });
  if (permission !== 'granted') throw new Error(`Permission to read “${record.name}” was not granted.`);
  try {
    return await handle.getFile();
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.name === 'NotReadableError') {
      await db.put('files', { ...record, missing: true });
      throw new Error(`“${record.name}” was moved or deleted. Use Re-link files.`);
    }
    throw error;
  }
}

async function insertPrompt(prompt) {
  showStatus('status', 'Inserting…');
  try {
    const tab = await activeClaudeTab();
    const records = await db.getMany('files', prompt.fileIds);
    const items = [];
    for (const record of records) {
      if (!record) continue;
      if (record.mode === 'copy') {
        items.push({ fileId: record.id, name: record.name });
      } else {
        const file = await resolveReferenceFile(record);
        if (record.missing) await db.put('files', { ...record, missing: false });
        items.push({ name: record.name, type: file.type || record.type, blob: file });
      }
    }

    const transferId = db.newId();
    await db.put('transfers', { id: transferId, promptText: prompt.promptText, items, createdAt: Date.now() });
    const result = await sendToTab(tab.id, { type: 'pc:insert', transferId });
    if (!result?.ok) throw new Error(result?.error || 'The claude.ai tab did not respond. Refresh it and try again.');

    await db.put('prompts', { ...prompt, useCount: (prompt.useCount || 0) + 1, lastUsedAt: Date.now() });
    showStatus('status', result.missing?.length ? `Inserted, but these files did not attach: ${result.missing.join(', ')}` : '', Boolean(result.missing?.length));
  } catch (error) {
    showStatus('status', error.message, true);
  }
  await loadLibrary();
}

// ---------------------------------------------------------------------------
// Save / edit form
//
// state.form = {
//   kind: 'draft' | 'edit', draftId?, promptId?,
//   entries: [{ key, name, fileId|null, record|null (new, unsaved), note }],
//   removedFileIds: [],
// }

function showView(name) {
  $('library-view').hidden = name !== 'library';
  $('form-view').hidden = name !== 'form';
}

async function openDraftForm(draftId) {
  const draft = await db.get('drafts', draftId);
  if (!draft) {
    showStatus('status', 'That save request expired. Click Save again.', true);
    return;
  }
  const records = await db.getMany('files', draft.attachments.map((a) => a.fileId).filter(Boolean));
  const byId = new Map(records.filter(Boolean).map((r) => [r.id, r]));
  const names = draft.attachments.map((a) => a.name);
  state.form = {
    kind: 'draft',
    draftId,
    entries: draft.attachments.map((a, i) => ({
      key: `d${i}`,
      draftIndex: i,
      pending: a.status === 'pending',
      name: a.name,
      fileId: a.fileId,
      stored: a.fileId ? byId.get(a.fileId) : null,
      record: null,
      note: a.note,
    })),
    removedFileIds: [],
  };
  $('form-title').textContent = 'Save prompt';
  $('f-title').value = defaultTitle(draft.promptText, names);
  $('f-tags').value = '';
  $('f-prompt').value = draft.promptText;
  showStatus('form-status', '');
  renderFormFiles();
  showView('form');
  $('f-title').select();
  // Catch files that finished while the form was opening.
  for (const entry of state.form.entries.filter((e) => e.pending)) {
    refreshDraftEntry(draftId, entry.draftIndex);
  }
}

async function openEditForm(prompt) {
  const records = await db.getMany('files', prompt.fileIds);
  state.form = {
    kind: 'edit',
    promptId: prompt.id,
    entries: records.filter(Boolean).map((r) => ({
      key: r.id, name: r.name, fileId: r.id, stored: r, record: null, note: '',
    })),
    removedFileIds: [],
  };
  $('form-title').textContent = 'Edit prompt';
  $('f-title').value = prompt.title || '';
  $('f-tags').value = (prompt.tags || []).join(', ');
  $('f-prompt').value = prompt.promptText || '';
  showStatus('form-status', '');
  renderFormFiles();
  showView('form');
}

// Called when the content script reports that one file of the open draft is ready.
async function refreshDraftEntry(draftId, index) {
  const form = state.form;
  if (form?.kind !== 'draft' || form.draftId !== draftId) return;
  const entry = form.entries.find((e) => e.draftIndex === index);
  if (!entry || !entry.pending) return;
  const draft = await db.get('drafts', draftId);
  const slot = draft?.attachments[index];
  if (!slot || slot.status === 'pending' || state.form !== form) return;
  entry.pending = false;
  entry.fileId = slot.fileId;
  entry.stored = slot.fileId ? await db.get('files', slot.fileId) : null;
  entry.note = slot.note;
  renderFormFiles();
}

function entryState(entry) {
  if (entry.pending) {
    return { text: 'Saving a copy…', pending: true };
  }
  if (entry.record) {
    return { text: `${formatBytes(entry.record.size)} · linked from disk`, warn: false };
  }
  if (entry.stored?.mode === 'copy') {
    return { text: `${formatBytes(entry.stored.size)} · saved copy`, warn: false };
  }
  if (entry.stored?.mode === 'reference') {
    return entry.stored.missing
      ? { text: 'Not found on disk. Re-link it.', warn: true }
      : { text: `${formatBytes(entry.stored.size)} · linked from disk`, warn: false };
  }
  return { text: entry.note || 'Not saved. Link it from disk.', warn: true };
}

function renderFormFiles() {
  const rows = state.form.entries.map((entry) => {
    const s = entryState(entry);
    const canRelink = !entry.pending && entry.stored?.mode !== 'copy';
    const needsLink = !entry.pending && !entry.record && !entry.stored;
    return el('li', { class: 'file', title: entry.name },
      el('span', { class: 'ext lg', textContent: extLabel(entry.name) }),
      el('div', { class: 'file-main' },
        el('div', { class: 'file-name', textContent: entry.name }),
        el('div', { class: `file-state${s.warn ? ' warn' : ''}${s.pending ? ' pending' : ''}` }, el('span', { class: 'dot' }), s.text)),
      el('div', { class: 'file-actions' },
        needsLink
          ? el('button', { class: 'btn btn-text', type: 'button', onclick: () => linkEntry(entry) }, icon('link'), 'Link')
          : canRelink
            ? el('button', { class: 'btn btn-icon', type: 'button', title: 'Re-link file', 'aria-label': 'Re-link file', onclick: () => linkEntry(entry) }, icon('link'))
            : null,
        el('button', {
          class: 'btn btn-icon danger', type: 'button', title: 'Remove from this prompt', 'aria-label': 'Remove file',
          onclick: () => removeEntry(entry),
        }, icon('x'))),
    );
  });
  $('f-files').replaceChildren(...rows);
  const n = state.form.entries.length;
  $('f-count').textContent = n ? String(n) : '';
  const pending = state.form.entries.filter((e) => e.pending).length;
  const unlinked = state.form.entries.filter((e) => !e.pending && !e.record && !e.stored).length;
  $('f-save').disabled = pending > 0;
  $('f-save').textContent = pending
    ? `Saving ${pending} file${pending > 1 ? 's' : ''}…`
    : unlinked ? `Save without ${unlinked} file${unlinked > 1 ? 's' : ''}` : 'Save';
}

async function pickFile(suggestedName) {
  const [handle] = await window.showOpenFilePicker({ multiple: false, id: 'prompt-cacher' });
  const file = await handle.getFile();
  return {
    id: db.newId(),
    name: file.name,
    size: file.size,
    type: file.type,
    mode: 'reference',
    handle,
    missing: false,
    _renamed: suggestedName && suggestedName !== file.name,
  };
}

async function linkEntry(entry) {
  try {
    const record = await pickFile(entry.name);
    if (record._renamed) showStatus('form-status', `Linked “${record.name}” in place of “${entry.name}”.`);
    delete record._renamed;
    entry.record = record;
    entry.name = record.name;
    renderFormFiles();
  } catch (error) {
    if (error?.name !== 'AbortError') showStatus('form-status', error.message, true);
  }
}

function removeEntry(entry) {
  if (entry.fileId) state.form.removedFileIds.push(entry.fileId);
  state.form.entries = state.form.entries.filter((e) => e !== entry);
  renderFormFiles();
}

async function addFileEntry() {
  try {
    const record = await pickFile();
    delete record._renamed;
    state.form.entries.push({ key: record.id, name: record.name, fileId: null, stored: null, record, note: '' });
    renderFormFiles();
  } catch (error) {
    if (error?.name !== 'AbortError') showStatus('form-status', error.message, true);
  }
}

async function saveForm() {
  const form = state.form;
  const promptText = $('f-prompt').value;
  const names = form.entries.map((e) => e.name);
  const title = $('f-title').value.trim() || defaultTitle(promptText, names);
  const tags = $('f-tags').value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);

  const newRecords = [];
  const fileIds = [];
  for (const entry of form.entries) {
    if (entry.record) {
      newRecords.push(entry.record);
      fileIds.push(entry.record.id);
      // A re-linked entry replaces its old stored record.
      if (entry.fileId) form.removedFileIds.push(entry.fileId);
    } else if (entry.stored) {
      fileIds.push(entry.stored.id);
    }
  }

  try {
    await db.putMany('files', newRecords);
    if (form.kind === 'draft') {
      await db.put('prompts', {
        id: db.newId(), title, promptText, tags, fileIds,
        createdAt: Date.now(), lastUsedAt: null, useCount: 0,
      });
      // Copies of files the user removed from the form (including ones that
      // finished after being removed) are not kept.
      const draft = await db.get('drafts', form.draftId);
      const orphans = (draft?.attachments || []).map((a) => a.fileId).filter((id) => id && !fileIds.includes(id));
      await db.delMany('files', orphans);
      await db.del('drafts', form.draftId);
    } else {
      const existing = await db.get('prompts', form.promptId);
      await db.put('prompts', { ...existing, title, promptText, tags, fileIds });
    }
    await db.delMany('files', form.removedFileIds.filter((id) => !fileIds.includes(id)));
    closeForm();
    await loadLibrary();
    showStatus('status', `Saved “${title}”.`);
  } catch (error) {
    showStatus('form-status', `Could not save: ${error.message}`, true);
  }
}

async function cancelForm() {
  if (state.form?.kind === 'draft') await db.discardDraft(state.form.draftId);
  closeForm();
}

function closeForm() {
  state.form = null;
  showView('library');
  $('search').focus();
}

// ---------------------------------------------------------------------------
// Capture (drafts arrive from the content script via chrome.storage.session)

async function handlePendingDraft(pending) {
  if (!pending) return;
  if (pending.capturing) {
    showStatus('status', 'Reading the prompt and attachments from claude.ai…');
    return;
  }
  await chrome.storage.session.remove('pendingDraft');
  if (pending.error) {
    showStatus('status', pending.error, true);
    return;
  }
  if (pending.draftId) {
    // A new Save replaces an unsaved draft that is still open.
    if (state.form?.kind === 'draft' && state.form.draftId !== pending.draftId) {
      await db.discardDraft(state.form.draftId);
    }
    showStatus('status', '');
    await openDraftForm(pending.draftId);
  }
}

async function saveFromChat() {
  try {
    const tab = await activeClaudeTab();
    showStatus('status', 'Reading the prompt and attachments from claude.ai…');
    await sendToTab(tab.id, { type: 'pc:capture' });
  } catch (error) {
    showStatus('status', error.message, true);
  }
}

// ---------------------------------------------------------------------------
// Wiring

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderResults();
});
$('search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = $('results').querySelector('.item button.primary');
  first?.click();
});
$('save-current').addEventListener('click', saveFromChat);
$('f-save').addEventListener('click', saveForm);
$('f-cancel').addEventListener('click', cancelForm);
$('f-back').addEventListener('click', cancelForm);
hydrateIcons();
$('f-add-file').addEventListener('click', addFileEntry);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'pc:draftProgress') refreshDraftEntry(message.draftId, message.index);
  return false;
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pendingDraft) handlePendingDraft(changes.pendingDraft.newValue);
});

(async () => {
  // A pending save comes first: the form should appear without waiting for the
  // library to load.
  const { pendingDraft } = await chrome.storage.session.get('pendingDraft');
  await handlePendingDraft(pendingDraft);
  await loadLibrary();
  if (!state.form) $('search').focus();
  db.sweepStale().catch(() => {});
})();
