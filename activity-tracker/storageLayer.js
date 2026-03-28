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
    const payload = {
      notification,
      decision,
      queueDepth,
      savedAt: Date.now(),
    };

    this.#cache.latestDecision = payload;
    await this.#setLocal({ latestDecision: payload });
    return payload;
  }

  async saveDigest(items) {
    const payload = {
      items,
      count: Array.isArray(items) ? items.length : 0,
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
}
