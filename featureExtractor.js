/**
 * FeatureExtractor
 * Consumes raw ActivityEvents from ActivityTracker.
 * Derives a normalized feature vector — pure computation, no chrome APIs.
 * Output feeds directly into the Context Engine.
 */
export class FeatureExtractor {
  /** @type {ActivityEvent[]} */
  #eventBuffer = [];

  /** @type {number} max events to keep in rolling buffer */
  #bufferLimit = 200;

  /** @type {Map<string, number>} domain → total ms spent */
  #domainTimeMap = new Map();

  /** @type {string|null} */
  #currentDomain = null;

  /** @type {number} timestamp when current domain became active */
  #domainEntryTime = Date.now();

  constructor() {}

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────

  /**
   * Feed a new ActivityEvent into the extractor.
   * Call this every time ActivityTracker emits an event.
   * @param {ActivityEvent} event
   */
  ingest(event) {
    this.#eventBuffer.push(event);
    if (this.#eventBuffer.length > this.#bufferLimit) {
      this.#eventBuffer.shift();
    }
    this.#updateDomainTime(event);
  }

  /**
   * Returns the current feature vector.
   * Call this before passing state to the Context Engine.
   * @returns {FeatureVector}
   */
  extract() {
    const now = Date.now();
    const window60 = this.#eventsInWindow(60_000);
    const window300 = this.#eventsInWindow(300_000);

    return {
      // ── Switching behaviour ──
      tabSwitchRate1m:    this.#countByType(window60, 'TAB_SWITCH'),
      tabSwitchRate5m:    this.#countByType(window300, 'TAB_SWITCH'),
      uniqueDomainsVisited: this.#uniqueDomains(window300),

      // ── Time on current domain ──
      timeOnCurrentDomainMs: this.#timeOnCurrentDomain(now),

      // ── Idle signals ──
      isIdle:             this.#latestIdleState() !== 'active',
      idleStateCurrent:   this.#latestIdleState(),
      idleEventsLast5m:   this.#countByType(window300, 'IDLE'),

      // ── Focus score (0–1, higher = more focused) ──
      focusScore:         this.#computeFocusScore(window60, now),

      // ── Domain category ──
      currentDomain:      this.#currentDomain,
      currentDomainCategory: this.#categorizeDomain(this.#currentDomain),

      // ── Metadata ──
      bufferSize:         this.#eventBuffer.length,
      extractedAt:        now,
    };
  }

  /**
   * Reset all internal state (call on session end or user sign-out).
   */
  reset() {
    this.#eventBuffer = [];
    this.#domainTimeMap.clear();
    this.#currentDomain = null;
    this.#domainEntryTime = Date.now();
  }

  /**
   * Snapshot of time spent per domain this session (ms).
   * @returns {Record<string, number>}
   */
  getDomainTimeSnapshot() {
    return Object.fromEntries(this.#domainTimeMap);
  }

  // ─────────────────────────────────────────────
  // PRIVATE METHODS
  // ─────────────────────────────────────────────

  /**
   * Returns events within the last `windowMs` milliseconds.
   * @param {number} windowMs
   * @returns {ActivityEvent[]}
   */
  #eventsInWindow(windowMs) {
    const cutoff = Date.now() - windowMs;
    return this.#eventBuffer.filter(e => e.timestamp >= cutoff);
  }

  /**
   * Count events of a specific type in a given set.
   * @param {ActivityEvent[]} events
   * @param {string} type
   * @returns {number}
   */
  #countByType(events, type) {
    return events.filter(e => e.type === type).length;
  }

  /**
   * Count unique domains visited in a given event set.
   * @param {ActivityEvent[]} events
   * @returns {number}
   */
  #uniqueDomains(events) {
    const domains = events
      .map(e => e.domain)
      .filter(Boolean);
    return new Set(domains).size;
  }

  /**
   * Returns ms spent on the current domain since entry.
   * @param {number} now
   * @returns {number}
   */
  #timeOnCurrentDomain(now) {
    if (!this.#currentDomain) return 0;
    return now - this.#domainEntryTime;
  }

  /**
   * Get the most recent idle state from the buffer.
   * @returns {'active'|'idle'|'locked'}
   */
  #latestIdleState() {
    for (let i = this.#eventBuffer.length - 1; i >= 0; i--) {
      const e = this.#eventBuffer[i];
      if (e.idleState) return e.idleState;
    }
    return 'active';
  }

  /**
   * Accumulate time-on-domain whenever domain changes.
   * @param {ActivityEvent} event
   */
  #updateDomainTime(event) {
    const now = event.timestamp;

    if (
      this.#currentDomain &&
      event.domain !== this.#currentDomain
    ) {
      const spent = now - this.#domainEntryTime;
      const prev = this.#domainTimeMap.get(this.#currentDomain) ?? 0;
      this.#domainTimeMap.set(this.#currentDomain, prev + spent);
    }

    if (event.domain && event.domain !== this.#currentDomain) {
      this.#currentDomain = event.domain;
      this.#domainEntryTime = now;
    }
  }

  /**
   * Focus score: 0 (distracted) → 1 (deeply focused).
   * Formula: penalize high switch rate and short domain dwell time.
   * @param {ActivityEvent[]} window60
   * @param {number} now
   * @returns {number}
   */
  #computeFocusScore(window60, now) {
    const switchRate  = this.#countByType(window60, 'TAB_SWITCH');
    const dwellMs     = this.#timeOnCurrentDomain(now);
    const idle        = this.#latestIdleState();

    if (idle !== 'active') return 0;

    // Switch penalty: 0 switches = 1.0, 10+ switches = 0.0
    const switchPenalty = Math.max(0, 1 - switchRate / 10);

    // Dwell bonus: 0ms = 0.0, 5min+ = 1.0
    const dwellBonus = Math.min(1, dwellMs / 300_000);

    // Weighted average
    return Math.round((switchPenalty * 0.6 + dwellBonus * 0.4) * 100) / 100;
  }

  /**
   * Categorize a domain into a productivity bucket.
   * Extend this map as needed.
   * @param {string|null} domain
   * @returns {DomainCategory}
   */
  #categorizeDomain(domain) {
    if (!domain) return 'unknown';

    const categories = {
      productivity: [
        'github.com', 'gitlab.com', 'notion.so', 'linear.app',
        'jira.atlassian.com', 'figma.com', 'docs.google.com',
        'sheets.google.com', 'airtable.com', 'asana.com',
      ],
      communication: [
        'mail.google.com', 'outlook.live.com', 'slack.com',
        'teams.microsoft.com', 'discord.com', 'zoom.us',
      ],
      reference: [
        'stackoverflow.com', 'developer.mozilla.org', 'npmjs.com',
        'docs.anthropic.com', 'wikipedia.org',
      ],
      distraction: [
        'youtube.com', 'twitter.com', 'x.com', 'reddit.com',
        'instagram.com', 'tiktok.com', 'facebook.com',
      ],
    };

    for (const [category, domains] of Object.entries(categories)) {
      if (domains.some(d => domain.endsWith(d))) return category;
    }

    return 'neutral';
  }
}