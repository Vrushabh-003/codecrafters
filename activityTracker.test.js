import { ActivityTracker } from './activityTracker.js';

describe('ActivityTracker', () => {
    let tracker;

    beforeEach(() => {
        global.chrome = {
            tabs: {
                onActivated: { addListener: jest.fn(), removeListener: jest.fn() },
                onUpdated: { addListener: jest.fn(), removeListener: jest.fn() },
                onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
                query: jest.fn(),
                get: jest.fn()
            },
            windows: {
                onFocusChanged: { addListener: jest.fn(), removeListener: jest.fn() },
                WINDOW_ID_NONE: -1
            },
            idle: {
                onStateChanged: { addListener: jest.fn(), removeListener: jest.fn() },
                setDetectionInterval: jest.fn()
            },
            alarms: {
                onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
                create: jest.fn(),
                clear: jest.fn()
            },
            storage: {
                session: {
                    set: jest.fn().mockImplementation((val, cb) => cb && cb()),
                    get: jest.fn().mockImplementation((keys, cb) => cb({}))
                },
                local: {
                    set: jest.fn(),
                    get: jest.fn()
                }
            },
            runtime: {
                sendMessage: jest.fn().mockImplementation((msg, cb) => cb && cb()),
                lastError: null
            }
        };

        tracker = new ActivityTracker();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('init calls restore state and attaches listeners', async () => {
        chrome.storage.session.get.mockImplementation((keys, cb) => cb({
            currentDomain: 'github.com',
            lastActiveTimestamp: 1000,
            tabSwitchTimestamps: []
        }));

        chrome.tabs.query.mockImplementation((queryConfig, cb) => cb([{ id: 1, url: 'https://github.com' }]));
        
        await tracker.init();

        expect(chrome.tabs.onActivated.addListener).toHaveBeenCalledWith(expect.any(Function));
        expect(chrome.alarms.create).toHaveBeenCalledWith('keep-alive-alarm', { periodInMinutes: 25 / 60 });
        expect(chrome.idle.setDetectionInterval).toHaveBeenCalledWith(30);
    });

    test('emits TAB_SWITCH event on tab activation', async () => {
        tracker.currentDomain = 'old.com';
        tracker.lastActiveTimestamp = Date.now() - 5000;
        
        chrome.tabs.get.mockImplementation((tabId, cb) => cb({ id: 1, url: 'https://new.com' }));
        
        await tracker._onTabActivated({ tabId: 1 });
        
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'TAB_SWITCH',
                domain: 'new.com',
                idleState: 'active'
            }), 
            expect.any(Function)
        );
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'URL_CHANGE',
                domain: 'new.com'
            }),
            expect.any(Function)
        );
    });

    test('fails gracefully on message error', async () => {
        chrome.runtime.lastError = { message: 'Receiving end does not exist' };
        chrome.tabs.get.mockImplementation((tabId, cb) => cb({ id: 1, url: 'https://new.com' }));
        
        // This shouldn't throw an unhandled rejection
        await expect(tracker._onTabActivated({ tabId: 1 })).resolves.not.toThrow();
        chrome.runtime.lastError = null;
    });

    test('emits HEARTBEAT event on keep-alive alarm', async () => {
        tracker.currentDomain = 'test.com';
        
        await tracker._onAlarm({ name: 'keep-alive-alarm' });
        
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'HEARTBEAT',
                domain: 'test.com'
            }),
            expect.any(Function)
        );
    });
});
