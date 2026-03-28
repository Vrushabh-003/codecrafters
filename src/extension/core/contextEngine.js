/**
 * ContextEngine
 * Rule-based, app-agnostic engagement classifier.
 *
 * States:
 * - active_focus
 * - passive_focus
 * - distracted
 * - idle
 * - transitioning
 */
export class ContextEngine {
  #stateHistory = [];
  #historyLimit = 50;
  #currentState = 'transitioning';
  #previousState = null;
  #lastStateChange = Date.now();
  #pendingState = null;
  #pendingCount = 0;

  evaluate(vector) {
    const now = Date.now();
    const { state: rawState, reason } = this.#classify(vector);
    const committed = this.#commitWithSmoothing(rawState);

    const modifiers = [];
    if (vector.playlistActive) modifiers.push('playlist_mode');
    if (vector.currentDomainCategory === 'media') modifiers.push('media_domain');
    if (vector.currentDomainCategory === 'social') modifiers.push('social_domain');

    return {
      state: this.#currentState,
      previousState: this.#previousState,
      changed: committed,
      stateAgeMs: now - this.#lastStateChange,
      focusScore: vector.focusScore,
      domainCategory: vector.currentDomainCategory,
      currentDomain: vector.currentDomain,
      interactionDensity: vector.interactionDensity,
      interactionToDwellRatio: vector.interactionToDwellRatio,
      playlistActive: vector.playlistActive,
      modifiers,
      classificationReason: reason,
      rawState,
      evaluatedAt: now,
    };
  }

  getState() {
    return this.#currentState;
  }

  getHistory() {
    return [...this.#stateHistory];
  }

  reset() {
    this.#stateHistory = [];
    this.#currentState = 'transitioning';
    this.#previousState = null;
    this.#lastStateChange = Date.now();
    this.#pendingState = null;
    this.#pendingCount = 0;
  }

  #classify(v) {
    if (v.isIdle) {
      return { state: 'idle', reason: 'idle signal from chrome.idle' };
    }

    if (v.tabSwitchRate1m >= 6 || v.tabSwitchRate5m >= 20) {
      return {
        state: 'distracted',
        reason: 'high tab-switch rate dominates attention',
      };
    }

    const dwellMs = v.timeOnCurrentDomainMs;
    const longPresence = dwellMs >= 120_000;
    const veryShortPresence = dwellMs < 60_000;
    const lowSwitch = v.tabSwitchRate1m <= 2;
    const moderateSwitch = v.tabSwitchRate1m <= 4;

    const interactionDensity = v.interactionDensity;
    const highInteraction = interactionDensity >= 22;
    const mediumInteraction = interactionDensity >= 4;
    const lowInteraction = interactionDensity < 4;
    const scrollShare = Number(v?.inputModalityMix?.scroll ?? 0);
    const keydownShare = Number(v?.inputModalityMix?.keydown ?? 0);
    const scrollDominant = scrollShare >= 0.45 && keydownShare <= 0.25;
    const typingLikely = keydownShare >= 0.2;
    const productivityLikeDomain = ['productivity', 'communication'].includes(
      v.currentDomainCategory
    );
    const readingLikeDomain = ['media', 'social', 'reference', 'neutral'].includes(
      v.currentDomainCategory
    );

    if (longPresence && lowSwitch && highInteraction) {
      if (v.currentDomainCategory === 'media' && v.playlistActive) {
        return {
          state: 'passive_focus',
          reason: 'media playlist modifier with stable dwell',
        };
      }

      if (typingLikely || productivityLikeDomain) {
        return {
          state: 'active_focus',
          reason: 'high interaction density with low switching and creation-like input',
        };
      }

      if (scrollDominant || readingLikeDomain) {
        return {
          state: 'passive_focus',
          reason: 'high interaction but scroll-dominant reading behavior',
        };
      }
    }

    if (
      longPresence &&
      moderateSwitch &&
      (mediumInteraction || v.playlistActive || scrollDominant)
    ) {
      return {
        state: 'passive_focus',
        reason: 'stable dwell with low-to-medium interactions',
      };
    }

    if ((veryShortPresence && v.tabSwitchRate1m >= 3) || (lowInteraction && v.tabSwitchRate1m >= 4)) {
      return {
        state: 'distracted',
        reason: 'short dwell and rapid context shifts',
      };
    }

    if (longPresence && lowInteraction) {
      return {
        state: 'passive_focus',
        reason: 'long dwell with minimal interaction',
      };
    }

    return {
      state: 'transitioning',
      reason: 'insufficient evidence for stable classification',
    };
  }

  #commitWithSmoothing(rawState) {
    if (rawState === this.#currentState) {
      this.#pendingState = null;
      this.#pendingCount = 0;
      return false;
    }

    if (rawState === this.#pendingState) {
      this.#pendingCount += 1;
    } else {
      this.#pendingState = rawState;
      this.#pendingCount = 1;
    }

    const threshold = rawState === 'idle' || rawState === 'distracted' ? 1 : 2;
    if (this.#pendingCount < threshold) {
      return false;
    }

    this.#previousState = this.#currentState;
    this.#stateHistory.push(this.#currentState);
    if (this.#stateHistory.length > this.#historyLimit) {
      this.#stateHistory.shift();
    }

    this.#currentState = rawState;
    this.#lastStateChange = Date.now();
    this.#pendingState = null;
    this.#pendingCount = 0;
    return true;
  }
}
