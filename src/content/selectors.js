// ALL claude.ai DOM knowledge lives here. claude.ai changes its markup often; when
// something breaks, this is the file to fix. Each entry is a list tried in order.
// Last verified against claude.ai on 2026-09-18.

globalThis.__pc = globalThis.__pc || {};

__pc.SELECTORS = {
  // The tiptap/ProseMirror composer.
  composer: [
    'div[data-testid="chat-input"][contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]',
  ],

  // Hidden input the composer's attach button uses.
  fileInput: [
    'input#chat-input-file-upload-onpage[type="file"]',
    'input[data-testid="file-upload"][type="file"]',
    'input[type="file"]',
  ],

  // Buttons that create the file input if it is not in the DOM yet.
  attachButton: [
    '[data-testid="composer-attach-files-button"]',
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Add file" i]',
  ],

  // One per attachment chip, aria-label "Remove <filename>". The most reliable source
  // of attachment filenames: it covers PDFs, images and client-side text files alike.
  attachmentRemoveButton: ['button[aria-label^="Remove "]'],
  attachmentRemovePrefix: 'Remove ',

  // Attachment chip container (used to find the thumbnail for a given remove button).
  attachmentChip: ['[data-testid="file-thumbnail"]'],

  // Server-side thumbnail of an uploaded file: /api/{org}/files/{id}/thumbnail.
  // Swapping "/thumbnail" for "/document_pdf" returns the original PDF bytes.
  uploadedThumbnail: ['img[src*="/files/"][src*="/thumbnail"]'],
};

__pc.queryFirst = function queryFirst(key, root = document) {
  for (const selector of __pc.SELECTORS[key]) {
    const el = root.querySelector(selector);
    if (el) return el;
  }
  return null;
};

__pc.queryAll = function queryAll(key, root = document) {
  for (const selector of __pc.SELECTORS[key]) {
    const els = root.querySelectorAll(selector);
    if (els.length) return [...els];
  }
  return [];
};
