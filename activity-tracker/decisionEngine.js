/**
 * DecisionEngine
 * Maps context + priority to SHOW / DELAY / SUPPRESS with an explainable queue.
 */
export class DecisionEngine {
  #queue = [];
  #queueLimit = 80;

  decide(notification, context) {
    const priority = this.#scorePriority(notification);
    const action = this.#applyRules(priority, context.state);
    const reason = this.#buildReason(action, priority, context);

    if (action === 'DELAY' || action === 'SUPPRESS') {
      this.#enqueue(notification, priority, action, context, reason);
    }

    return {
      action,
      priority,
      notification,
      contextState: context.state,
      reason,
      queueDepth: this.#queue.length,
      decidedAt: Date.now(),
    };
  }

  flushQueue() {
    const now = Date.now();
    const flushed = this.#queue.map((item) => ({
      ...item,
      delayedMs: Math.max(0, now - item.queuedAt),
    }));
    this.#queue = [];
    return flushed;
  }

  getQueue() {
    return [...this.#queue];
  }

  getQueueDepth() {
    return this.#queue.length;
  }

  reset() {
    this.#queue = [];
  }

  #scorePriority(n) {
    const explicitPriority = String(n?.priority ?? '')
      .toUpperCase()
      .trim();
    if (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(explicitPriority)) {
      return explicitPriority;
    }

    const title = (n.title ?? '').toLowerCase();
    const body = (n.body ?? '').toLowerCase();
    const source = (n.source ?? '').toLowerCase();
    const text = `${title} ${body}`;

    const criticalKeywords = [
      'urgent',
      'critical',
      'alert',
      'security',
      'breach',
      'outage',
      'incident',
      'emergency',
    ];
    if (criticalKeywords.some((k) => text.includes(k))) return 'CRITICAL';

    const criticalSources = ['pagerduty', 'opsgenie', 'grafana', 'sentry'];
    if (criticalSources.some((s) => source.includes(s))) return 'CRITICAL';

    const highKeywords = [
      'meeting in',
      'starting in',
      'reminder',
      'mentioned you',
      'assigned to you',
      'direct message',
    ];
    if (highKeywords.some((k) => text.includes(k))) return 'HIGH';

    const highSources = ['calendar', 'gmail', 'outlook', 'teams', 'slack'];
    if (highSources.some((s) => source.includes(s))) return 'HIGH';

    const lowKeywords = ['newsletter', 'unsubscribe', 'sale', 'offer', 'liked your'];
    if (lowKeywords.some((k) => text.includes(k))) return 'LOW';

    const lowSources = ['twitter', 'x', 'instagram', 'youtube', 'reddit'];
    if (lowSources.some((s) => source.includes(s))) return 'LOW';

    return 'MEDIUM';
  }

  #applyRules(priority, state) {
    const normalizedState = this.#normalizeState(state);

    const matrix = {
      CRITICAL: {
        active_focus: 'SHOW',
        passive_focus: 'SHOW',
        distracted: 'SHOW',
        idle: 'DELAY',
        transitioning: 'SHOW',
      },
      HIGH: {
        active_focus: 'DELAY',
        passive_focus: 'SHOW',
        distracted: 'SHOW',
        idle: 'DELAY',
        transitioning: 'SHOW',
      },
      MEDIUM: {
        active_focus: 'DELAY',
        passive_focus: 'SHOW',
        distracted: 'SHOW',
        idle: 'DELAY',
        transitioning: 'SHOW',
      },
      LOW: {
        active_focus: 'DELAY',
        passive_focus: 'DELAY',
        distracted: 'SHOW',
        idle: 'DELAY',
        transitioning: 'SHOW',
      },
    };

    return matrix[priority]?.[normalizedState] ?? 'DELAY';
  }

  #normalizeState(state) {
    if (state === 'deep_focus' || state === 'focused') return 'active_focus';
    if (state === 'in_meeting') return 'passive_focus';
    return state;
  }

  #enqueue(notification, priority, action, context, reason) {
    if (this.#queue.length >= this.#queueLimit) {
      const oldestLow = this.#queue.findIndex((item) => item.priority === 'LOW');
      if (oldestLow >= 0) {
        this.#queue.splice(oldestLow, 1);
      } else {
        this.#queue.shift();
      }
    }

    this.#queue.push({
      notification,
      priority,
      action,
      contextStateAtQueue: context.state,
      queuedDomain: context.currentDomain ?? null,
      queuedAt: Date.now(),
      explain: {
        reason,
        state: context.state,
        domain: context.currentDomain ?? null,
        modifiers: Array.isArray(context.modifiers) ? context.modifiers : [],
      },
    });
  }

  #buildReason(action, priority, context) {
    const domainLabel = context.currentDomain ? ` on ${context.currentDomain}` : '';

    if (action === 'SHOW') {
      return `${priority} priority delivered during ${context.state}${domainLabel}.`;
    }

    if (action === 'DELAY') {
      return `${priority} priority delayed during ${context.state}${domainLabel}. It will flush when focus breaks.`;
    }

    return `${priority} priority suppressed during ${context.state}${domainLabel}.`;
  }
}
