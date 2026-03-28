(() => {
  const ROOT_ID = 'context-notif-overlay-root';
  const STYLE_ID = 'context-notif-overlay-style';

  let root = null;
  let stack = null;
  let digest = null;
  let debugBadge = null;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: min(360px, calc(100vw - 24px));
        pointer-events: none;
        font-family: "Segoe UI", Tahoma, sans-serif;
      }

      #${ROOT_ID} .cn-card {
        pointer-events: auto;
        color: #f8fafc;
        background: linear-gradient(160deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.92));
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 14px;
        box-shadow: 0 14px 32px rgba(15, 23, 42, 0.22);
        padding: 12px 14px;
        backdrop-filter: blur(16px);
        animation: cn-slide-in 180ms ease-out;
      }

      #${ROOT_ID} .cn-label {
        display: inline-flex;
        align-items: center;
        margin-bottom: 6px;
        padding: 4px 7px;
        border-radius: 999px;
        background: rgba(59, 130, 246, 0.18);
        color: #93c5fd;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      #${ROOT_ID} .cn-title {
        margin: 0 0 6px;
        font-size: 14px;
        font-weight: 700;
        line-height: 1.3;
      }

      #${ROOT_ID} .cn-body {
        margin: 0;
        color: #cbd5e1;
        font-size: 12px;
        line-height: 1.45;
      }

      #${ROOT_ID} .cn-meta {
        margin-top: 8px;
        color: #94a3b8;
        font-size: 10px;
      }

      #${ROOT_ID} .cn-digest-list {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 6px;
      }

      #${ROOT_ID} .cn-digest-list.is-scrollable {
        max-height: 220px;
        overflow-y: auto;
        padding-right: 4px;
      }

      #${ROOT_ID} .cn-digest-item {
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(15, 23, 42, 0.38);
        border: 1px solid rgba(148, 163, 184, 0.14);
      }

      #${ROOT_ID} .cn-digest-line {
        display: block;
        color: #e2e8f0;
        font-size: 12px;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${ROOT_ID} .cn-dismiss {
        margin-top: 12px;
        border: 0;
        border-radius: 10px;
        background: #38bdf8;
        color: #082f49;
        padding: 7px 10px;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }

      #${ROOT_ID} .cn-debug {
        pointer-events: none;
        color: #e2e8f0;
        background: rgba(2, 6, 23, 0.9);
        border: 1px solid rgba(125, 211, 252, 0.45);
        border-radius: 12px;
        box-shadow: 0 10px 24px rgba(2, 6, 23, 0.28);
        padding: 8px 10px;
        font-size: 11px;
        line-height: 1.35;
      }

      #${ROOT_ID} .cn-debug.cn-state-active_focus {
        border-color: rgba(52, 211, 153, 0.7);
      }

      #${ROOT_ID} .cn-debug.cn-state-passive_focus {
        border-color: rgba(96, 165, 250, 0.7);
      }

      #${ROOT_ID} .cn-debug.cn-state-distracted {
        border-color: rgba(251, 113, 133, 0.7);
      }

      #${ROOT_ID} .cn-debug.cn-state-idle {
        border-color: rgba(250, 204, 21, 0.7);
      }

      @keyframes cn-slide-in {
        from {
          transform: translateY(-12px) scale(0.98);
          opacity: 0;
        }
        to {
          transform: translateY(0) scale(1);
          opacity: 1;
        }
      }
    `;

    document.documentElement.appendChild(style);
  }

  function ensureRoot() {
    ensureStyles();
    if (root) return root;

    root = document.createElement('div');
    root.id = ROOT_ID;

    stack = document.createElement('div');
    digest = document.createElement('div');
    debugBadge = document.createElement('section');
    debugBadge.className = 'cn-debug';
    debugBadge.textContent = 'AIS state: waiting for pipeline...';

    root.append(debugBadge, stack, digest);
    document.documentElement.appendChild(root);
    return root;
  }

  function showDebug(message) {
    ensureRoot();

    const contextState = message?.contextState ?? {};
    const vector = message?.vector ?? {};

    const state = contextState.state ?? 'transitioning';
    const domain = contextState.currentDomain ?? vector.currentDomain ?? 'n/a';
    const density = Number(
      vector.interactionDensity ?? contextState.interactionDensity ?? 0
    );
    const switches = Number(vector.tabSwitchRate1m ?? 0);
    const queue = Number.isFinite(message?.queueDepth) ? message.queueDepth : 0;

    const densityLabel = Number.isFinite(density) ? density.toFixed(1) : '0.0';
    debugBadge.className = `cn-debug cn-state-${String(state).replace(/[^a-z0-9_]/gi, '_')}`;
    debugBadge.textContent =
      `AIS ${state} | density ${densityLabel}/min | switch ${switches}/m | queue ${queue} | ${domain}`;
  }

  function compactNotificationLine(notification) {
    const app = normalizeToken(notification.source ?? 'App');
    const sender = normalizeSender(notification);
    return `${app}:${sender}`;
  }

  function normalizeToken(value) {
    return String(value ?? 'App').trim() || 'App';
  }

  function prettifySourceRaw(sourceRaw) {
    const raw = String(sourceRaw ?? '').trim();
    if (!raw) return '';

    const withoutBang = raw.split('!')[0];
    const withoutSuffix = withoutBang.split('_')[0];
    const segment = withoutSuffix.split('.').pop() ?? withoutSuffix;
    return segment.trim();
  }

  function normalizeSender(notification) {
    const app = normalizeToken(notification.source ?? 'App');
    const rawCandidate =
      notification.sender ??
      notification.appName ??
      notification.metadata?.sender ??
      prettifySourceRaw(notification.metadata?.sourceRaw) ??
      notification.title ??
      'Unknown';

    let sender = String(rawCandidate ?? '').trim() || 'Unknown';
    sender = sender.replace(/\s+notification$/i, '').trim();

    if (!sender || sender.toLowerCase() === app.toLowerCase()) {
      return 'notification';
    }

    return sender;
  }

  function shouldHideNotificationBody(notification) {
    const body = String(notification.body ?? '').trim().toLowerCase();
    return (
      !body ||
      body === 'incoming windows toast detected by ais bridge.' ||
      body === 'overlay should appear on the active tab'
    );
  }

  function removeLater(node, ms) {
    window.setTimeout(() => {
      node.remove();
    }, ms);
  }

  function formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function showNotification(payload) {
    ensureRoot();

    const notification = payload.notification ?? {};
    const decision = payload.decision ?? {};
    const compactLine = compactNotificationLine(notification);

    const card = document.createElement('section');
    card.className = 'cn-card';
    card.innerHTML = `
      <div class="cn-label">${decision.priority ?? 'MEDIUM'} notification</div>
      <h3 class="cn-title"></h3>
      <p class="cn-body"></p>
      <div class="cn-meta"></div>
    `;

    card.querySelector('.cn-title').textContent = compactLine;
    card.querySelector('.cn-body').textContent = shouldHideNotificationBody(notification)
      ? ''
      : String(notification.body ?? '');
    card.querySelector('.cn-meta').textContent =
      `${notification.source ?? 'unknown'} • ${formatTime(payload.deliveredAt ?? Date.now())}`;

    if (shouldHideNotificationBody(notification)) {
      card.querySelector('.cn-body').style.display = 'none';
    }

    stack.appendChild(card);
    removeLater(card, 6000);
  }

  function showDigest(payload) {
    ensureRoot();

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length === 0) return;

    digest.innerHTML = '';

    const card = document.createElement('section');
    card.className = 'cn-card';

    const label = document.createElement('div');
    label.className = 'cn-label';
    label.textContent = 'Notification digest';

    const title = document.createElement('h3');
    title.className = 'cn-title';
    title.textContent = `${items.length} queued updates`;

    const body = document.createElement('p');
    body.className = 'cn-body';
    body.textContent = 'Queued while you were busy.';

    const list = document.createElement('ul');
    list.className = 'cn-digest-list';
    if (items.length > 5) {
      list.classList.add('is-scrollable');
    }

    for (const item of items) {
      const entry = document.createElement('li');
      entry.className = 'cn-digest-item';
      const notification = item.notification ?? {};

      const line = document.createElement('span');
      line.className = 'cn-digest-line';
      line.textContent = compactNotificationLine(notification);

      entry.append(line);
      list.appendChild(entry);
    }

    const dismiss = document.createElement('button');
    dismiss.className = 'cn-dismiss';
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      card.remove();
    });

    card.append(label, title, body, list, dismiss);
    digest.appendChild(card);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PIPELINE_UPDATE' || message?.source === 'pipeline') {
      showDebug(message);
    }

    if (message?.type === 'OVERLAY_NOTIFICATION') {
      showNotification(message);
    }

    if (message?.type === 'OVERLAY_DIGEST') {
      showDigest(message);
    }
  });
})();
