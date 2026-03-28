import { WebSocketServer } from 'ws';
import { WindowsNotificationListener, DEFAULT_LOG_NAME } from './windowsNotificationListener.js';

const PORT = Number(process.env.AIS_WS_PORT || 8080);
const SAMPLE_INTERVAL_MS = Number(process.env.AIS_SAMPLE_INTERVAL_MS || 0);
const WINDOWS_LISTENER_ENABLED =
  process.argv.includes('--windows') || process.env.AIS_WINDOWS_LISTENER === '1';
const WINDOWS_LOG_NAME = process.env.AIS_WINDOWS_LOG_NAME || DEFAULT_LOG_NAME;
const WINDOWS_POLL_MS = Number(process.env.AIS_WINDOWS_POLL_MS || 3000);

const wss = new WebSocketServer({ port: PORT });
let windowsListener = null;

console.log(`[AIS Bridge] WebSocket server listening on ws://localhost:${PORT}`);

wss.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(
      `[AIS Bridge] Port ${PORT} is already in use. Set AIS_WS_PORT to a free port and retry.`
    );
    process.exit(1);
  }
  console.error('[AIS Bridge] WebSocket server error:', error);
  process.exit(1);
});

function makeSampleNotification() {
  return {
    type: 'INCOMING_NOTIFICATION',
    notification: {
      id: `sample-${Date.now()}`,
      title: 'Sample external notification',
      body: 'This came from the local AIS bridge server.',
      source: 'MockBridge',
      priority: 'MEDIUM',
      createdAt: Date.now(),
    },
  };
}

function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(serialized);
    }
  }
}

function broadcastIncomingNotification(notification) {
  broadcast({
    type: 'INCOMING_NOTIFICATION',
    notification,
  });
}

wss.on('connection', (socket) => {
  console.log('[AIS Bridge] Extension connected');

  socket.send(
    JSON.stringify({
      type: 'PING',
      ts: Date.now(),
    })
  );

  socket.on('message', (raw) => {
    const text = raw.toString();
    try {
      const payload = JSON.parse(text);
      if (payload.type === 'STATE_CHANGE') {
        const s = payload.state ?? {};
        console.log(
          `[AIS Bridge] State=${s.state} domain=${s.currentDomain ?? 'n/a'} density=${s.interactionDensity ?? 0}`
        );
      } else if (payload.type === 'NOTIFICATION_DECISION') {
        console.log(
          `[AIS Bridge] Decision action=${payload?.decision?.action ?? 'n/a'} priority=${payload?.decision?.priority ?? 'n/a'}`
        );
      } else {
        console.log('[AIS Bridge] Message:', payload.type ?? 'UNKNOWN');
      }
    } catch {
      console.log('[AIS Bridge] Raw message:', text);
    }
  });

  socket.on('close', () => {
    console.log('[AIS Bridge] Extension disconnected');
  });
});

if (SAMPLE_INTERVAL_MS > 0) {
  setInterval(() => {
    broadcast(makeSampleNotification());
  }, SAMPLE_INTERVAL_MS);
  console.log(
    `[AIS Bridge] Sample INCOMING_NOTIFICATION enabled every ${SAMPLE_INTERVAL_MS}ms`
  );
}

async function setupWindowsListener() {
  if (!WINDOWS_LISTENER_ENABLED) return;

  windowsListener = new WindowsNotificationListener({
    logName: WINDOWS_LOG_NAME,
    pollIntervalMs: WINDOWS_POLL_MS,
    onNotification: (notification) => {
      console.log(
        `[AIS Bridge] Windows notification: source=${notification.source} id=${notification.id}`
      );
      broadcastIncomingNotification(notification);
    },
    onError: (error) => {
      console.warn('[AIS Bridge] Windows listener error:', error.message || error);
    },
  });

  try {
    await windowsListener.start();
    console.log(
      `[AIS Bridge] Windows listener enabled on ${WINDOWS_LOG_NAME} (poll ${WINDOWS_POLL_MS}ms)`
    );
  } catch (error) {
    console.warn('[AIS Bridge] Failed to start Windows listener:', error.message || error);
  }
}

setupWindowsListener();

process.on('SIGINT', () => {
  windowsListener?.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  windowsListener?.stop();
  process.exit(0);
});
