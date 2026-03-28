/**
 * Core module for tracking user activity and emitting structured events.
 */
export class ActivityTracker {
    /**
     * Initializes the ActivityTracker state.
     * Note: No chrome API calls are made in the constructor.
     */
    constructor() {
        this.currentDomain = null;
        this.lastActiveTimestamp = Date.now();
        this.tabSwitchTimestamps = [];
        this.idleState = 'active'; // 'active' | 'idle' | 'locked'

        // Bind internal method contexts to preserve `this` in callbacks
        this._onTabActivated = this._onTabActivated.bind(this);
        this._onTabUpdated = this._onTabUpdated.bind(this);
        this._onTabRemoved = this._onTabRemoved.bind(this);
        this._onWindowFocusChanged = this._onWindowFocusChanged.bind(this);
        this._onIdleChanged = this._onIdleChanged.bind(this);
        this._onAlarm = this._onAlarm.bind(this);
    }

    /**
     * Initializes the tracker, restores state from session storage,
     * attaches all listeners, and detects the current active tab.
     * @returns {Promise<void>} resolves when startup is complete
     */
    async init() {
        this._attachListeners();
        this._setupAlarm();
        this._setupIdle();

        await this._restoreState();
        await this._detectCurrentTab();
    }

    /**
     * Retrieves a point-in-time snapshot of the current state.
     * @returns {Object} snapshot containing current state variables
     */
    getSnapshot() {
        const now = Date.now();
        return {
            currentDomain: this.currentDomain,
            lastActiveTimestamp: this.lastActiveTimestamp,
            tabSwitchTimestamps: [...this.tabSwitchTimestamps],
            tabSwitchRate: this._computeTabSwitchRate(now),
            idleState: this.idleState
        };
    }

    /**
     * Detaches listeners and clears keep-alive alarms.
     * Used when tearing down the module.
     */
    destroy() {
        this._detachListeners();
        try {
            chrome.alarms.clear('keep-alive-alarm', () => {
                if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
            });
        } catch (e) {
            console.warn('Failed to clear alarm on destroy', e);
        }
    }

    // --- Private Methods ---

    /**
     * Attaches all Chrome API listeners for tracking activity.
     */
    _attachListeners() {
        try {
            chrome.tabs.onActivated.addListener(this._onTabActivated);
            chrome.tabs.onUpdated.addListener(this._onTabUpdated);
            chrome.tabs.onRemoved.addListener(this._onTabRemoved);
            chrome.windows.onFocusChanged.addListener(this._onWindowFocusChanged);
            chrome.idle.onStateChanged.addListener(this._onIdleChanged);
            chrome.alarms.onAlarm.addListener(this._onAlarm);
        } catch (e) {
            console.warn('Failed to attach listeners', e);
        }
    }

    /**
     * Detaches all Chrome API listeners.
     */
    _detachListeners() {
        try {
            chrome.tabs.onActivated.removeListener(this._onTabActivated);
            chrome.tabs.onUpdated.removeListener(this._onTabUpdated);
            chrome.tabs.onRemoved.removeListener(this._onTabRemoved);
            chrome.windows.onFocusChanged.removeListener(this._onWindowFocusChanged);
            chrome.idle.onStateChanged.removeListener(this._onIdleChanged);
            chrome.alarms.onAlarm.removeListener(this._onAlarm);
        } catch (e) {
            console.warn('Failed to detach listeners', e);
        }
    }

    /**
     * Sets up the keep-alive alarm per MV3 constraints.
     */
    _setupAlarm() {
        try {
            chrome.alarms.create('keep-alive-alarm', { periodInMinutes: 25 / 60 });
        } catch (e) {
            console.warn('Failed to setup alarm', e);
        }
    }

    /**
     * Configures the idle detection threshold.
     */
    _setupIdle() {
        try {
            chrome.idle.setDetectionInterval(30);
        } catch (e) {
            console.warn('Failed to set idle detection interval', e);
        }
    }

    /**
     * Restores state from chrome.storage.session.
     */
    async _restoreState() {
        try {
            const state = await new Promise(resolve => {
                chrome.storage.session.get(['currentDomain', 'lastActiveTimestamp', 'tabSwitchTimestamps'], (result) => {
                    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
                    resolve(result || {});
                });
            });

            if (state.lastActiveTimestamp !== undefined) {
                this.currentDomain = state.currentDomain || null;
                this.lastActiveTimestamp = state.lastActiveTimestamp;
                this.tabSwitchTimestamps = state.tabSwitchTimestamps || [];
            }
        } catch (e) {
            console.warn('Failed to restore state', e);
        }
    }

    /**
     * Saves the current ephemeral state to chrome.storage.session.
     */
    async _saveState() {
        try {
            await new Promise(resolve => {
                chrome.storage.session.set({
                    currentDomain: this.currentDomain,
                    lastActiveTimestamp: this.lastActiveTimestamp,
                    tabSwitchTimestamps: this.tabSwitchTimestamps
                }, () => {
                    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
                    resolve();
                });
            });
        } catch (e) {
            console.warn('Failed to save state', e);
        }
    }

    /**
     * Cleans up older timestamps and returns the count within the last 60 seconds.
     * @param {number} now
     * @returns {number} tab switch count
     */
    _computeTabSwitchRate(now) {
        this.tabSwitchTimestamps = this.tabSwitchTimestamps.filter(ts => (now - ts) <= 60000);
        return this.tabSwitchTimestamps.length;
    }

    /**
     * Extracts purely the hostname from a full URL.
     * @param {string} url
     * @returns {string|null}
     */
    _extractDomain(url) {
        if (!url) return null;
        try {
            const parsed = new URL(url);
            return parsed.hostname || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Builds the required activity event schema.
     * @param {string} type 'TAB_SWITCH' | 'URL_CHANGE' | 'IDLE' | 'ACTIVE' | 'HEARTBEAT'
     * @param {number} timeOnPrev
     * @param {string|null} domain
     * @returns {Object}
     */
    _buildEvent(type, timeOnPrev, domain) {
        const now = Date.now();
        return {
            type,
            timestamp: now,
            domain,
            tabSwitchRate: this._computeTabSwitchRate(now),
            idleState: this.idleState,
            timeOnPreviousDomain: timeOnPrev
        };
    }

    /**
     * Emits an event to other listeners in the extension.
     * @param {Object} event
     */
    async _sendEvent(event) {
        try {
            await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(event, () => {
                    if (chrome.runtime.lastError) {
                        const msg = chrome.runtime.lastError.message || '';
                        if (!msg.includes('Receiving end does not exist')) {
                            console.warn('Error sending event', chrome.runtime.lastError);
                        }
                    }
                    resolve();
                });
            });
        } catch (e) {
            console.warn('Failed to send event message', e);
        }
    }

    /**
     * Detects the currently active tab on initialization.
     */
    async _detectCurrentTab() {
        try {
            const activeTabs = await new Promise(resolve => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
                    resolve(tabs || []);
                });
            });
            
            if (activeTabs.length > 0) {
                const tab = activeTabs[0];
                const newDomain = this._extractDomain(tab.url);
                if (newDomain !== this.currentDomain) {
                    this.currentDomain = newDomain;
                    this.lastActiveTimestamp = Date.now();
                    await this._saveState();
                }
            } else {
                this.currentDomain = null;
                this.lastActiveTimestamp = Date.now();
                await this._saveState();
            }
        } catch(e) {
            console.warn('Failed to detect current tab', e);
        }
    }

    /**
     * Handler: tab switched.
     */
    async _onTabActivated(activeInfo) {
        try {
            const now = Date.now();
            this.tabSwitchTimestamps.push(now);
            this._computeTabSwitchRate(now);

            const tab = await new Promise(resolve => {
                chrome.tabs.get(activeInfo.tabId, (res) => {
                    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
                    resolve(res);
                });
            });

            let targetDomain = this.currentDomain;
            let domainChanged = false;

            if (tab && tab.url) {
                const parsed = this._extractDomain(tab.url);
                if (parsed) {
                    targetDomain = parsed;
                    if (targetDomain !== this.currentDomain) {
                        domainChanged = true;
                    }
                }
            }

            const timeOnPrev = now - this.lastActiveTimestamp;

            await this._sendEvent(this._buildEvent('TAB_SWITCH', timeOnPrev, targetDomain));

            if (domainChanged) {
                await this._sendEvent(this._buildEvent('URL_CHANGE', timeOnPrev, targetDomain));
                this.currentDomain = targetDomain;
            }

            // Always update last active reference point to avoid double-counting 
            // time spent on one tab when switching context
            this.lastActiveTimestamp = now;
            await this._saveState();

        } catch (e) {
            console.warn('Error in _onTabActivated', e);
        }
    }

    /**
     * Handler: tab fully loaded or URL updated.
     */
    async _onTabUpdated(tabId, changeInfo, tab) {
        try {
            if (!changeInfo.url) return;

            const activeTabs = await new Promise(resolve => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
                    resolve(tabs || []);
                });
            });

            const isActiveTab = activeTabs.some(t => t.id === tabId);
            if (isActiveTab) {
                const newDomain = this._extractDomain(changeInfo.url) || this._extractDomain(tab.url);
                if (newDomain && newDomain !== this.currentDomain) {
                    const now = Date.now();
                    const timeOnPrev = now - this.lastActiveTimestamp;

                    await this._sendEvent(this._buildEvent('URL_CHANGE', timeOnPrev, newDomain));

                    this.currentDomain = newDomain;
                    this.lastActiveTimestamp = now;
                    await this._saveState();
                }
            }
        } catch (e) {
            console.warn('Error in _onTabUpdated', e);
        }
    }

    /**
     * Handler: tab closed. Finalize prior context gracefully if no active tabs remain.
     */
    async _onTabRemoved(tabId, removeInfo) {
        try {
            const activeTabs = await new Promise(resolve => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
                    resolve(tabs || []);
                });
            });

            if (activeTabs.length === 0) {
                const now = Date.now();
                
                if (this.currentDomain !== null) {
                    this.currentDomain = null;
                    this.lastActiveTimestamp = now;
                    await this._saveState();
                }
            }
        } catch (e) {
            console.warn('Error in _onTabRemoved', e);
        }
    }

    /**
     * Handler: browser window focus changed. Affects current user context.
     */
    async _onWindowFocusChanged(windowId) {
        try {
            if (windowId === chrome.windows.WINDOW_ID_NONE) return;

            const activeTabs = await new Promise(resolve => {
                chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
                    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
                    resolve(tabs || []);
                });
            });

            if (activeTabs.length > 0) {
                const tab = activeTabs[0];
                const targetDomain = this._extractDomain(tab.url) || this.currentDomain;
                const now = Date.now();
                const timeOnPrev = now - this.lastActiveTimestamp;

                this.tabSwitchTimestamps.push(now);

                await this._sendEvent(this._buildEvent('TAB_SWITCH', timeOnPrev, targetDomain));

                if (targetDomain !== this.currentDomain && targetDomain !== null) {
                    await this._sendEvent(this._buildEvent('URL_CHANGE', timeOnPrev, targetDomain));
                    this.currentDomain = targetDomain;
                }

                this.lastActiveTimestamp = now;
                await this._saveState();
            }
        } catch (e) {
            console.warn('Error in _onWindowFocusChanged', e);
        }
    }

    /**
     * Handler: idle status changed (e.g. system lockout/sleep).
     */
    async _onIdleChanged(newState) {
        try {
            const now = Date.now();
            const timeOnPrev = now - this.lastActiveTimestamp;

            if (this.idleState !== 'active' && newState === 'active') {
                this.idleState = newState;
                this.lastActiveTimestamp = now;
                await this._sendEvent(this._buildEvent('ACTIVE', timeOnPrev, this.currentDomain));
                await this._saveState();
            } else if (this.idleState === 'active' && newState !== 'active') {
                this.idleState = newState;
                await this._sendEvent(this._buildEvent('IDLE', timeOnPrev, this.currentDomain));
                this.lastActiveTimestamp = now;
                await this._saveState();
            } else {
                this.idleState = newState;
            }
        } catch (e) {
            console.warn('Error in _onIdleChanged', e);
        }
    }

    /**
     * Handler: system requested keep-alive alarm.
     */
    async _onAlarm(alarm) {
        try {
            if (alarm.name === 'keep-alive-alarm') {
                const now = Date.now();
                const timeOnPrev = now - this.lastActiveTimestamp;
                await this._sendEvent(this._buildEvent('HEARTBEAT', timeOnPrev, this.currentDomain));
            }
        } catch (e) {
            console.warn('Error in _onAlarm', e);
        }
    }
}
