import { ActivityTracker } from './activityTracker.js';
import { FeatureExtractor } from './featureExtractor.js';
import { ContextEngine    } from './contextEngine.js';
import { DecisionEngine   } from './decisionEngine.js';
import { NotificationManager } from './notificationManager.js';

const extractor = new FeatureExtractor();
const context = new ContextEngine();
const decisions = new DecisionEngine();
const notificationManager = new NotificationManager();
let tracker = null;
let latestContextState = {
  state: 'transitioning',
  previousState: null,
  changed: false,
  stateAgeMs: 0,
  focusScore: 0,
  domainCategory: 'unknown',
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

async function bootstrap() {
  if (tracker) return;

  notificationManager.init();

  tracker = new ActivityTracker((payload) => {
    extractor.ingest(payload.event);

    const vector = extractor.extract();
    const contextState = context.evaluate(vector);
    latestContextState = contextState;

    if (contextState.changed) {
      console.log('[ContextEngine] State ->', contextState.state);

      if (
        contextState.state === 'idle' ||
        contextState.state === 'transitioning'
      ) {
        const digest = decisions.flushQueue();
        if (digest.length > 0) {
          console.log(`[DecisionEngine] Flushing ${digest.length} queued notifications`);
          notificationManager.flushDigest(digest);
          safeSendMessage({
            source: 'decisionEngine',
            type: 'DIGEST',
            items: digest,
          });
        }
      }
    }

    notificationManager.setDecisionHandler((notification) => {
      return decisions.decide(notification, latestContextState);
    });

    globalThis.__decideNotification = (notification) => {
      return decisions.decide(notification, latestContextState);
    };

    safeSendMessage({
      source: 'pipeline',
      vector,
      contextState,
      queueDepth: decisions.getQueueDepth(),
    });
  });

  await tracker.init();
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
  console.log('[SW] Bootstrap complete at', new Date().toISOString());
  console.log('[SW] Test helper ready: __testNotification({...})');
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'INCOMING_NOTIFICATION') {
    return false;
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
