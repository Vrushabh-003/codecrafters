/**
 * FeatureExtractor
 * Combines tracker events and content-script telemetry summaries into one
 * engagement feature vector for context classification.
 */
export class FeatureExtractor {
  #eventBuffer = [];
  #telemetryBuffer = [];
  #bufferLimit = 300;
  #domainTimeMap = new Map();
  #currentDomain = null;
  #domainEntryTime = Date.now();
  #playlistActiveUntil = 0;

  ingest(event) {
    if (!event || typeof event !== 'object') return;

    this.#eventBuffer.push(event);
    if (this.#eventBuffer.length > this.#bufferLimit) {
      this.#eventBuffer.shift();
    }

    this.#updateDomainFromEvent(event);
  }

  ingestTelemetry(summary) {
    if (!summary || typeof summary !== 'object') return;

    const now = Date.now();
    const timestamp = Number(summary.sentAt) || now;
    const windowMs = Math.max(1_000, Number(summary.windowMs) || 10_000);
    const interactionCount = Math.max(0, Number(summary.interactionCount) || 0);
    const host = summary.host || null;
    const visible = Boolean(summary.visible);
    const playlist = Boolean(summary?.urlHints?.playlist);

    this.#telemetryBuffer.push({
      timestamp,
      windowMs,
      interactionCount,
      visible,
      host,
      breakdown: {
        mousemove: Number(summary?.breakdown?.mousemove) || 0,
        scroll: Number(summary?.breakdown?.scroll) || 0,
        keydown: Number(summary?.breakdown?.keydown) || 0,
        click: Number(summary?.breakdown?.click) || 0,
      },
      urlHints: {
        playlist,
      },
    });

    if (this.#telemetryBuffer.length > this.#bufferLimit) {
      this.#telemetryBuffer.shift();
    }

    if (playlist) {
      this.#playlistActiveUntil = Math.max(this.#playlistActiveUntil, timestamp + 300_000);
    }

    if (host && host !== this.#currentDomain) {
      this.#switchDomain(host, timestamp);
    }
  }

  extract() {
    const now = Date.now();
    const window60 = this.#eventsInWindow(60_000);
    const window300 = this.#eventsInWindow(300_000);

    const telemetry60 = this.#telemetryInWindow(60_000).filter((t) => t.visible);
    const telemetry300 = this.#telemetryInWindow(300_000).filter((t) => t.visible);

    const interactionCount1m = this.#sumInteractions(telemetry60);
    const interactionCount5m = this.#sumInteractions(telemetry300);
    const telemetryWindow1mMs = this.#sumTelemetryWindowMs(telemetry60);
    const telemetryWindow5mMs = this.#sumTelemetryWindowMs(telemetry300);

    const timeOnCurrentDomainMs = this.#timeOnCurrentDomain(now);
    const interactionDensity = this.#densityPerMinute(interactionCount1m, telemetryWindow1mMs);
    const interactionToDwellRatio = this.#ratioPerSecond(interactionCount5m, timeOnCurrentDomainMs);

    return {
      tabSwitchRate1m: this.#countByType(window60, 'TAB_SWITCH'),
      tabSwitchRate5m: this.#countByType(window300, 'TAB_SWITCH'),
      uniqueDomainsVisited: this.#uniqueDomains(window300),
      timeOnCurrentDomainMs,
      isIdle: this.#latestIdleState() !== 'active',
      idleStateCurrent: this.#latestIdleState(),
      idleEventsLast5m: this.#countByType(window300, 'IDLE'),
      currentDomain: this.#currentDomain,
      currentDomainCategory: this.#categorizeDomain(this.#currentDomain),
      focusScore: this.#computeFocusScore({
        switchRate: this.#countByType(window60, 'TAB_SWITCH'),
        dwellMs: timeOnCurrentDomainMs,
        interactionDensity,
      }),
      interactionCount1m,
      interactionCount5m,
      interactionDensity,
      interactionToDwellRatio,
      telemetryWindow1mMs,
      telemetryWindow5mMs,
      inputModalityMix: this.#modalityMix(telemetry300),
      playlistActive: now < this.#playlistActiveUntil,
      bufferSize: this.#eventBuffer.length,
      telemetryBufferSize: this.#telemetryBuffer.length,
      extractedAt: now,
    };
  }

  reset() {
    this.#eventBuffer = [];
    this.#telemetryBuffer = [];
    this.#domainTimeMap.clear();
    this.#currentDomain = null;
    this.#domainEntryTime = Date.now();
    this.#playlistActiveUntil = 0;
  }

  getDomainTimeSnapshot() {
    return Object.fromEntries(this.#domainTimeMap);
  }

  #eventsInWindow(windowMs) {
    const cutoff = Date.now() - windowMs;
    return this.#eventBuffer.filter((e) => e.timestamp >= cutoff);
  }

  #telemetryInWindow(windowMs) {
    const cutoff = Date.now() - windowMs;
    return this.#telemetryBuffer.filter((t) => t.timestamp >= cutoff);
  }

  #countByType(events, type) {
    return events.filter((e) => e.type === type).length;
  }

  #uniqueDomains(events) {
    const domains = events.map((e) => e.domain).filter(Boolean);
    return new Set(domains).size;
  }

  #sumInteractions(telemetryEvents) {
    return telemetryEvents.reduce((sum, t) => sum + t.interactionCount, 0);
  }

  #sumTelemetryWindowMs(telemetryEvents) {
    return telemetryEvents.reduce((sum, t) => sum + t.windowMs, 0);
  }

  #densityPerMinute(interactions, windowMs) {
    if (windowMs <= 0) return 0;
    const perMinute = interactions / (windowMs / 60_000);
    return Math.round(perMinute * 100) / 100;
  }

  #ratioPerSecond(interactions, dwellMs) {
    if (dwellMs <= 0) return 0;
    const perSecond = interactions / (dwellMs / 1_000);
    return Math.round(perSecond * 1000) / 1000;
  }

  #modalityMix(telemetryEvents) {
    const totals = telemetryEvents.reduce(
      (acc, t) => {
        acc.mousemove += t.breakdown.mousemove;
        acc.scroll += t.breakdown.scroll;
        acc.keydown += t.breakdown.keydown;
        acc.click += t.breakdown.click;
        return acc;
      },
      { mousemove: 0, scroll: 0, keydown: 0, click: 0 }
    );

    const total =
      totals.mousemove + totals.scroll + totals.keydown + totals.click;

    if (total === 0) {
      return { mousemove: 0, scroll: 0, keydown: 0, click: 0 };
    }

    return {
      mousemove: Math.round((totals.mousemove / total) * 100) / 100,
      scroll: Math.round((totals.scroll / total) * 100) / 100,
      keydown: Math.round((totals.keydown / total) * 100) / 100,
      click: Math.round((totals.click / total) * 100) / 100,
    };
  }

  #timeOnCurrentDomain(now) {
    if (!this.#currentDomain) return 0;
    return now - this.#domainEntryTime;
  }

  #latestIdleState() {
    for (let i = this.#eventBuffer.length - 1; i >= 0; i -= 1) {
      const e = this.#eventBuffer[i];
      if (e.idleState) return e.idleState;
    }
    return 'active';
  }

  #updateDomainFromEvent(event) {
    if (!event?.domain) return;
    this.#switchDomain(event.domain, event.timestamp || Date.now());
  }

  #switchDomain(nextDomain, atTs) {
    if (this.#currentDomain && this.#currentDomain !== nextDomain) {
      const spent = Math.max(0, atTs - this.#domainEntryTime);
      const prev = this.#domainTimeMap.get(this.#currentDomain) ?? 0;
      this.#domainTimeMap.set(this.#currentDomain, prev + spent);
    }

    if (nextDomain !== this.#currentDomain) {
      this.#currentDomain = nextDomain;
      this.#domainEntryTime = atTs;
    }
  }

  #computeFocusScore({ switchRate, dwellMs, interactionDensity }) {
    if (this.#latestIdleState() !== 'active') return 0;

    const switchPenalty = Math.max(0, 1 - switchRate / 10);
    const dwellBonus = Math.min(1, dwellMs / 300_000);
    const interactionBonus = Math.min(1, interactionDensity / 40);

    return Math.round(
      (switchPenalty * 0.45 + dwellBonus * 0.25 + interactionBonus * 0.3) * 100
    ) / 100;
  }

  #categorizeDomain(domain) {
    if (!domain) return 'unknown';

    const categories = {
      productivity: [
        'github.com',
        'gitlab.com',
        'notion.so',
        'linear.app',
        'docs.google.com',
        'stackoverflow.com',
      ],
      communication: [
        'mail.google.com',
        'outlook.live.com',
        'slack.com',
        'teams.microsoft.com',
        'discord.com',
      ],
      media: ['youtube.com', 'netflix.com', 'primevideo.com', 'spotify.com'],
      social: ['reddit.com', 'x.com', 'twitter.com', 'instagram.com'],
    };

    for (const [category, domains] of Object.entries(categories)) {
      if (domains.some((d) => domain.endsWith(d))) return category;
    }

    return 'neutral';
  }
}
