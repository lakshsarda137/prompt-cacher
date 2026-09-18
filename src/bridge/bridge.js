// Runs inside a hidden iframe (extension origin) that the claude.ai content script
// injects. It is the only way for the content script to move Blobs in and out of the
// extension's IndexedDB without base64 or chrome.runtime messaging.
//
// Handshake: the content script posts { type: 'pc-init', token } and transfers a
// MessagePort. The token comes from the background worker and lives in
// chrome.storage.session, which claude.ai page scripts cannot read, so the page itself
// cannot talk to this bridge even though it can see the iframe.

import { put, get, del, newId, openDb } from '../db/db.js';

const CLAUDE_ORIGIN = 'https://claude.ai';

const ops = {
  ping() {
    return 'pong';
  },

  // Step 1 of a Save: record the prompt and filenames right away so the side panel
  // can show the form before any file has finished downloading.
  async createDraft({ promptText, names }) {
    const draft = {
      id: newId(),
      promptText,
      attachments: names.map((name) => ({ name, status: 'pending', fileId: null, note: '' })),
      createdAt: Date.now(),
    };
    await put('drafts', draft);
    return { draftId: draft.id };
  },

  // Step 2, once per file as its copy finishes: store the bytes and mark it done.
  // File record and draft update happen in one transaction so parallel calls can't
  // overwrite each other.
  async fillDraftFile({ draftId, index, name, type, blob, note }) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'files'], 'readwrite');
      const drafts = tx.objectStore('drafts');
      const req = drafts.get(draftId);
      req.onsuccess = () => {
        const draft = req.result;
        // The user cancelled the save while this file was downloading.
        if (!draft || !draft.attachments[index]) return;
        const slot = draft.attachments[index];
        if (blob) {
          const id = newId();
          tx.objectStore('files').put({ id, name, size: blob.size, type: blob.type || type || '', mode: 'copy', blob });
          Object.assign(slot, { status: 'done', fileId: id, note: '' });
        } else {
          Object.assign(slot, { status: 'failed', fileId: null, note: note || '' });
        }
        drafts.put(draft);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  },

  // Returns [{ name, type, blob }] and deletes the transfer record.
  async takeTransfer({ transferId }) {
    const transfer = await get('transfers', transferId);
    if (!transfer) throw new Error('Insert request expired. Try again.');
    await del('transfers', transferId);
    const items = [];
    for (const item of transfer.items) {
      if (item.blob) {
        items.push({ name: item.name, type: item.type, blob: item.blob });
        continue;
      }
      const file = await get('files', item.fileId);
      if (!file?.blob) throw new Error(`Saved copy of a file is missing (${item.name || item.fileId}).`);
      items.push({ name: file.name, type: file.type, blob: file.blob });
    }
    return { promptText: transfer.promptText, items };
  },
};

function serve(port) {
  port.onmessage = async (event) => {
    const { id, op, args } = event.data || {};
    try {
      if (!ops[op]) throw new Error(`Unknown bridge op: ${op}`);
      port.postMessage({ id, ok: true, result: await ops[op](args || {}) });
    } catch (error) {
      port.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
  };
}

window.addEventListener('message', async (event) => {
  if (event.origin !== CLAUDE_ORIGIN) return;
  if (event.data?.type !== 'pc-init' || !event.ports?.[0]) return;
  const { bridgeToken } = await chrome.storage.session.get('bridgeToken');
  if (!bridgeToken || event.data.token !== bridgeToken) return;
  const port = event.ports[0];
  serve(port);
  port.postMessage({ type: 'pc-ready' });
});
