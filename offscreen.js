let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'sw-keepalive' });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'pong') {
      console.log('[Offscreen] Pong received — SW alive at', msg.ts);
    }
  });

  port.onDisconnect.addListener(() => {
    console.warn('[Offscreen] Port lost — reconnecting...');
    port = null;
    setTimeout(connect, 100);
  });

  // Ping SW every 20s to keep the port warm
  setInterval(() => {
    try {
      port?.postMessage({ type: 'ping', ts: Date.now() });
    } catch {
      // Port already dead — onDisconnect will handle reconnect
    }
  }, 20_000);
}

connect();