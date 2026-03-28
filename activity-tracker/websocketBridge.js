export class WebSocketBridge {
  #url;
  #ws = null;
  #onMessage = null;
  #onOpen = null;
  #onClose = null;
  #onError = null;
  #reconnectDelayMs = 1_000;
  #maxReconnectDelayMs = 15_000;
  #reconnectTimer = null;
  #destroyed = false;
  #outbox = [];
  #outboxLimit = 100;

  constructor({ url, onMessage, onOpen, onClose, onError }) {
    this.#url = url;
    this.#onMessage = typeof onMessage === 'function' ? onMessage : null;
    this.#onOpen = typeof onOpen === 'function' ? onOpen : null;
    this.#onClose = typeof onClose === 'function' ? onClose : null;
    this.#onError = typeof onError === 'function' ? onError : null;
  }

  connect() {
    if (this.#destroyed) return;
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.#ws = new WebSocket(this.#url);
    } catch (error) {
      this.#scheduleReconnect();
      this.#onError?.(error);
      return;
    }

    this.#ws.onopen = () => {
      this.#reconnectDelayMs = 1_000;
      this.#onOpen?.();
      this.#flushOutbox();
    };

    this.#ws.onmessage = (event) => {
      const payload = this.#parseMessage(event?.data);
      if (!payload) return;
      this.#onMessage?.(payload);
    };

    this.#ws.onerror = (error) => {
      this.#onError?.(error);
    };

    this.#ws.onclose = () => {
      this.#onClose?.();
      this.#scheduleReconnect();
    };
  }

  send(data) {
    const serialized = this.#serialize(data);
    if (!serialized) return false;

    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(serialized);
      return true;
    }

    this.#enqueue(serialized);
    this.connect();
    return false;
  }

  destroy() {
    this.#destroyed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }

    if (this.#ws) {
      this.#ws.onopen = null;
      this.#ws.onmessage = null;
      this.#ws.onerror = null;
      this.#ws.onclose = null;
      this.#ws.close();
      this.#ws = null;
    }
  }

  isConnected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  #scheduleReconnect() {
    if (this.#destroyed) return;
    if (this.#reconnectTimer) return;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, this.#reconnectDelayMs);

    this.#reconnectDelayMs = Math.min(
      this.#reconnectDelayMs * 2,
      this.#maxReconnectDelayMs
    );
  }

  #serialize(data) {
    try {
      return JSON.stringify(data);
    } catch (error) {
      this.#onError?.(error);
      return null;
    }
  }

  #parseMessage(raw) {
    if (!raw) return null;

    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return { type: 'RAW_TEXT', data: raw };
      }
    }

    return null;
  }

  #enqueue(serialized) {
    if (this.#outbox.length >= this.#outboxLimit) {
      this.#outbox.shift();
    }
    this.#outbox.push(serialized);
  }

  #flushOutbox() {
    if (!this.isConnected()) return;

    while (this.#outbox.length > 0) {
      const item = this.#outbox.shift();
      if (!item) continue;
      this.#ws.send(item);
    }
  }
}
