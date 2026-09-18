// Service worker: opens the side panel, hands out the bridge token, and tells the side
// panel when a Save draft is ready. No file bytes ever pass through here.

const CLAUDE_URL = /^https:\/\/claude\.ai\//;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function ensureBridgeToken() {
  const { bridgeToken } = await chrome.storage.session.get('bridgeToken');
  if (bridgeToken) return bridgeToken;
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ bridgeToken: token });
  return token;
}

chrome.runtime.onStartup.addListener(ensureBridgeToken);
chrome.runtime.onInstalled.addListener(ensureBridgeToken);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromClaudeTab = sender.tab && CLAUDE_URL.test(sender.url || '');

  switch (message?.type) {
    case 'pc:getBridgeToken':
      // Only our own content script on claude.ai gets the token.
      if (!fromClaudeTab || sender.id !== chrome.runtime.id) return false;
      ensureBridgeToken().then((token) => sendResponse({ token }));
      return true;

    case 'pc:openSidePanel':
      // Called synchronously from the Save button click so the user gesture still counts.
      if (!sender.tab) return false;
      const requestedAt = Date.now();
      chrome.sidePanel
        .open({ tabId: sender.tab.id })
        .then(async () => {
          // Don't clobber a draft that finished while the panel was opening.
          const { pendingDraft } = await chrome.storage.session.get('pendingDraft');
          if (pendingDraft && pendingDraft.at >= requestedAt) return;
          await chrome.storage.session.set({
            pendingDraft: { capturing: true, tabId: sender.tab.id, at: requestedAt },
          });
        })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;

    case 'pc:draftReady':
      if (!fromClaudeTab) return false;
      chrome.storage.session
        .set({ pendingDraft: { draftId: message.draftId, tabId: sender.tab.id, at: Date.now() } })
        .then(() => sendResponse({ ok: true }));
      return true;

    case 'pc:draftFailed':
      if (!fromClaudeTab) return false;
      chrome.storage.session
        .set({ pendingDraft: { error: message.error, tabId: sender.tab.id, at: Date.now() } })
        .then(() => sendResponse({ ok: true }));
      return true;

    default:
      return false;
  }
});
