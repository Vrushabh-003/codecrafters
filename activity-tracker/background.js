import { ActivityTracker } from './activityTracker.js';

// Instantiate the module
const tracker = new ActivityTracker();

// Initialize on Service Worker wake
tracker.init().catch(e => console.warn('Activity Tracker init failed', e));
