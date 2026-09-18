// Content-script side of the Blob bridge: a hidden iframe on an extension page, talked
// to over a private MessageChannel. See src/bridge/bridge.js for the other end.

globalThis.__pc = globalThis.__pc || {};

(() => {
  let portPromise = null;
  let nextId = 1;
  const pending = new Map();

  function connect() {
    return new Promise(async (resolve, reject) => {
      let token;
      try {
        ({ token } = await chrome.runtime.sendMessage({ type: 'pc:getBridgeToken' }));
      } catch {
        token = null;
      }
      if (!token) return reject(new Error('Prompt Cacher could not reach the extension. Refresh this tab.'));

      const bridgeUrl = chrome.runtime.getURL('src/bridge/bridge.html');
      const iframe = document.createElement('iframe');
      iframe.src = bridgeUrl;
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';

      const timer = setTimeout(() => {
        reject(new Error('Prompt Cacher bridge did not load (blocked by page CSP?).'));
      }, 8000);

      iframe.addEventListener('load', () => {
        const channel = new MessageChannel();
        const port = channel.port1;
        port.onmessage = (event) => {
          const msg = event.data;
          if (msg?.type === 'pc-ready') {
            clearTimeout(timer);
            resolve(port);
            return;
          }
          const entry = pending.get(msg?.id);
          if (!entry) return;
          pending.delete(msg.id);
          msg.ok ? entry.resolve(msg.result) : entry.reject(new Error(msg.error));
        };
        iframe.contentWindow.postMessage(
          { type: 'pc-init', token },
          new URL(bridgeUrl).origin,
          [channel.port2],
        );
      });

      (document.body || document.documentElement).appendChild(iframe);
    });
  }

  __pc.bridgeCall = async function bridgeCall(op, args) {
    if (!portPromise) {
      portPromise = connect().catch((error) => {
        portPromise = null;
        throw error;
      });
    }
    const port = await portPromise;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ id, op, args });
    });
  };
})();
