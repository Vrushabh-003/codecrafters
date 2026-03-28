import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import { ActivityTracker } from '../src/extension/core/activityTracker.js';

describe('ActivityTracker', () => {
  let tracker;

  beforeEach(() => {
    global.chrome = {
      tabs: {
        onActivated: { addListener: jest.fn(), removeListener: jest.fn() },
        onUpdated: { addListener: jest.fn(), removeListener: jest.fn() },
        onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
        query: jest.fn().mockResolvedValue([{ id: 1, url: 'https://github.com' }]),
        get: jest.fn().mockResolvedValue({ id: 1, url: 'https://new.com' }),
      },
      windows: {
        onFocusChanged: { addListener: jest.fn(), removeListener: jest.fn() },
        WINDOW_ID_NONE: -1,
      },
      idle: {
        onStateChanged: { addListener: jest.fn(), removeListener: jest.fn() },
        setDetectionInterval: jest.fn(),
      },
      alarms: {
        onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
        create: jest.fn(),
        clear: jest.fn(),
      },
      storage: {
        session: {
          set: jest.fn().mockResolvedValue(undefined),
          get: jest.fn().mockResolvedValue({}),
        },
        local: {
          set: jest.fn().mockResolvedValue(undefined),
          get: jest.fn().mockResolvedValue({}),
        },
      },
      runtime: {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        lastError: null,
      },
    };

    tracker = new ActivityTracker();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('init attaches listeners and keep-alive alarm', async () => {
    await tracker.init();

    expect(chrome.tabs.onActivated.addListener).toHaveBeenCalledWith(expect.any(Function));
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledWith(expect.any(Function));
    expect(chrome.windows.onFocusChanged.addListener).toHaveBeenCalledWith(expect.any(Function));
    expect(chrome.idle.setDetectionInterval).toHaveBeenCalledWith(30);
    expect(chrome.alarms.create).toHaveBeenCalledWith('activity-tracker-keepalive', {
      periodInMinutes: 0.5,
    });
  });

  test('emits TAB_SWITCH and URL_CHANGE on tab activation', async () => {
    tracker.currentDomain = 'old.com';
    tracker.lastActiveTimestamp = Date.now() - 5_000;

    await tracker._onTabActivated({ tabId: 1 });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'activityTracker',
        event: expect.objectContaining({
          type: 'TAB_SWITCH',
          domain: 'new.com',
          idleState: 'active',
        }),
      })
    );

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'activityTracker',
        event: expect.objectContaining({
          type: 'URL_CHANGE',
          domain: 'new.com',
        }),
      })
    );
  });

  test('handles sendMessage receiver-missing errors gracefully', async () => {
    chrome.runtime.sendMessage.mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.')
    );

    tracker.currentDomain = 'old.com';
    tracker.lastActiveTimestamp = Date.now() - 1_000;

    await expect(tracker._onTabActivated({ tabId: 1 })).resolves.toBeUndefined();
  });

  test('emits HEARTBEAT event on keep-alive alarm', async () => {
    tracker.currentDomain = 'test.com';

    await tracker._onAlarm({ name: 'activity-tracker-keepalive' });

    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastHeartbeat: expect.any(Number),
      })
    );

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'activityTracker',
        event: expect.objectContaining({
          type: 'HEARTBEAT',
          domain: 'test.com',
        }),
      })
    );
  });
});
