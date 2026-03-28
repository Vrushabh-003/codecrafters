(() => {
  const WINDOW_MS = 10_000;
  const MOUSE_THROTTLE_MS = 250;

  let startedAt = Date.now();
  let totalInteractions = 0;
  let lastMouseAt = 0;
  const counters = {
    mousemove: 0,
    scroll: 0,
    keydown: 0,
    click: 0,
  };

  function bump(type) {
    totalInteractions += 1;
    if (Object.hasOwn(counters, type)) {
      counters[type] += 1;
    }
  }

  function onMouseMove() {
    const now = Date.now();
    if (now - lastMouseAt < MOUSE_THROTTLE_MS) return;
    lastMouseAt = now;
    bump('mousemove');
  }

  function onScroll() {
    bump('scroll');
  }

  function onKeydown() {
    bump('keydown');
  }

  function onClick() {
    bump('click');
  }

  function getSafeHints() {
    let playlist = false;
    try {
      const url = new URL(window.location.href);
      playlist = url.searchParams.has('list');
    } catch {
      playlist = false;
    }

    return { playlist };
  }

  function resetCounters() {
    totalInteractions = 0;
    counters.mousemove = 0;
    counters.scroll = 0;
    counters.keydown = 0;
    counters.click = 0;
    startedAt = Date.now();
  }

  function flush(reason = 'interval') {
    const now = Date.now();
    const windowMs = Math.max(1_000, now - startedAt);

    const payload = {
      source: 'telemetryContent',
      type: 'TELEMETRY_SUMMARY',
      telemetry: {
        host: window.location.hostname || null,
        interactionCount: totalInteractions,
        breakdown: { ...counters },
        windowMs,
        visible: !document.hidden,
        urlHints: getSafeHints(),
        sentAt: now,
        reason,
      },
    };

    try {
      const maybePromise = chrome.runtime.sendMessage(payload, () => {
        // Ignore expected cases (no listener / sleeping SW).
        void chrome.runtime.lastError;
      });

      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
          // Ignore when SW is sleeping; the next flush will retry naturally.
        });
      }
    } catch {
      // Ignore runtime unavailability during navigation teardown.
    }

    resetCounters();
  }

  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onKeydown, { passive: true });
  window.addEventListener('click', onClick, { passive: true });
  window.addEventListener('pagehide', () => flush('pagehide'));
  document.addEventListener('visibilitychange', () => {
    flush(document.hidden ? 'hidden' : 'visible');
  });

  setInterval(() => flush('interval'), WINDOW_MS);
})();
