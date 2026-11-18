// /voz/signals batched analytics, same shapes as the app: impression / open / read. Events batch via
// `fetchLater()` with `activateAfter` (falling back to `fetch(..., { keepalive: true })` / `sendBeacon` on
// `visibilitychange` where `fetchLater` is unsupported); nothing is sent to guests.

import { state } from '../core/dom.js';

const SIGNALS_ENDPOINT = '/api/xf/voz/signals';
const BATCH_WINDOW_MS = 5000;
const MAX_QUEUE_SIZE = 20;

// Official modern-web-guidance `fetchLater()` fallback for browsers without native support (Firefox/Safari).
globalThis.fetchLater ??= function fetchLater(url, init = {}) {
  let timeoutHandle;
  let activated = false;

  function sendNow() {
    if (!(init.signal && init.signal.aborted)) {
      if ('keepalive' in Request.prototype || init.method !== 'POST' || init.headers) {
        fetch(url, Object.assign({}, init, { keepalive: true })).catch(() => {});
        activated = true;
      } else {
        activated = navigator.sendBeacon(url, init.body);
      }
    }
    destroy();
  }

  function destroy() {
    document.removeEventListener('visibilitychange', sendNow);
    clearTimeout(timeoutHandle);
  }

  if (document.visibilityState === 'hidden') {
    queueMicrotask(sendNow);
  } else {
    document.addEventListener('visibilitychange', sendNow);
    if (typeof init.activateAfter === 'number' && init.activateAfter >= 0) {
      timeoutHandle = setTimeout(sendNow, init.activateAfter);
    }
  }

  if (init.signal) {
    init.signal.addEventListener('abort', destroy);
  }

  return {
    get activated() {
      return activated;
    },
  };
};

const queue = [];
let fetchLaterResult = null;
let fetchLaterController = null;

function scheduleBeacon(activateAfter = BATCH_WINDOW_MS) {
  if (!queue.length || !state.loggedIn) {
    queue.length = 0;
    return;
  }
  if (fetchLaterController) {
    fetchLaterController.abort();
  }
  fetchLaterController = new AbortController();
  const payload = JSON.stringify({ events: queue });
  try {
    fetchLaterResult = fetchLater(SIGNALS_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: fetchLaterController.signal,
      activateAfter,
    });
  } catch {
    // Quota exceeded or transient browser failure: drop silently.
  }
}

export function signal(event) {
  if (!state.loggedIn || !event?.type) return;
  if (fetchLaterResult?.activated) {
    fetchLaterController = null;
    fetchLaterResult = null;
    queue.length = 0;
  }
  queue.push({ timestamp: Math.floor(Date.now() / 1000), ...event });
  if (queue.length >= MAX_QUEUE_SIZE) {
    scheduleBeacon(0);
    fetchLaterController = null;
    fetchLaterResult = null;
    queue.length = 0;
    return;
  }
  scheduleBeacon(BATCH_WINDOW_MS);
}

export const signalImpression = (threadId, surface, position) =>
  signal({ type: 'impression', thread_id: Number(threadId), surface, position });
export const signalOpen = (threadId, source, position) =>
  signal({ type: 'open', thread_id: Number(threadId), source: source || 'other', position });
export const signalRead = (threadId, seconds, posts, depth, pages) =>
  signal({ type: 'read', thread_id: Number(threadId), seconds, posts, depth, pages });
