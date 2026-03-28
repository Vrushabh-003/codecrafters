/**
 * StorageLayer
 * Provides a small persistence facade for MV3 using chrome.storage plus
 * an in-memory cache for the current worker lifetime.
 */
export class StorageLayer {
  #cache = {
    latestPipeline: null,
    latestDecision: null,
    latestDigest: null,
  };

  async init() {
    try {
      const state = await chrome.storage.local.get([
        'latestPipeline',
        'latestDecision',
        'latestDigest',
      ]);

      this.#cache.latestPipeline = state.latestPipeline ?? null;
      this.#cache.latestDecision = state.latestDecision ?? null;
      this.#cache.latestDigest = state.latestDigest ?? null;
    } catch (error) {
      console.warn('[StorageLayer] failed to restore cache', error);
    }
  }

  async savePipelineSnapshot({ vector, contextState, queueDepth }) {
    const payload = {
      vector,
      contextState,
      queueDepth,
      savedAt: Date.now(),
    };

    this.#cache.latestPipeline = payload;
    await this.#setLocal({ latestPipeline: payload });
    await this.#setSession({ latestPipelineSavedAt: payload.savedAt });
    return payload;
  }

  async saveNotificationDecision({ notification, decision, queueDepth }) {
    const safeNotification = this.#sanitizeNotification(notification);

    const payload = {
      notification: safeNotification,
      decision: {
        action: decision?.action ?? 'DELAY',
        priority: decision?.priority ?? 'MEDIUM',
        contextState: decision?.contextState ?? 'transitioning',
        reason: decision?.reason ?? '',
        queueDepth: decision?.queueDepth ?? queueDepth ?? null,
        decidedAt: decision?.decidedAt ?? Date.now(),
      },
      queueDepth,
      savedAt: Date.now(),
    };

    this.#cache.latestDecision = payload;
    await this.#setLocal({ latestDecision: payload });
    return payload;
  }

  async saveDigest(items) {
    const safeItems = (Array.isArray(items) ? items : []).map((item) => ({
      priority: item?.priority ?? 'MEDIUM',
      action: item?.action ?? 'DELAY',
      queuedAt: item?.queuedAt ?? Date.now(),
      delayedMs: item?.delayedMs ?? 0,
      contextStateAtQueue: item?.contextStateAtQueue ?? 'transitioning',
      queuedDomain: item?.queuedDomain ?? null,
      explain: item?.explain ?? null,
      notification: this.#sanitizeNotification(item?.notification),
    }));

    const payload = {
      items: safeItems,
      count: safeItems.length,
      savedAt: Date.now(),
    };

    this.#cache.latestDigest = payload;
    await this.#setLocal({ latestDigest: payload });
    return payload;
  }

  getSnapshot() {
    return { ...this.#cache };
  }

  async #setLocal(value) {
    try {
      await chrome.storage.local.set(value);
    } catch (error) {
      console.warn('[StorageLayer] local write failed', error);
    }
  }

  async #setSession(value) {
    try {
      await chrome.storage.session.set(value);
    } catch (error) {
      console.warn('[StorageLayer] session write failed', error);
    }
  }

  #sanitizeNotification(notification) {
    if (!notification || typeof notification !== 'object') return null;

    return {
      id: notification.id ?? null,
      source: notification.source ?? 'unknown',
      priority: notification.priority ?? null,
      createdAt: notification.createdAt ?? Date.now(),
      hasBody: Boolean(notification.body),
      hasTitle: Boolean(notification.title),
    };
  }
}
