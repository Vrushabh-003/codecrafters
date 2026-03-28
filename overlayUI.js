(() => {
  const ROOT_ID = 'context-notif-overlay-root';
  const STYLE_ID = 'context-notif-overlay-style';

  let root = null;
  let stack = null;
  let digest = null;

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
        gap: 12px;
        width: min(360px, calc(100vw - 24px));
        pointer-events: none;
        font-family: "Segoe UI", Tahoma, sans-serif;
      }

      #${ROOT_ID} .cn-card {
        pointer-events: auto;
        color: #f8fafc;
        background: linear-gradient(160deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.92));
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 16px;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.24);
        padding: 14px 16px;
        backdrop-filter: blur(16px);
        animation: cn-slide-in 180ms ease-out;
      }

      #${ROOT_ID} .cn-label {
        display: inline-flex;
        align-items: center;
        margin-bottom: 8px;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(59, 130, 246, 0.18);
        color: #93c5fd;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      #${ROOT_ID} .cn-title {
        margin: 0 0 6px;
        font-size: 15px;
        font-weight: 700;
        line-height: 1.3;
      }

      #${ROOT_ID} .cn-body {
        margin: 0;
        color: #cbd5e1;
        font-size: 13px;
        line-height: 1.45;
      }

      #${ROOT_ID} .cn-meta {
        margin-top: 10px;
        color: #94a3b8;
        font-size: 11px;
      }

      #${ROOT_ID} .cn-digest-list {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 8px;
      }

      #${ROOT_ID} .cn-digest-item {
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.38);
        border: 1px solid rgba(148, 163, 184, 0.14);
      }

      #${ROOT_ID} .cn-dismiss {
        margin-top: 12px;
        border: 0;
        border-radius: 10px;
        background: #38bdf8;
        color: #082f49;
        padding: 8px 10px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
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

    root.append(stack, digest);
    document.documentElement.appendChild(root);
    return root;
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

    const card = document.createElement('section');
    card.className = 'cn-card';
    card.innerHTML = `
      <div class="cn-label">${decision.priority ?? 'MEDIUM'} notification</div>
      <h3 class="cn-title"></h3>
      <p class="cn-body"></p>
      <div class="cn-meta"></div>
    `;

    card.querySelector('.cn-title').textContent = notification.title ?? 'Untitled notification';
    card.querySelector('.cn-body').textContent = notification.body ?? '';
    card.querySelector('.cn-meta').textContent =
      `${notification.source ?? 'unknown'} • ${formatTime(payload.deliveredAt ?? Date.now())}`;

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
    body.textContent = 'Saved while you were busy. Review them here.';

    const list = document.createElement('ul');
    list.className = 'cn-digest-list';

    for (const item of items) {
      const entry = document.createElement('li');
      entry.className = 'cn-digest-item';
      const notification = item.notification ?? {};
      entry.innerHTML = `
        <strong>${notification.title ?? 'Untitled notification'}</strong>
        <div>${notification.body ?? ''}</div>
      `;
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
    if (message?.type === 'OVERLAY_NOTIFICATION') {
      showNotification(message);
    }

    if (message?.type === 'OVERLAY_DIGEST') {
      showDigest(message);
    }
  });
})();
