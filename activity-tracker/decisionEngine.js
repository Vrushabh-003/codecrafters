/**
 * DecisionEngine
 * Takes a ContextState + incoming notification and decides:
 *   SHOW      — deliver immediately
 *   DELAY     — queue, deliver at next focus break
 *   SUPPRESS  — drop silently (digest only)
 *
 * Priority levels (set by sender/topic rules):
 *   CRITICAL  — always show (alerts, security, calendar imminent)
 *   HIGH      — show unless deep focus
 *   MEDIUM    — delay if focused, suppress if deep focus
 *   LOW       — suppress unless idle
 */
export class DecisionEngine {
  /** @type {QueuedNotification[]} */
  #queue = [];

  /** @type {number} max notifications to hold in queue */
  #queueLimit = 50;

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────

  /**
   * Core decision method.
   * @param {IncomingNotification} notification
   * @param {ContextState} context
   * @returns {Decision}
   */
  decide(notification, context) {
    const priority = this.#scorePriority(notification);
    const action   = this.#applyRules(priority, context.state);

    if (action === 'DELAY' || action === 'SUPPRESS') {
      this.#enqueue(notification, priority, action, context.state);
    }

    return {
      action,
      priority,
      notification,
      contextState:  context.state,
      reason:        this.#buildReason(action, priority, context.state),
      decidedAt:     Date.now(),
    };
  }

  /**
   * Returns all queued notifications and clears the queue.
   * Call this when context transitions to 'idle' or 'transitioning'
   * to flush the digest.
   * @returns {QueuedNotification[]}
   */
  flushQueue() {
    const flushed = [...this.#queue];
    this.#queue   = [];
    return flushed;
  }

  /**
   * Peek at queue without clearing.
   * @returns {QueuedNotification[]}
   */
  getQueue() {
    return [...this.#queue];
  }

  /**
   * How many notifications are currently queued.
   * @returns {number}
   */
  getQueueDepth() {
    return this.#queue.length;
  }

  reset() {
    this.#queue = [];
  }

  // ─────────────────────────────────────────────
  // PRIVATE — PRIORITY SCORING
  // ─────────────────────────────────────────────

  /**
   * Score incoming notification as CRITICAL / HIGH / MEDIUM / LOW.
   * Extend sender rules and keyword rules here over time.
   * @param {IncomingNotification} n
   * @returns {Priority}
   */
  #scorePriority(n) {
    const title  = (n.title  ?? '').toLowerCase();
    const body   = (n.body   ?? '').toLowerCase();
    const source = (n.source ?? '').toLowerCase();
    const text   = `${title} ${body}`;

    // CRITICAL keywords — always break through
    const criticalKeywords = [
      'urgent', 'critical', 'alert', 'security',
      'password', 'breach', 'down', 'outage', 'emergency',
    ];
    if (criticalKeywords.some(k => text.includes(k))) return 'CRITICAL';

    // CRITICAL sources
    const criticalSources = ['pagerduty', 'opsgenie', 'grafana', 'sentry'];
    if (criticalSources.some(s => source.includes(s)))  return 'CRITICAL';

    // HIGH — calendar, direct mentions, DMs
    const highKeywords = [
      'meeting in', 'starting in', 'reminder',
      'mentioned you', 'assigned to you', 'direct message',
    ];
    if (highKeywords.some(k => text.includes(k)))        return 'HIGH';

    const highSources = ['calendar', 'gmail', 'zoom', 'teams'];
    if (highSources.some(s => source.includes(s)))       return 'HIGH';

    // LOW — social, marketing, newsletters
    const lowKeywords = [
      'newsletter', 'unsubscribe', 'sale', 'offer',
      'liked your', 'retweeted', 'followed you',
    ];
    if (lowKeywords.some(k => text.includes(k)))         return 'LOW';

    const lowSources = ['twitter', 'instagram', 'reddit', 'youtube'];
    if (lowSources.some(s => source.includes(s)))        return 'LOW';

    // Default
    return 'MEDIUM';
  }

  // ─────────────────────────────────────────────
  // PRIVATE — DECISION RULES
  // ─────────────────────────────────────────────

  /**
   * The core rule matrix.
   *
   *                  | deep_focus | focused | distracted | idle | in_meeting | transitioning
   * CRITICAL         | SHOW       | SHOW    | SHOW       | SHOW | SHOW       | SHOW
   * HIGH             | DELAY      | SHOW    | SHOW       | SHOW | DELAY      | SHOW
   * MEDIUM           | SUPPRESS   | DELAY   | SHOW       | SHOW | SUPPRESS   | DELAY
   * LOW              | SUPPRESS   | SUPPRESS| DELAY      | SHOW | SUPPRESS   | SUPPRESS
   *
   * @param {Priority}   priority
   * @param {FocusState} state
   * @returns {'SHOW'|'DELAY'|'SUPPRESS'}
   */
  #applyRules(priority, state) {
    const matrix = {
      CRITICAL: {
        deep_focus:     'SHOW',
        focused:        'SHOW',
        distracted:     'SHOW',
        idle:           'SHOW',
        in_meeting:     'SHOW',
        transitioning:  'SHOW',
      },
      HIGH: {
        deep_focus:     'DELAY',
        focused:        'SHOW',
        distracted:     'SHOW',
        idle:           'SHOW',
        in_meeting:     'DELAY',
        transitioning:  'SHOW',
      },
      MEDIUM: {
        deep_focus:     'SUPPRESS',
        focused:        'DELAY',
        distracted:     'SHOW',
        idle:           'SHOW',
        in_meeting:     'SUPPRESS',
        transitioning:  'DELAY',
      },
      LOW: {
        deep_focus:     'SUPPRESS',
        focused:        'SUPPRESS',
        distracted:     'DELAY',
        idle:           'SHOW',
        in_meeting:     'SUPPRESS',
        transitioning:  'SUPPRESS',
      },
    };

    return matrix[priority]?.[state] ?? 'DELAY';
  }

  // ─────────────────────────────────────────────
  // PRIVATE — QUEUE
  // ─────────────────────────────────────────────

  /**
   * Add notification to queue. Drops oldest if limit exceeded.
   * CRITICAL notifications skip the queue and are never suppressed.
   */
  #enqueue(notification, priority, action, state) {
    if (this.#queue.length >= this.#queueLimit) {
      // Drop oldest LOW priority item first, then oldest overall
      const oldestLow = this.#queue.findIndex(q => q.priority === 'LOW');
      if (oldestLow !== -1) {
        this.#queue.splice(oldestLow, 1);
      } else {
        this.#queue.shift();
      }
    }

    this.#queue.push({
      notification,
      priority,
      action,
      contextStateAtQueue: state,
      queuedAt:            Date.now(),
    });
  }

  /**
   * Human-readable reason string — useful for the analytics dashboard.
   */
  #buildReason(action, priority, state) {
    const reasons = {
      SHOW:     `${priority} priority — delivered immediately during ${state}`,
      DELAY:    `${priority} priority — queued during ${state}, will deliver at next break`,
      SUPPRESS: `${priority} priority — suppressed during ${state}, added to digest`,
    };
    return reasons[action] ?? 'Unknown decision';
  }
}