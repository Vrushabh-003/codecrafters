/**
 * ContextEngine
 * Consumes a FeatureVector and outputs a FocusState.
 * Pure computation — no chrome APIs, fully testable.
 *
 * FocusState:
 *   'deep_focus'   — sustained work, low switching, long dwell
 *   'focused'      — working, minor distractions
 *   'distracted'   — high switching, short dwell, distracting domains
 *   'idle'         — system idle or locked
 *   'in_meeting'   — on a video/calendar tool
 *   'transitioning'— between tasks, unclear context
 */
export class ContextEngine {
  /** @type {FocusState[]} rolling history of last N states */
  #stateHistory = [];
  #historyLimit = 20;

  /** @type {FocusState} */
  #currentState = 'transitioning';

  /** @type {number} timestamp of last state change */
  #lastStateChange = Date.now();

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────

  /**
   * Feed a FeatureVector in, get a FocusState out.
   * Call this every time FeatureExtractor emits a new vector.
   * @param {FeatureVector} vector
   * @returns {ContextState}
   */
  evaluate(vector) {
    const raw       = this.#classify(vector);
    const smoothed  = this.#smooth(raw);
    const changed   = smoothed !== this.#currentState;

    if (changed) {
      this.#stateHistory.push(this.#currentState);
      if (this.#stateHistory.length > this.#historyLimit) {
        this.#stateHistory.shift();
      }
      this.#lastStateChange = Date.now();
      this.#currentState    = smoothed;
    }

    return {
      state:            this.#currentState,
      previousState:    this.#stateHistory.at(-1) ?? null,
      changed,
      stateAgeMs:       Date.now() - this.#lastStateChange,
      focusScore:       vector.focusScore,
      domainCategory:   vector.currentDomainCategory,
      evaluatedAt:      Date.now(),
    };
  }

  /**
   * Current state without re-evaluating.
   * @returns {FocusState}
   */
  getState() {
    return this.#currentState;
  }

  /**
   * Full state history — useful for analytics dashboard.
   * @returns {FocusState[]}
   */
  getHistory() {
    return [...this.#stateHistory];
  }

  reset() {
    this.#stateHistory  = [];
    this.#currentState  = 'transitioning';
    this.#lastStateChange = Date.now();
  }

  // ─────────────────────────────────────────────
  // PRIVATE — CLASSIFICATION
  // ─────────────────────────────────────────────

  /**
   * Rule-based classifier. Returns raw FocusState.
   * Replace individual rules with ML model scores later
   * without changing the public API.
   * @param {FeatureVector} v
   * @returns {FocusState}
   */
  #classify(v) {
    // ── Idle / locked ──────────────────────────
    if (v.isIdle) return 'idle';

    // ── Meeting detection ──────────────────────
    if (v.currentDomainCategory === 'communication') {
      if (v.timeOnCurrentDomainMs > 60_000) return 'in_meeting';
    }

    // ── Deep focus ─────────────────────────────
    if (
      v.focusScore        >= 0.80 &&
      v.tabSwitchRate1m   <= 1    &&
      v.currentDomainCategory === 'productivity'
    ) return 'deep_focus';

    // ── Focused ────────────────────────────────
    if (
      v.focusScore       >= 0.55 &&
      v.tabSwitchRate1m  <= 4
    ) return 'focused';

    // ── Distracted ─────────────────────────────
    if (
      v.focusScore        <= 0.30 ||
      v.tabSwitchRate1m   >= 8    ||
      v.currentDomainCategory === 'distraction'
    ) return 'distracted';

    // ── Transitioning (default) ────────────────
    return 'transitioning';
  }

  /**
   * Prevent state flickering by requiring 2 consecutive
   * identical raw states before committing the change.
   * @param {FocusState} newRaw
   * @returns {FocusState}
   */
  #smooth(newRaw) {
    const prev = this.#stateHistory.at(-1);
    // If new raw matches previous — commit it
    if (newRaw === prev) return newRaw;
    // If same as current — keep current (no change)
    if (newRaw === this.#currentState) return this.#currentState;
    // Otherwise hold current for one more tick (debounce)
    return this.#currentState;
  }
}