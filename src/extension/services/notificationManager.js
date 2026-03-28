/**
 * NotificationManager
 * Bridges incoming notifications, DecisionEngine, and overlay delivery.
 */
export class NotificationManager {
  constructor() {
    this.decisionHandler = null;
    this.decisionListener = null;
    this.digestListener = null;
    this.isInitialized = false;

    this.runtimeListener = (message, sender, sendResponse) =>
      this.onRuntimeMessage(message, sender, sendResponse);
    this.notificationClickedListener = (notificationId) =>
      this.onChromeNotificationClicked(notificationId);
    this.notificationClosedListener = (notificationId, byUser) =>
      this.onChromeNotificationClosed(notificationId, byUser);
  }

  init() {
    if (this.isInitialized) return;

    chrome.runtime.onMessage.addListener(this.runtimeListener);

    if (chrome.notifications?.onClicked) {
      chrome.notifications.onClicked.addListener(this.notificationClickedListener);
    }

    if (chrome.notifications?.onClosed) {
      chrome.notifications.onClosed.addListener(this.notificationClosedListener);
    }

    this.isInitialized = true;
  }

  setDecisionHandler(handler) {
    this.decisionHandler = typeof handler === 'function' ? handler : null;
  }

  setDecisionListener(listener) {
    this.decisionListener = typeof listener === 'function' ? listener : null;
  }

  setDigestListener(listener) {
    this.digestListener = typeof listener === 'function' ? listener : null;
  }

  async flushDigest(items, metadata = {}) {
    if (!Array.isArray(items) || items.length === 0) return;

    if (this.digestListener) {
      await this.digestListener(items);
    }

    await this.broadcastToOverlay({
      source: 'notificationManager',
      type: 'OVERLAY_DIGEST',
      items,
      metadata,
      deliveredAt: Date.now(),
    });
  }

  async deliver(notification) {
    const normalized = this.normalizeNotification(notification);
    if (!normalized) {
      throw new Error('Invalid notification payload');
    }

    const decision = this.decisionHandler?.(normalized) ?? {
      action: 'SHOW',
      priority: 'MEDIUM',
      notification: normalized,
      contextState: 'transitioning',
      reason: 'No decision handler registered',
      queueDepth: null,
      decidedAt: Date.now(),
    };

    if (decision.action === 'SHOW') {
      await this.broadcastToOverlay({
        source: 'notificationManager',
        type: 'OVERLAY_NOTIFICATION',
        notification: normalized,
        decision,
        deliveredAt: Date.now(),
      });
    }

    const queueDepth =
      typeof decision.queueDepth === 'number' ? decision.queueDepth : null;

    await this.safeRuntimeMessage({
      source: 'notificationManager',
      type: 'NOTIFICATION_DECISION',
      notification: normalized,
      decision,
      queueDepth,
    });

    if (this.decisionListener) {
      await this.decisionListener({
        notification: normalized,
        decision,
        queueDepth,
      });
    }

    return decision;
  }

  async broadcastToOverlay(message) {
    const tabs = await this.getActiveTabs();

    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab.id) return;

        try {
          await chrome.tabs.sendMessage(tab.id, message);
        } catch (error) {
          const text = String(error?.message ?? error ?? '');
          if (
            !text.includes('Receiving end does not exist') &&
            !text.includes('Could not establish connection')
          ) {
            console.warn('[NotificationManager] overlay delivery failed', error);
          }
        }
      })
    );
  }

  async getActiveTabs() {
    try {
      return await chrome.tabs.query({ active: true });
    } catch (error) {
      console.warn('[NotificationManager] failed to query active tabs', error);
      return [];
    }
  }

  async safeRuntimeMessage(message) {
    try {
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      const text = String(error?.message ?? error ?? '');
      if (!text.includes('Receiving end does not exist')) {
        console.warn('[NotificationManager] runtime message failed', error);
      }
    }
  }

  normalizeNotification(payload) {
    if (!payload || typeof payload !== 'object') return null;

    return {
      id: payload.id ?? `notif-${Date.now()}`,
      title: payload.title ?? 'Untitled notification',
      body: payload.body ?? '',
      source: payload.source ?? 'unknown',
      priority: payload.priority ?? null,
      url: payload.url ?? null,
      createdAt: payload.createdAt ?? Date.now(),
      metadata: payload.metadata ?? {},
    };
  }

  onChromeNotificationClicked(notificationId) {
    this.safeRuntimeMessage({
      source: 'notificationManager',
      type: 'BROWSER_NOTIFICATION_EVENT',
      event: 'clicked',
      notificationId,
      happenedAt: Date.now(),
    });
  }

  onChromeNotificationClosed(notificationId, byUser) {
    this.safeRuntimeMessage({
      source: 'notificationManager',
      type: 'BROWSER_NOTIFICATION_EVENT',
      event: byUser ? 'closed_by_user' : 'closed',
      notificationId,
      happenedAt: Date.now(),
    });
  }

  onRuntimeMessage(message, sender, sendResponse) {
    if (message?.type !== 'INCOMING_NOTIFICATION') return false;

    const notification = this.normalizeNotification(message.notification);
    if (!notification) {
      sendResponse({ ok: false, error: 'Invalid notification payload' });
      return false;
    }

    this.deliver(notification)
      .then((decision) => sendResponse({ ok: true, decision }))
      .catch((error) => {
        console.error('[NotificationManager] failed to process notification', error);
        sendResponse({ ok: false, error: String(error) });
      });

    return true;
  }
}
