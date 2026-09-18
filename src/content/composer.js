// Reading from and writing to the claude.ai composer. The text and file injection is
// adapted from the existing working pipeline (helpful_info/files/content-llm.js):
// setContentEditableText, assignFileToInput, attachFile.

globalThis.__pc = globalThis.__pc || {};

(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isUsable(el) {
    if (!(el instanceof HTMLElement) || el.disabled) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  __pc.findComposer = function findComposer() {
    return __pc.SELECTORS.composer
      .flatMap((sel) => [...document.querySelectorAll(sel)])
      .find(isUsable) || null;
  };

  // ---- Reading ----------------------------------------------------------------

  // One line per block. An empty paragraph (just a trailing <br>) is an empty line,
  // so text inserted by insertPromptText reads back unchanged.
  __pc.readPromptText = function readPromptText() {
    const composer = __pc.findComposer();
    if (!composer) return '';
    const blocks = [...composer.children];
    if (!blocks.length) return composer.innerText.trim();
    return blocks
      .map((block) => (block.tagName === 'P' ? block.textContent : block.innerText.replace(/\n$/, '')))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
  };

  // ---- Writing text -----------------------------------------------------------

  function escapeHtml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function plainTextToEditableHtml(value) {
    return value.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  }

  function createTextDataTransfer(value) {
    try {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', value);
      transfer.setData('text/html', plainTextToEditableHtml(value));
      return transfer;
    } catch {
      return null;
    }
  }

  function dispatchTextInputEvents(element, value, inputType = 'insertText') {
    const dataTransfer = inputType === 'insertFromPaste' ? createTextDataTransfer(value) : null;
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: value, dataTransfer }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: value, dataTransfer }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
  }

  function dispatchPasteEvent(element, value) {
    const clipboardData = createTextDataTransfer(value);
    if (!clipboardData) return false;
    try {
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      return true;
    } catch {
      return false;
    }
  }

  function containsProbe(element, value) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    const probe = normalized.slice(0, Math.min(160, Math.max(40, Math.floor(normalized.length * 0.15))));
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    return Boolean(text && probe && text.includes(probe));
  }

  function clearEditable(element) {
    element.focus({ preventScroll: true });
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('delete', false);
      return;
    } catch {
      // Fall through to direct DOM clearing.
    }
    element.textContent = '';
  }

  async function insertInChunks(element, value) {
    const chunkSize = 4000;
    clearEditable(element);
    for (let index = 0; index < value.length; index += chunkSize) {
      const chunk = value.slice(index, index + chunkSize);
      element.focus({ preventScroll: true });
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, chunk);
      } catch {
        inserted = false;
      }
      if (!inserted) return false;
      dispatchTextInputEvents(element, chunk, 'insertText');
      if (index > 0 && index % (chunkSize * 3) === 0) await sleep(25);
    }
    return containsProbe(element, value);
  }

  // Replaces the composer text with `value`.
  __pc.insertPromptText = async function insertPromptText(value) {
    const element = __pc.findComposer();
    if (!element) throw new Error('Could not find the claude.ai message box. Open a chat and try again.');
    element.focus({ preventScroll: true });
    if (!value) return;

    let inserted = false;
    clearEditable(element);
    if (value.length <= 12_000 && dispatchPasteEvent(element, value)) {
      await sleep(50);
      inserted = true;
    }
    if (!inserted || !containsProbe(element, value)) inserted = await insertInChunks(element, value);
    if (!inserted || !containsProbe(element, value)) {
      element.innerHTML = plainTextToEditableHtml(value);
      inserted = true;
    }
    dispatchTextInputEvents(element, value, 'insertFromPaste');
  };

  // ---- Writing files ----------------------------------------------------------

  function assignFilesToInput(input, files) {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function findFileInput() {
    let input = __pc.queryFirst('fileInput');
    if (input) return input;
    for (const button of __pc.queryAll('attachButton').filter(isUsable)) {
      button.click();
      await sleep(500);
      input = __pc.queryFirst('fileInput');
      if (input) {
        // Close whatever menu the click opened.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return input;
      }
    }
    throw new Error('Could not find the claude.ai file upload. Open a chat and try again.');
  }

  // Attaches files and waits for their chips to appear. Returns names that never showed up.
  __pc.attachFiles = async function attachFiles(files, timeoutMs = 20_000) {
    if (!files.length) return [];
    const input = await findFileInput();
    const before = __pc.readAttachments().length;
    assignFilesToInput(input, files);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (__pc.readAttachments().length >= before + files.length) return [];
      await sleep(250);
    }
    const present = new Set(__pc.readAttachments().map((a) => a.name));
    return files.map((f) => f.name).filter((name) => !present.has(name));
  };
})();
