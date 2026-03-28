/**
 * NotificationManager
 * Bridges incoming notifications, the DecisionEngine, and the in-page overlay.
 * Runs in the MV3 service worker.
 */
export class NotificationManager {
  /** @type {(notification: IncomingNotification) => Decision | null} */
  #decisionHandler = null;

  /** @type {boolean} */
  #isInitialized = false;

  init() {
    if (this.#isInitialized) return;
    chrome.runtime.onMessage.addListener(this.#onRuntimeMessage);
    this.#isInitialized = true;
  }

  setDecisionHandler(handler) {
    this.#decisionHandler = typeof handler === 'function' ? handler : null;
  }

  async flushDigest(items) {
    if (!Array.isArray(items) || items.length === 0) return;

    await this.#broadcastToOverlay({
      source: 'notificationManager',
      type: 'OVERLAY_DIGEST',
      items,
      deliveredAt: Date.now(),
    });
  }

  async deliver(notification) {
    const decision = this.#decisionHandler?.(notification) ?? {
      action: 'SHOW',
      priority: 'MEDIUM',
      notification,
      contextState: 'transitioning',
      reason: 'No decision handler registered',
      decidedAt: Date.now(),
    };

    if (decision.action === 'SHOW') {
      await this.#broadcastToOverlay({
        source: 'notificationManager',
        type: 'OVERLAY_NOTIFICATION',
        notification,
        decision,
        deliveredAt: Date.now(),
      });
    }

    await this.#safeRuntimeMessage({
      source: 'notificationManager',
      type: 'NOTIFICATION_DECISION',
      notification,
      decision,
      queueDepth: null,
    });

    return decision;
  }

  async #broadcastToOverlay(message) {
    const tabs = await this.#getActiveTabs();

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

  async #getActiveTabs() {
    try {
      return await chrome.tabs.query({ active: true });
    } catch (error) {
      console.warn('[NotificationManager] failed to query active tabs', error);
      return [];
    }
  }

  async #safeRuntimeMessage(message) {
    try {
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      const text = String(error?.message ?? error ?? '');
      if (!text.includes('Receiving end does not exist')) {
        console.warn('[NotificationManager] runtime message failed', error);
      }
    }
  }

  #normalizeNotification(payload) {
    if (!payload || typeof payload !== 'object') return null;

    return {
      id: payload.id ?? `notif-${Date.now()}`,
      title: payload.title ?? 'Untitled notification',
      body: payload.body ?? '',
      source: payload.source ?? 'unknown',
      url: payload.url ?? null,
      createdAt: payload.createdAt ?? Date.now(),
      metadata: payload.metadata ?? {},
    };
  }

  #onRuntimeMessage(message, sender, sendResponse) {
    if (message?.type !== 'INCOMING_NOTIFICATION') return false;

    const notification = this.#normalizeNotification(message.notification);
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
