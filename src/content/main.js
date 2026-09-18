// Content-script entry point on claude.ai: the injected "Save" button, and the message
// handlers the side panel uses (capture, insert).

globalThis.__pc = globalThis.__pc || {};

(() => {
  if (__pc.started) return;
  __pc.started = true;

  const extensionAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  // ---- Toast ------------------------------------------------------------------

  let toastTimer = null;
  function toast(text, isError = false) {
    let el = document.getElementById('pc-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pc-toast';
      el.style.cssText =
        'position:fixed;z-index:2147483647;bottom:24px;left:50%;transform:translateX(-50%);' +
        'max-width:min(480px,90vw);padding:10px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.2);color:#fff;';
      document.documentElement.appendChild(el);
    }
    el.style.background = isError ? '#7f1d1d' : '#1f2022';
    el.style.border = `1px solid ${isError ? '#b91c1c' : '#46484d'}`;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
  }

  function staleExtension() {
    toast('Prompt Cacher was reloaded. Refresh this tab to use it again.', true);
  }

  // ---- Capture (Save) ---------------------------------------------------------

  let capturing = false;
  async function captureDraft() {
    if (capturing) return;
    capturing = true;
    try {
      const promptText = __pc.readPromptText();
      const chips = __pc.readAttachments();
      if (!promptText && !chips.length) throw new Error('The message box is empty. Type a prompt or attach files first.');

      // Open the form straight away with the text and filenames...
      const { draftId } = await __pc.bridgeCall('createDraft', { promptText, names: chips.map((c) => c.name) });
      await chrome.runtime.sendMessage({ type: 'pc:draftReady', draftId });

      // ...then fill in each file as its copy finishes.
      await __pc.captureAttachments(chips, async (index, result) => {
        try {
          await __pc.bridgeCall('fillDraftFile', { draftId, index, ...result });
        } catch (error) {
          // Usually a storage error (disk full). Mark the file failed so the form
          // doesn't wait on it forever.
          await __pc.bridgeCall('fillDraftFile', {
            draftId, index, name: result.name, blob: null,
            note: `Could not store the copy (${error.message}). Link it from disk.`,
          }).catch(() => {});
        }
        chrome.runtime.sendMessage({ type: 'pc:draftProgress', draftId, index }).catch(() => {});
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (extensionAlive()) chrome.runtime.sendMessage({ type: 'pc:draftFailed', error: message }).catch(() => {});
      toast(`Prompt Cacher: ${message}`, true);
    } finally {
      capturing = false;
    }
  }

  // ---- Insert -----------------------------------------------------------------

  async function insertTransfer(transferId) {
    const { promptText, items } = await __pc.bridgeCall('takeTransfer', { transferId });
    const files = items.map((i) => new File([i.blob], i.name, { type: i.type || i.blob.type }));
    // Files first: typing does not disturb attachments, but some composer
    // re-renders on attach can drop freshly inserted text.
    const missing = await __pc.attachFiles(files);
    await __pc.insertPromptText(promptText || '');
    return { missing };
  }

  // ---- Save button ------------------------------------------------------------

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'pc-save-button';
  button.textContent = 'Save prompt';
  button.title = 'Save this prompt and its attachments to Prompt Cacher';
  button.style.cssText =
    'position:fixed;z-index:2147483646;display:none;height:28px;padding:0 12px;border-radius:7px;' +
    'border:1px solid #46484d;background:#1f2022;color:#a8bee6;' +
    'font:600 12.5px/26px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.25);transition:background-color .12s,border-color .12s;';
  button.addEventListener('mouseenter', () => { button.style.background = '#2e3033'; button.style.borderColor = '#5a7cb8'; });
  button.addEventListener('mouseleave', () => { button.style.background = '#1f2022'; button.style.borderColor = '#46484d'; });
  button.addEventListener('click', () => {
    if (!extensionAlive()) return staleExtension();
    // Must be sent before any await so Chrome still treats it as a user gesture.
    chrome.runtime.sendMessage({ type: 'pc:openSidePanel' }).catch(() => {});
    toast('Saving prompt…');
    captureDraft();
  });
  document.documentElement.appendChild(button);

  function positionButton() {
    if (!extensionAlive()) {
      button.style.display = 'none';
      return;
    }
    const composer = __pc.findComposer();
    const rect = composer?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      button.style.display = 'none';
      return;
    }
    // Sit just above the composer's top-right corner.
    const box = composer.closest('fieldset') || composer.parentElement?.parentElement || composer;
    const boxRect = box.getBoundingClientRect();
    button.style.display = 'block';
    button.style.top = `${Math.max(4, boxRect.top - 34)}px`;
    button.style.left = `${Math.max(4, boxRect.right - button.offsetWidth)}px`;
  }
  setInterval(positionButton, 750);
  window.addEventListener('resize', positionButton);

  // Load the storage iframe now so the first Save doesn't wait for it. This reads
  // nothing from the page; files are only read when Save is clicked.
  setTimeout(() => {
    if (extensionAlive()) __pc.bridgeCall('ping').catch(() => {});
  }, 1000);

  // ---- Messages from the side panel -------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'pc:ping':
        sendResponse({ ok: true, attachments: __pc.readAttachments().map((a) => a.name) });
        return false;
      case 'pc:capture':
        captureDraft().then(() => sendResponse({ ok: true }));
        return true;
      case 'pc:insert':
        insertTransfer(message.transferId)
          .then((result) => {
            toast(result.missing.length ? `Some files did not attach: ${result.missing.join(', ')}` : 'Prompt inserted.', Boolean(result.missing.length));
            sendResponse({ ok: true, ...result });
          })
          .catch((error) => {
            toast(`Prompt Cacher: ${error.message}`, true);
            sendResponse({ ok: false, error: String(error?.message || error) });
          });
        return true;
      default:
        return false;
    }
  });
})();
