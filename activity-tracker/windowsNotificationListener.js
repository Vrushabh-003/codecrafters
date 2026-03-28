import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_LOG_NAME = 'Microsoft-Windows-PushNotification-Platform/Operational';

export class WindowsNotificationListener {
  constructor({
    logName = DEFAULT_LOG_NAME,
    pollIntervalMs = 3000,
    maxEvents = 120,
    onNotification = null,
    onError = null,
  } = {}) {
    this.logName = logName;
    this.pollIntervalMs = pollIntervalMs;
    this.maxEvents = maxEvents;
    this.onNotification =
      typeof onNotification === 'function' ? onNotification : null;
    this.onError = typeof onError === 'function' ? onError : null;

    this.lastRecordId = 0;
    this.timer = null;
    this.started = false;
    this.seenTrackingKeys = new Map();
  }

  async start() {
    if (process.platform !== 'win32') {
      throw new Error('WindowsNotificationListener supports Windows only.');
    }
    if (this.started) return;

    this.started = true;
    await this.seedLastRecordId();
    await this.poll();

    this.timer = setInterval(() => {
      this.poll().catch((error) => this.handleError(error));
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  async seedLastRecordId() {
    const command = `
$e = Get-WinEvent -LogName '${this.logName}' -MaxEvents 1 -ErrorAction SilentlyContinue;
if ($null -eq $e) { '' } else { "$($e.RecordId)" }
`;
    const output = await this.runPowerShell(command);
    const value = Number(output.trim());
    this.lastRecordId = Number.isFinite(value) ? value : 0;
  }

  async poll() {
    const command = `
$events = Get-WinEvent -LogName '${this.logName}' -MaxEvents ${this.maxEvents} -ErrorAction SilentlyContinue |
  Select-Object RecordId, TimeCreated, Id, ProviderName, Message;
if ($null -eq $events) { '[]' } else { $events | ConvertTo-Json -Compress }
`;
    const output = await this.runPowerShell(command);
    const events = this.parseEvents(output);
    if (events.length === 0) return;

    events.sort((a, b) => Number(a.RecordId) - Number(b.RecordId));

    for (const event of events) {
      const recordId = Number(event.RecordId);
      if (!Number.isFinite(recordId) || recordId <= this.lastRecordId) continue;
      this.lastRecordId = recordId;
      this.processEvent(event);
    }
  }

  processEvent(event) {
    const message = String(event.Message ?? '');
    if (!this.isToastEvent(event, message)) return;

    const sourceRaw = this.extractSourceRaw(message) ?? event.ProviderName ?? 'Windows';
    const source = this.normalizeSource(sourceRaw);
    const trackingId = this.extractTrackingId(message) ?? `rec-${event.RecordId}`;
    const dedupeKey = `${sourceRaw}|${trackingId}`;

    const now = Date.now();
    const prior = this.seenTrackingKeys.get(dedupeKey);
    if (prior && now - prior < 90_000) return;
    this.seenTrackingKeys.set(dedupeKey, now);
    this.pruneSeenMap(now);

    const createdAt = event.TimeCreated ? new Date(event.TimeCreated).getTime() : now;

    this.onNotification?.({
      id: `win-${event.RecordId}`,
      title: `${source} notification`,
      body: 'Incoming Windows toast detected by AIS bridge.',
      source,
      priority: this.inferPriority(source, message),
      createdAt: Number.isFinite(createdAt) ? createdAt : now,
      metadata: {
        channel: 'windows_event_log',
        logName: this.logName,
        recordId: Number(event.RecordId) || null,
        eventId: Number(event.Id) || null,
        trackingId,
        sourceRaw,
      },
    });
  }

  isToastEvent(event, message) {
    const msg = message.toLowerCase();
    if (!msg.includes('toast')) return false;

    const eventId = Number(event.Id);
    if ([3153, 3052, 2418].includes(eventId)) return true;

    if (msg.includes('is delivered to')) return true;
    if (msg.includes('being delivered to')) return true;
    if (msg.includes('submitted to threadpool')) return true;

    return false;
  }

  extractTrackingId(message) {
    const pattern1 = /tracking id\s+(\d+)/i;
    const match1 = message.match(pattern1);
    if (match1?.[1]) return match1[1];

    const pattern2 = /\[notificationtype\]\s+(\d+)/i;
    const match2 = message.match(pattern2);
    if (match2?.[1]) return match2[1];

    return null;
  }

  extractSourceRaw(message) {
    const bracketed = /\[AppUserModelId\]\s+([^\s]+)\s+\[NotificationType\]/i;
    const m1 = message.match(bracketed);
    if (m1?.[1]) return m1[1];

    const delivered = /\s+to\s+([^\s]+)\s+on session/i;
    const m2 = message.match(delivered);
    if (m2?.[1]) return m2[1];

    return null;
  }

  normalizeSource(sourceRaw) {
    if (!sourceRaw) return 'Windows';

    const noBang = sourceRaw.split('!')[0];
    const postPublisher = noBang.includes('.')
      ? noBang.split('.').slice(1).join('.')
      : noBang;
    const candidate = postPublisher.split('_')[0];
    return candidate || sourceRaw;
  }

  inferPriority(source, message) {
    const src = String(source).toLowerCase();
    const text = String(message).toLowerCase();

    if (src.includes('teams') || src.includes('outlook') || src.includes('mail')) {
      return 'HIGH';
    }
    if (text.includes('security') || text.includes('critical') || text.includes('alert')) {
      return 'CRITICAL';
    }
    return 'MEDIUM';
  }

  parseEvents(rawJson) {
    const trimmed = String(rawJson ?? '').trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch (error) {
      this.handleError(new Error(`Failed to parse Windows event JSON: ${error.message}`));
    }
    return [];
  }

  async runPowerShell(command) {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 4 }
    );
    return String(stdout ?? '');
  }

  pruneSeenMap(now) {
    for (const [key, ts] of this.seenTrackingKeys.entries()) {
      if (now - ts > 5 * 60_000) {
        this.seenTrackingKeys.delete(key);
      }
    }
  }

  handleError(error) {
    this.onError?.(error);
  }
}

export { DEFAULT_LOG_NAME };
