/**
 * ActivityTracker — MV3 Service Worker Edition
 *
 * Fixes applied:
 *  1. Alarm interval corrected to 0.5min (Chrome minimum)
 *  2. onEvent callback replaces self-sendMessage anti-pattern
 *  3. Storage write on every heartbeat to extend SW lifetime
 *  4. source field added to every emitted payload
 *  5. Full re-init safety on SW wake via _isInitialized guard
 */
export class ActivityTracker {
  // ─────────────────────────────────────────────
  // CONSTRUCTOR
  // ─────────────────────────────────────────────

  /**
   * @param {Function|null} onEvent - callback fired on every ActivityEvent.
   *   Receives { source: 'activityTracker', event: ActivityEvent }
   *   Use this inside the service worker instead of runtime.onMessage.
   */
  constructor(onEvent = null) {
    this.currentDomain        = null;
    this.lastActiveTimestamp  = Date.now();
    this.tabSwitchTimestamps  = [];
    this.idleState            = 'active'; // 'active' | 'idle' | 'locked'
    this._isInitialized       = false;
    this._onEventCallback     = typeof onEvent === 'function' ? onEvent : null;

    // Bind handlers once — stable references needed for removeListener
    this._onTabActivated        = this._onTabActivated.bind(this);
    this._onTabUpdated          = this._onTabUpdated.bind(this);
    this._onTabRemoved          = this._onTabRemoved.bind(this);
    this._onWindowFocusChanged  = this._onWindowFocusChanged.bind(this);
    this._onIdleChanged         = this._onIdleChanged.bind(this);
    this._onAlarm               = this._onAlarm.bind(this);
  }

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────

  /**
   * Boot the tracker. Safe to call multiple times in the same SW lifetime —
   * the _isInitialized guard prevents double-attaching listeners.
   * @returns {Promise<void>}
   */
  async init() {
    if (this._isInitialized) {
      console.log('[ActivityTracker] Already initialized — skipping re-init');
      return;
    }

    this._attachListeners();
    this._setupAlarm();
    this._setupIdle();

    await this._restoreState();
    await this._detectCurrentTab();

    this._isInitialized = true;
    console.log('[ActivityTracker] Initialized at', new Date().toISOString());
  }

  /**
   * Point-in-time snapshot of current tracker state.
   * @returns {Object}
   */
  getSnapshot() {
    const now = Date.now();
    return {
      currentDomain:        this.currentDomain,
      lastActiveTimestamp:  this.lastActiveTimestamp,
      tabSwitchTimestamps:  [...this.tabSwitchTimestamps],
      tabSwitchRate:        this._computeTabSwitchRate(now),
      idleState:            this.idleState,
    };
  }

  /**
   * Tear down all listeners and alarms.
   * Call this before replacing the tracker instance.
   */
  destroy() {
    this._detachListeners();
    this._isInitialized = false;
    try {
      chrome.alarms.clear('activity-tracker-keepalive', () => {
        if (chrome.runtime.lastError) {
          console.warn('[ActivityTracker] Error clearing alarm:', chrome.runtime.lastError);
        }
      });
    } catch (e) {
      console.warn('[ActivityTracker] Failed to clear alarm on destroy', e);
    }
  }

  // ─────────────────────────────────────────────
  // SETUP HELPERS
  // ─────────────────────────────────────────────

  _attachListeners() {
    try {
      chrome.tabs.onActivated.addListener(this._onTabActivated);
      chrome.tabs.onUpdated.addListener(this._onTabUpdated);
      chrome.tabs.onRemoved.addListener(this._onTabRemoved);
      chrome.windows.onFocusChanged.addListener(this._onWindowFocusChanged);
      chrome.idle.onStateChanged.addListener(this._onIdleChanged);
      chrome.alarms.onAlarm.addListener(this._onAlarm);
    } catch (e) {
      console.warn('[ActivityTracker] Failed to attach listeners', e);
    }
  }

  _detachListeners() {
    try {
      chrome.tabs.onActivated.removeListener(this._onTabActivated);
      chrome.tabs.onUpdated.removeListener(this._onTabUpdated);
      chrome.tabs.onRemoved.removeListener(this._onTabRemoved);
      chrome.windows.onFocusChanged.removeListener(this._onWindowFocusChanged);
      chrome.idle.onStateChanged.removeListener(this._onIdleChanged);
      chrome.alarms.onAlarm.removeListener(this._onAlarm);
    } catch (e) {
      console.warn('[ActivityTracker] Failed to detach listeners', e);
    }
  }

  /**
   * FIX: was 25/60 = 0.41min — Chrome's hard minimum is 0.5min.
   * Anything below 0.5 gets silently rounded up to 1 minute,
   * creating a 60s gap where the SW is dead and misses events.
   */
  _setupAlarm() {
    try {
      chrome.alarms.create('activity-tracker-keepalive', {
        periodInMinutes: 0.5, // ✅ 30 seconds — Chrome's enforced minimum
      });
    } catch (e) {
      console.warn('[ActivityTracker] Failed to create alarm', e);
    }
  }

  _setupIdle() {
    try {
      chrome.idle.setDetectionInterval(30);
    } catch (e) {
      console.warn('[ActivityTracker] Failed to set idle interval', e);
    }
  }

  // ─────────────────────────────────────────────
  // STATE PERSISTENCE
  // ─────────────────────────────────────────────

  async _restoreState() {
    try {
      const state = await chrome.storage.session.get([
        'currentDomain',
        'lastActiveTimestamp',
        'tabSwitchTimestamps',
        'idleState',
      ]);

      if (state.lastActiveTimestamp !== undefined) {
        this.currentDomain       = state.currentDomain       ?? null;
        this.lastActiveTimestamp = state.lastActiveTimestamp;
        this.tabSwitchTimestamps = state.tabSwitchTimestamps  ?? [];
        this.idleState           = state.idleState            ?? 'active';
        console.log('[ActivityTracker] State restored:', this.currentDomain);
      }
    } catch (e) {
      console.warn('[ActivityTracker] Failed to restore state', e);
    }
  }

  async _saveState() {
    try {
      await chrome.storage.session.set({
        currentDomain:       this.currentDomain,
        lastActiveTimestamp: this.lastActiveTimestamp,
        tabSwitchTimestamps: this.tabSwitchTimestamps,
        idleState:           this.idleState,
      });
    } catch (e) {
      console.warn('[ActivityTracker] Failed to save state', e);
    }
  }

  // ─────────────────────────────────────────────
  // COMPUTATION HELPERS
  // ─────────────────────────────────────────────

  /**
   * Prunes stale timestamps and returns count within last 60s.
   * @param {number} now
   * @returns {number}
   */
  _computeTabSwitchRate(now) {
    this.tabSwitchTimestamps = this.tabSwitchTimestamps.filter(
      ts => (now - ts) <= 60_000
    );
    return this.tabSwitchTimestamps.length;
  }

  /**
   * Returns hostname only — never stores full URLs.
   * @param {string} url
   * @returns {string|null}
   */
  _extractDomain(url) {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      return null;
    }
    try {
      return new URL(url).hostname || null;
    } catch {
      return null;
    }
  }

  /**
   * Builds a typed ActivityEvent payload.
   * @param {'TAB_SWITCH'|'URL_CHANGE'|'IDLE'|'ACTIVE'|'HEARTBEAT'} type
   * @param {number} timeOnPrev  ms spent on previous domain
   * @param {string|null} domain
   * @returns {ActivityEvent}
   */
  _buildEvent(type, timeOnPrev, domain) {
    const now = Date.now();
    return {
      type,
      timestamp:            now,
      domain,
      tabSwitchRate:        this._computeTabSwitchRate(now),
      idleState:            this.idleState,
      timeOnPreviousDomain: timeOnPrev,
    };
  }

  // ─────────────────────────────────────────────
  // EVENT DISPATCH
  // ─────────────────────────────────────────────

  /**
   * FIX: Service workers cannot receive their own sendMessage calls.
   * Solution: fire the onEvent callback for internal SW consumers,
   * then also broadcast via sendMessage for popup / content scripts.
   * @param {ActivityEvent} event
   */
  async _sendEvent(event) {
    const payload = { source: 'activityTracker', event };

    // ① Internal delivery — direct callback, zero overhead, works in SW
    if (this._onEventCallback) {
      try {
        this._onEventCallback(payload);
      } catch (e) {
        console.warn('[ActivityTracker] onEvent callback threw', e);
      }
    }

    // ② External delivery — popup or content scripts if they are open
    try {
      await chrome.runtime.sendMessage(payload);
    } catch (e) {
      const msg = e?.message ?? '';
      // Silence expected error when no other page is listening
      if (!msg.includes('Receiving end does not exist')) {
        console.warn('[ActivityTracker] sendMessage failed', e);
      }
    }
  }

  // ─────────────────────────────────────────────
  // INITIALISATION HELPER
  // ─────────────────────────────────────────────

  async _detectCurrentTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

      if (tabs.length > 0) {
        const domain = this._extractDomain(tabs[0].url);
        if (domain !== this.currentDomain) {
          this.currentDomain       = domain;
          this.lastActiveTimestamp = Date.now();
          await this._saveState();
        }
      } else {
        this.currentDomain       = null;
        this.lastActiveTimestamp = Date.now();
        await this._saveState();
      }
    } catch (e) {
      console.warn('[ActivityTracker] Failed to detect current tab', e);
    }
  }

  // ─────────────────────────────────────────────
  // EVENT HANDLERS
  // ─────────────────────────────────────────────

  async _onTabActivated(activeInfo) {
    try {
      const now = Date.now();
      this.tabSwitchTimestamps.push(now);

      const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
      if (!tab) return;

      const newDomain    = this._extractDomain(tab.url);
      const timeOnPrev   = now - this.lastActiveTimestamp;
      const domainChanged = newDomain && newDomain !== this.currentDomain;

      await this._sendEvent(this._buildEvent('TAB_SWITCH', timeOnPrev, newDomain ?? this.currentDomain));

      if (domainChanged) {
        await this._sendEvent(this._buildEvent('URL_CHANGE', timeOnPrev, newDomain));
        this.currentDomain = newDomain;
      }

      this.lastActiveTimestamp = now;
      await this._saveState();
    } catch (e) {
      console.warn('[ActivityTracker] _onTabActivated error', e);
    }
  }

  async _onTabUpdated(tabId, changeInfo, tab) {
    try {
      if (!changeInfo.url) return;

      const tabs        = await chrome.tabs.query({ active: true, currentWindow: true });
      const isActiveTab = tabs.some(t => t.id === tabId);
      if (!isActiveTab) return;

      const newDomain = this._extractDomain(changeInfo.url)
                     ?? this._extractDomain(tab.url);

      if (!newDomain || newDomain === this.currentDomain) return;

      const now        = Date.now();
      const timeOnPrev = now - this.lastActiveTimestamp;

      await this._sendEvent(this._buildEvent('URL_CHANGE', timeOnPrev, newDomain));

      this.currentDomain       = newDomain;
      this.lastActiveTimestamp = now;
      await this._saveState();
    } catch (e) {
      console.warn('[ActivityTracker] _onTabUpdated error', e);
    }
  }

  async _onTabRemoved(tabId, removeInfo) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length === 0 && this.currentDomain !== null) {
        this.currentDomain       = null;
        this.lastActiveTimestamp = Date.now();
        await this._saveState();
      }
    } catch (e) {
      console.warn('[ActivityTracker] _onTabRemoved error', e);
    }
  }

  async _onWindowFocusChanged(windowId) {
    try {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;

      const tabs = await chrome.tabs.query({ active: true, windowId });
      if (tabs.length === 0) return;

      const newDomain  = this._extractDomain(tabs[0].url) ?? this.currentDomain;
      const now        = Date.now();
      const timeOnPrev = now - this.lastActiveTimestamp;

      this.tabSwitchTimestamps.push(now);
      await this._sendEvent(this._buildEvent('TAB_SWITCH', timeOnPrev, newDomain));

      if (newDomain && newDomain !== this.currentDomain) {
        await this._sendEvent(this._buildEvent('URL_CHANGE', timeOnPrev, newDomain));
        this.currentDomain = newDomain;
      }

      this.lastActiveTimestamp = now;
      await this._saveState();
    } catch (e) {
      console.warn('[ActivityTracker] _onWindowFocusChanged error', e);
    }
  }

  async _onIdleChanged(newState) {
    try {
      const now        = Date.now();
      const timeOnPrev = now - this.lastActiveTimestamp;
      const wasActive  = this.idleState === 'active';
      const nowActive  = newState === 'active';

      this.idleState           = newState;
      this.lastActiveTimestamp = now;

      if (!wasActive && nowActive) {
        await this._sendEvent(this._buildEvent('ACTIVE', timeOnPrev, this.currentDomain));
      } else if (wasActive && !nowActive) {
        await this._sendEvent(this._buildEvent('IDLE', timeOnPrev, this.currentDomain));
      }

      await this._saveState();
    } catch (e) {
      console.warn('[ActivityTracker] _onIdleChanged error', e);
    }
  }

  /**
   * FIX: Added chrome.storage.session.set inside the heartbeat.
   * A storage write actively extends the SW lifetime beyond the alarm tick.
   * Without this, the SW can die between alarm intervals.
   */
  async _onAlarm(alarm) {
    try {
      if (alarm.name !== 'activity-tracker-keepalive') return;

      const now        = Date.now();
      const timeOnPrev = now - this.lastActiveTimestamp;

      // ✅ This storage write is the actual keep-alive mechanism
      await chrome.storage.session.set({ lastHeartbeat: now });

      await this._sendEvent(
        this._buildEvent('HEARTBEAT', timeOnPrev, this.currentDomain)
      );
    } catch (e) {
      console.warn('[ActivityTracker] _onAlarm error', e);
    }
  }
}