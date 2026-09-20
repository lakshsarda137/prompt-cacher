// Reads the attachments currently in the composer and downloads a byte-identical copy
// of each one. Only ever called from an explicit Save click. Verified 2026-09-18.
//
// Primary source: claude.ai's own composer draft, which it persists in IndexedDB
//   db "keyval-store", store "keyval", key "store:chat-draft:<id>"
//   (<id> = "chorus-unified-composer" on /new, the conversation uuid in a chat)
//   value.state.files[]       uploaded files (pdf, pptx, docx, images…):
//                             { file_name, path, derivedOrgUuid, derivedConversationUuid }
//                             original bytes: GET /api/organizations/{org}/conversations/{conv}
//                                             /wiggle/download-file?path=<path>
//   value.state.attachments[] text files read in the browser, never uploaded:
//                             { file_name, file_type, extracted_content }
// Fallback for PDFs: chip thumbnail /api/{org}/files/{id}/thumbnail -> /document_pdf.

globalThis.__pc = globalThis.__pc || {};

(() => {
  const S = __pc.SELECTORS;
  const DRAFT_DB = 'keyval-store';
  const DRAFT_STORE = 'keyval';
  const DRAFT_PREFIX = 'store:chat-draft:';
  const NEW_CHAT_DRAFT = 'chorus-unified-composer';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- Chips (DOM) ------------------------------------------------------------

  function findThumbnailFor(removeButton, name) {
    let node = removeButton.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (__pc.queryAll('attachmentRemoveButton', node).length > 1) break;
      const img = __pc.queryFirst('uploadedThumbnail', node);
      if (img) return img;
    }
    return __pc.queryAll('uploadedThumbnail').find((img) => img.alt === name) || null;
  }

  // -> [{ name, thumbnailPdfUrl|null }]
  __pc.readAttachments = function readAttachments() {
    return __pc.queryAll('attachmentRemoveButton').map((button) => {
      const label = button.getAttribute('aria-label') || '';
      const name = label.slice(S.attachmentRemovePrefix.length).trim() || 'attachment';
      const img = findThumbnailFor(button, name);
      let thumbnailPdfUrl = null;
      if (img) {
        const path = new URL(img.src, location.origin).pathname;
        if (path.endsWith('/thumbnail')) thumbnailPdfUrl = path.replace(/\/thumbnail$/, '/document_pdf');
      }
      return { name, thumbnailPdfUrl };
    });
  };

  // ---- claude.ai draft store (IndexedDB, same origin as this content script) ----

  function openDraftDb() {
    return new Promise((resolve) => {
      let created = false;
      const req = indexedDB.open(DRAFT_DB);
      // Never create claude.ai's database if it does not exist.
      req.onupgradeneeded = () => {
        created = true;
        req.transaction.abort();
      };
      req.onsuccess = () => resolve(created ? null : req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  async function readDrafts() {
    const db = await openDraftDb();
    if (!db) return [];
    try {
      if (!db.objectStoreNames.contains(DRAFT_STORE)) return [];
      const store = db.transaction(DRAFT_STORE, 'readonly').objectStore(DRAFT_STORE);
      const range = IDBKeyRange.bound(DRAFT_PREFIX, `${DRAFT_PREFIX}\uffff`);
      const [keys, values] = await Promise.all([
        new Promise((res) => { const q = store.getAllKeys(range); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }),
        new Promise((res) => { const q = store.getAll(range); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }),
      ]);
      return keys.map((key, i) => {
        let value = values[i];
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch { value = null; }
        }
        const state = value?.state || {};
        return {
          id: String(key).slice(DRAFT_PREFIX.length),
          files: Array.isArray(state.files) ? state.files : [],
          attachments: Array.isArray(state.attachments) ? state.attachments : [],
        };
      });
    } finally {
      db.close();
    }
  }

  function currentDraftId() {
    const match = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return match ? match[1] : NEW_CHAT_DRAFT;
  }

  // The draft for this page, or else whichever draft best matches the chips.
  function pickDraft(drafts, names) {
    const preferred = currentDraftId();
    const score = (d) => {
      const pool = [...d.files.map((f) => f.file_name), ...d.attachments.map((a) => a.file_name)];
      return names.filter((n) => pool.includes(n)).length;
    };
    let best = null;
    let bestScore = 0;
    for (const draft of drafts) {
      const s = score(draft) + (draft.id === preferred ? 0.5 : 0);
      if (s > bestScore) { best = draft; bestScore = s; }
    }
    return bestScore >= 1 ? best : null;
  }

  // ---- Downloading ------------------------------------------------------------

  async function fetchBlob(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('empty response');
    return blob;
  }

  function mimeFor(name, fallback = '') {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const types = {
      pdf: 'application/pdf',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    };
    return types[ext] || fallback || 'application/octet-stream';
  }
  __pc.mimeFor = mimeFor;

  async function captureOne(name, draftEntry, thumbnailPdfUrl) {
    const errors = [];
    if (draftEntry?.kind === 'file') {
      const f = draftEntry.entry;
      if (f.path && f.derivedOrgUuid && f.derivedConversationUuid) {
        const url = `/api/organizations/${f.derivedOrgUuid}/conversations/${f.derivedConversationUuid}` +
          `/wiggle/download-file?path=${encodeURIComponent(f.path)}`;
        try {
          const blob = await fetchBlob(url);
          return { name, type: mimeFor(name, blob.type), blob: new Blob([blob], { type: mimeFor(name, blob.type) }), note: '' };
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
    if (draftEntry?.kind === 'text') {
      const a = draftEntry.entry;
      const type = a.file_type || mimeFor(name, 'text/plain');
      return { name, type, blob: new Blob([a.extracted_content ?? ''], { type }), note: '' };
    }
    if (thumbnailPdfUrl && /\.pdf$/i.test(name)) {
      try {
        const blob = await fetchBlob(thumbnailPdfUrl);
        return { name, type: 'application/pdf', blob: new Blob([blob], { type: 'application/pdf' }), note: '' };
      } catch (error) {
        errors.push(error.message);
      }
    }
    const why = errors.length
      ? `download failed (${errors[0]})`
      : 'claude.ai did not finish uploading it in time';
    return { name, type: '', blob: null, note: `Could not copy: ${why}. Link it from disk.` };
  }

  // chips: from readAttachments(). Calls onResult(index, { name, type, blob|null, note })
  // as soon as each file is ready, so small files don't wait for big ones.
  //
  // An attachment card shows up as soon as the file is picked, but claude.ai only
  // writes the draft record once its upload finishes. A large image or slide deck can
  // take a while, so each file is waited for separately, up to WAIT_MS, and downloaded
  // the moment its record appears.
  const WAIT_MS = 90_000;
  const POLL_MS = 300;

  __pc.captureAttachments = async function captureAttachments(chips, onResult) {
    if (!chips.length) return;
    const names = chips.map((c) => c.name);
    const waiting = new Set(chips.map((_, i) => i));
    const downloads = [];

    const start = (index, entry) => {
      waiting.delete(index);
      const { name, thumbnailPdfUrl } = chips[index];
      downloads.push(captureOne(name, entry, thumbnailPdfUrl).then((result) => onResult(index, result)));
    };

    // Several attachments can share a name, so the nth card with a given name takes
    // the nth draft entry with that name. Counted over all cards, not just the ones
    // still waiting, so a card that already matched keeps its entry.
    const rank = chips.map((chip, i) => chips.slice(0, i).filter((c) => c.name === chip.name).length);

    const deadline = Date.now() + WAIT_MS;
    while (waiting.size && Date.now() < deadline) {
      const draft = pickDraft(await readDrafts(), names);
      if (draft) {
        for (const index of [...waiting].sort((a, b) => a - b)) {
          const name = chips[index].name;
          const matches = [
            ...draft.files.filter((f) => f.file_name === name).map((entry) => ({ kind: 'file', entry })),
            ...draft.attachments.filter((a) => a.file_name === name).map((entry) => ({ kind: 'text', entry })),
          ];
          if (matches[rank[index]]) start(index, matches[rank[index]]);
        }
      }
      if (waiting.size) await sleep(POLL_MS);
    }

    // Never showed up: claude.ai may still be uploading, or the file is not one it
    // keeps. captureOne falls back to the PDF thumbnail route where it can.
    for (const index of [...waiting]) start(index, null);

    await Promise.all(downloads);
  };
})();
