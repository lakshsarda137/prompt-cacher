// IndexedDB wrapper. Lives in the extension origin: used by the side panel and
// by the bridge iframe, never by content scripts (they would get claude.ai's IDB).
//
// Stores:
//   prompts   { id, title, promptText, tags[], createdAt, lastUsedAt, useCount, fileIds[] }
//   files     { id, name, size, type, mode: "reference"|"copy", handle?, blob?, missing? }
//   drafts    { id, tabId, promptText, attachments: [{ name, fileId|null, note }], createdAt }
//   transfers { id, items: [{ fileId } | { name, type, blob }], createdAt }  (short-lived, for Insert)

const DB_NAME = 'prompt-cacher';
const DB_VERSION = 1;
const STORES = ['prompts', 'files', 'drafts', 'transfers'];

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(storeNames, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
  const stores = Object.fromEntries(
    [storeNames].flat().map((n) => [n, tx.objectStore(n)]),
  );
  const result = await fn(stores);
  await done;
  return result;
}

export const get = (store, id) => run(store, 'readonly', (s) => promisify(s[store].get(id)));
export const getAll = (store) => run(store, 'readonly', (s) => promisify(s[store].getAll()));
export const put = (store, value) => run(store, 'readwrite', (s) => promisify(s[store].put(value)));
export const del = (store, id) => run(store, 'readwrite', (s) => promisify(s[store].delete(id)));

export function getMany(store, ids) {
  return run(store, 'readonly', (s) => Promise.all(ids.map((id) => promisify(s[store].get(id)))));
}

export function putMany(store, values) {
  return run(store, 'readwrite', (s) => Promise.all(values.map((v) => promisify(s[store].put(v)))));
}

export function delMany(store, ids) {
  return run(store, 'readwrite', (s) => Promise.all(ids.map((id) => promisify(s[store].delete(id)))));
}

export const newId = () => crypto.randomUUID();

// Drops transfers and drafts left behind by interrupted flows.
export async function sweepStale(maxAgeMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const transfers = await getAll('transfers');
  await delMany('transfers', transfers.filter((t) => t.createdAt < cutoff).map((t) => t.id));
  const drafts = await getAll('drafts');
  for (const d of drafts.filter((x) => x.createdAt < cutoff)) await discardDraft(d.id);
}

export async function discardDraft(draftId) {
  const draft = await get('drafts', draftId);
  if (!draft) return;
  await delMany('files', draft.attachments.map((a) => a.fileId).filter(Boolean));
  await del('drafts', draftId);
}

export async function deletePrompt(promptId) {
  const prompt = await get('prompts', promptId);
  if (!prompt) return;
  await delMany('files', prompt.fileIds);
  await del('prompts', promptId);
}
