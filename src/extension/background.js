import { ActivityTracker } from './core/activityTracker.js';
import { FeatureExtractor } from './core/featureExtractor.js';
import { ContextEngine } from './core/contextEngine.js';
import { DecisionEngine } from './core/decisionEngine.js';
import { NotificationManager } from './services/notificationManager.js';
import { StorageLayer } from './services/storageLayer.js';
import { WebSocketBridge } from './integrations/websocketBridge.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/extension/offscreen/offscreen.html';

const extractor = new FeatureExtractor();
const context = new ContextEngine();
const decisions = new DecisionEngine();
const notificationManager = new NotificationManager();
const storage = new StorageLayer();

let tracker = null;
let wsBridge = null;
let latestVector = null;
let pipelineChain = Promise.resolve();

let latestContextState = {
  state: 'transitioning',
  previousState: null,
  changed: false,
  stateAgeMs: 0,
  focusScore: 0,
  domainCategory: 'unknown',
  currentDomain: null,
  interactionDensity: 0,
  interactionToDwellRatio: 0,
  playlistActive: false,
  modifiers: [],
  evaluatedAt: Date.now(),
};

async function safeSendMessage(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    const text = String(error?.message ?? error ?? '');
    if (!text.includes('Receiving end does not exist')) {
      console.warn('[SW] sendMessage failed', error);
    }
  }
}

async function safeSendToActiveTabs(message) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true });
  } catch (error) {
    console.warn('[SW] tabs.query failed', error);
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab?.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (error) {
        const text = String(error?.message ?? error ?? '');
        if (
          !text.includes('Receiving end does not exist') &&
          !text.includes('Could not establish connection')
        ) {
          console.warn('[SW] tabs.sendMessage failed', error);
        }
      }
    })
  );
}

function schedulePipeline(task) {
  pipelineChain = pipelineChain
    .then(() => task())
    .catch((error) => {
      console.error('[Pipeline] task failed', error);
    });

  return pipelineChain;
}

function shouldFlushQueueOnState(state, previousState) {
  if (state === 'distracted' || state === 'transitioning') return true;
  if (previousState === 'idle' && state !== 'idle') return true;
  return false;
}

function buildFlushExplanation(items, metadata) {
  const count = items.length;
  if (count === 0) return '';

  const domain = metadata?.focusDomain ? ` on ${metadata.focusDomain}` : '';
  const fromState = metadata?.fromState ?? 'focus';
  return `These ${count} notifications were delayed because you were in ${fromState}${domain}.`;
}

async function flushQueuedNotifications(metadata = {}) {
  const items = decisions.flushQueue();
  if (items.length === 0) return;

  const explanation = buildFlushExplanation(items, metadata);
  const digestMetadata = {
    ...metadata,
    explanation,
    flushedAt: Date.now(),
  };

  await notificationManager.flushDigest(items, digestMetadata);

  await safeSendMessage({
    source: 'decisionEngine',
    type: 'DIGEST',
    items,
    metadata: digestMetadata,
  });
}

function buildWsStatePayload(contextState, vector, trigger) {
  return {
    type: 'STATE_CHANGE',
    state: {
      ...contextState,
      trigger,
    },
    vector: {
      currentDomain: vector?.currentDomain ?? null,
      domainCategory: vector?.currentDomainCategory ?? 'unknown',
      tabSwitchRate1m: vector?.tabSwitchRate1m ?? 0,
      tabSwitchRate5m: vector?.tabSwitchRate5m ?? 0,
      timeOnCurrentDomainMs: vector?.timeOnCurrentDomainMs ?? 0,
      interactionDensity: vector?.interactionDensity ?? 0,
      interactionCount1m: vector?.interactionCount1m ?? 0,
      interactionCount5m: vector?.interactionCount5m ?? 0,
      playlistActive: Boolean(vector?.playlistActive),
      extractedAt: vector?.extractedAt ?? Date.now(),
    },
    queueDepth: decisions.getQueueDepth(),
    emittedAt: Date.now(),
  };
}

async function runPipeline(trigger) {
  const vector = extractor.extract();
  latestVector = vector;
  const contextState = context.evaluate(vector);
  latestContextState = contextState;

  if (contextState.changed) {
    console.log('[ContextEngine] State ->', contextState.state);

    if (shouldFlushQueueOnState(contextState.state, contextState.previousState)) {
      await flushQueuedNotifications({
        trigger,
        fromState: contextState.previousState,
        toState: contextState.state,
        focusDomain: contextState.currentDomain,
      });
    }

    wsBridge?.send(buildWsStatePayload(contextState, vector, trigger));
  }

  const pipelineMessage = {
    source: 'pipeline',
    type: 'PIPELINE_UPDATE',
    trigger,
    vector,
    contextState,
    queueDepth: decisions.getQueueDepth(),
  };

  await safeSendMessage(pipelineMessage);
  await safeSendToActiveTabs(pipelineMessage);

  await storage.savePipelineSnapshot({
    vector,
    contextState,
    queueDepth: decisions.getQueueDepth(),
  });
}

function ensureWebSocketBridge() {
  if (wsBridge) return;

  wsBridge = new WebSocketBridge({
    url: 'ws://localhost:8080',
    onOpen: () => {
      console.log('[WS] Connected to ws://localhost:8080');
      wsBridge?.send({
        type: 'EXTENSION_HELLO',
        source: 'chrome-extension',
        ts: Date.now(),
      });
    },
    onClose: () => {
      console.warn('[WS] Connection closed');
    },
    onError: (error) => {
      console.warn('[WS] Error', error);
    },
    onMessage: (message) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'PING') {
        wsBridge?.send({ type: 'PONG', ts: Date.now() });
        return;
      }

      if (message.type === 'INCOMING_NOTIFICATION') {
        schedulePipeline(async () => {
          const decision = await notificationManager.deliver(message.notification ?? {});
          wsBridge?.send({
            type: 'NOTIFICATION_DECISION',
            decision,
            emittedAt: Date.now(),
          });
        });
        return;
      }

      if (message.type === 'REQUEST_STATE_SNAPSHOT') {
        wsBridge?.send({
          type: 'STATE_SNAPSHOT',
          contextState: latestContextState,
          vector: latestVector,
          queueDepth: decisions.getQueueDepth(),
          emittedAt: Date.now(),
        });
      }
    },
  });

  wsBridge.connect();
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) return;

  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
      });

      if (Array.isArray(contexts) && contexts.length > 0) {
        return;
      }
    }

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['WORKERS'],
      justification: 'Keep service worker warm for telemetry pipeline and websocket bridge.',
    });
  } catch (error) {
    const message = String(error?.message ?? error ?? '');
    if (!message.includes('Only a single offscreen document may be created')) {
      console.warn('[SW] Failed to ensure offscreen document', error);
    }
  }
}

async function bootstrap() {
  if (tracker) return;

  await storage.init();
  await ensureOffscreenDocument();
  notificationManager.init();

  notificationManager.setDecisionHandler((notification) =>
    decisions.decide(notification, latestContextState)
  );

  notificationManager.setDecisionListener((payload) => {
    return storage.saveNotificationDecision(payload);
  });

  notificationManager.setDigestListener((items) => {
    return storage.saveDigest(items);
  });

  tracker = new ActivityTracker((payload) => {
    schedulePipeline(async () => {
      extractor.ingest(payload.event);
      await runPipeline(`activity:${payload?.event?.type ?? 'unknown'}`);
    });
  });

  await tracker.init();
  ensureWebSocketBridge();

  globalThis.__testNotification = async (notification = {}) => {
    const payload = {
      title: notification.title ?? 'Test notification',
      body: notification.body ?? 'Overlay should appear on the active tab',
      source: notification.source ?? 'test',
      ...notification,
    };

    const decision = await notificationManager.deliver(payload);
    console.log('[NotificationManager] Test decision ->', decision.action, decision);
    return decision;
  };

  globalThis.__storageSnapshot = () => {
    const snapshot = storage.getSnapshot();
    console.log('[StorageLayer] Snapshot ->', snapshot);
    return snapshot;
  };

  console.log('[SW] Bootstrap complete at', new Date().toISOString());
  console.log('[SW] Test helper ready: __testNotification({...})');
  console.log('[SW] Storage helper ready: __storageSnapshot()');
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SW] onInstalled');
  bootstrap().catch((error) => {
    console.error('[SW] bootstrap failed during install', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[SW] onStartup');
  bootstrap().catch((error) => {
    console.error('[SW] bootstrap failed during startup', error);
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('[SW] Alarm:', alarm.name);
  await bootstrap();
});

chrome.tabs.onActivated.addListener(() => {
  bootstrap().catch((error) => {
    console.error('[SW] bootstrap failed on tab activation', error);
  });
});

chrome.tabs.onUpdated.addListener(() => {
  bootstrap().catch((error) => {
    console.error('[SW] bootstrap failed on tab update', error);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sw-keepalive') return;

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'ping') {
      port.postMessage({ type: 'pong', ts: Date.now() });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'INCOMING_NOTIFICATION') {
    // NotificationManager listener handles this type.
    return false;
  }

  if (msg?.type === 'TELEMETRY_SUMMARY') {
    bootstrap()
      .then(() =>
        schedulePipeline(async () => {
          extractor.ingestTelemetry(msg.telemetry ?? {});
          await runPipeline(`telemetry:${msg?.telemetry?.reason ?? 'summary'}`);
        })
      )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[SW] telemetry pipeline failed', error);
        sendResponse({ ok: false, error: String(error) });
      });

    return true;
  }

  bootstrap()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error('[SW] bootstrap failed on message', error);
      sendResponse({ ok: false, error: String(error) });
    });

  return true;
});

bootstrap().catch((error) => {
  console.error('[SW] initial bootstrap failed', error);
});
