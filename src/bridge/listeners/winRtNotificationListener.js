import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class WinRtNotificationListener {
  constructor({
    pollIntervalMs = 4000,
    onNotification = null,
    onError = null,
  } = {}) {
    this.pollIntervalMs = pollIntervalMs;
    this.onNotification =
      typeof onNotification === 'function' ? onNotification : null;
    this.onError = typeof onError === 'function' ? onError : null;

    this.timer = null;
    this.started = false;
    this.seenKeys = new Map();
  }

  async start() {
    if (process.platform !== 'win32') {
      throw new Error('WinRtNotificationListener supports Windows only.');
    }
    if (this.started) return;

    this.started = true;
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

  async poll() {
    const raw = await this.runPowerShell(this.buildPowerShellCommand());
    const notifications = this.parseNotifications(raw);
    const now = Date.now();

    for (const item of notifications) {
      const key = `${item.appName}|${item.id}|${item.createdAt}`;
      const prior = this.seenKeys.get(key);
      if (prior && now - prior < 120_000) continue;
      this.seenKeys.set(key, now);

      this.onNotification?.({
        id: `winrt-${item.id}`,
        title: item.sender,
        body: item.body,
        source: item.appName,
        appName: item.appName,
        sender: item.sender,
        priority: this.inferPriority(item.appName, item.body),
        createdAt: item.createdAt,
        metadata: {
          channel: 'winrt_notification_history',
          xml: item.xml,
        },
      });
    }

    this.pruneSeenMap(now);
  }

  buildPowerShellCommand() {
    return `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.Management.NotificationKinds, Windows.UI.Notifications, ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType=WindowsRuntime]
$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$access = [System.WindowsRuntimeSystemExtensions]::AsTask($listener.RequestAccessAsync()).GetAwaiter().GetResult()
if ($access -ne [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) {
  @{ access = "$access"; items = @() } | ConvertTo-Json -Compress
  exit
}
$items = [System.WindowsRuntimeSystemExtensions]::AsTask(
  $listener.GetNotificationsAsync([Windows.UI.Notifications.Management.NotificationKinds]::Toast)
).GetAwaiter().GetResult()
$result = foreach ($n in $items) {
  $xml = ''
  try { $xml = $n.Notification.Visual.GetXml().GetXml() } catch {}
  [pscustomobject]@{
    Id = $n.Id
    AppName = $n.AppInfo.DisplayInfo.DisplayName
    CreatedAt = $n.CreationTime.DateTime.ToString('o')
    Xml = $xml
  }
}
@{ access = 'Allowed'; items = $result } | ConvertTo-Json -Compress -Depth 5
`;
  }

  parseNotifications(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.access && parsed.access !== 'Allowed') {
        this.handleError(
          new Error(`WinRT notification access status: ${parsed.access}`)
        );
        return [];
      }

      const items = Array.isArray(parsed?.items)
        ? parsed.items
        : parsed?.items
          ? [parsed.items]
          : [];

      return items
        .map((item) => this.normalizeNotification(item))
        .filter(Boolean);
    } catch (error) {
      this.handleError(new Error(`Failed to parse WinRT notification JSON: ${error.message}`));
      return [];
    }
  }

  normalizeNotification(item) {
    const appName = String(item?.AppName ?? '').trim() || 'App';
    const xml = String(item?.Xml ?? '');
    const texts = this.extractTextNodes(xml);
    const sender = texts[0] ?? appName;
    const body = texts.slice(1).join(' ').trim();
    const createdAt = Date.parse(item?.CreatedAt ?? '') || Date.now();

    return {
      id: Number(item?.Id) || Date.now(),
      appName,
      sender,
      body,
      createdAt,
      xml,
    };
  }

  extractTextNodes(xml) {
    const matches = [...String(xml).matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)];
    return matches
      .map((match) => this.decodeXml(match[1]))
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  decodeXml(value) {
    return String(value ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  inferPriority(appName, body) {
    const src = String(appName).toLowerCase();
    const text = String(body).toLowerCase();

    if (src.includes('teams') || src.includes('outlook') || src.includes('mail')) {
      return 'HIGH';
    }
    if (text.includes('security') || text.includes('critical') || text.includes('alert')) {
      return 'CRITICAL';
    }
    return 'MEDIUM';
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
    for (const [key, ts] of this.seenKeys.entries()) {
      if (now - ts > 10 * 60_000) {
        this.seenKeys.delete(key);
      }
    }
  }

  handleError(error) {
    this.onError?.(error);
  }
}
