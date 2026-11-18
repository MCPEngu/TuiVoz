// "KIA" (banned) detection.
//
// The `/users/{id}/` user object carries NO ban information, and the two conditions that hide a profile look
// identical there: a banned account and a member who simply hid their profile both come back with
// can_view_profile/can_view_profile_posts = false. Neither last_activity nor the staff flags separate them.
//
// The distinction shows up only as a different error code on a profile-scoped endpoint:
//
//   GET /users/{id}/profile-posts  -> 403 this_users_profile_is_not_available   => banned
//   GET /users/{id}/profile-posts  -> 403 member_limits_viewing_profile         => member hid their profile
//   GET /users/{id}/profile-posts  -> 200                                       => normal
//
// Verified against voz.vn: every "profile is not available" account answers the profile page with "This user's
// profile is not available." while every "limits viewing" one answers "This member limits who may view their
// full profile." The member-finder autocomplete cannot stand in for this — it also drops members who merely hid
// their profile, so an empty result there is not proof of a ban.

import { api, ApiError } from '../api.js';
import { getBannedUsers } from './settings.js';

// voz.vn styles the strike itself: `.username--banned { text-decoration: line-through; }`.
export const BANNED_CLASS = 'username--banned';

// Error code XenForo returns for an account that is disabled/banned.
export const BANNED_ERRCODE = 'this_users_profile_is_not_available';
// Returned when the member merely hid their profile — definitively not a ban.
const LIMITED_ERRCODE = 'member_limits_viewing_profile';

// A banned account and a hidden profile both set these flags, so `true` here only means "worth asking"; the
// profile-posts error code decides. Visible and staff profiles can never be banned.
export function mayBeBanned(user) {
  return !!user && !user.is_staff && user.can_view_profile === false && user.can_view_profile_posts === false;
}

// "smart" only resolves a member the reader explicitly asked about (tooltip, profile page); "all" also resolves
// every username that scrolls near the viewport. Anything else keeps the page free of ban lookups.
export function shouldLookupBulk() {
  return getBannedUsers() === 'all';
}

export function bannedFeatureOn() {
  return getBannedUsers() !== 'off';
}

// Verdicts are stored in IndexedDB as well as memory: a ban does not change between page loads, and without
// persistence every reload re-checks every visible author. Entries expire after a week so a member who gets
// banned (or unbanned) is picked up then rather than never.
const DB_NAME = 'TuiVozBanStorage';
const DB_VERSION = 1;
const STORE = 'verdicts';
const TTL = 7 * 24 * 60 * 60_000;

const cache = new Map();
let database = null;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
  });
}

async function loadVerdicts() {
  if (!('indexedDB' in window)) return;
  try {
    database = await openDatabase();
    const store = database.transaction(STORE, 'readonly').objectStore(STORE);
    const rows = (await requestResult(store.getAll())) || [];
    const now = Date.now();
    const expired = [];
    for (const row of rows) {
      if (!row || !row.id) continue;
      if (now - row.at > TTL) {
        expired.push(row.id);
        continue;
      }
      cache.set(Number(row.id), { banned: !!row.banned, at: row.at });
    }
    if (expired.length) pruneVerdicts(expired);
  } catch {
    // Private mode or a blocked upgrade: fall back to memory for this session.
    database = null;
  }
}

function pruneVerdicts(ids) {
  if (!database) return;
  try {
    const store = database.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const id of ids) store.delete(Number(id));
  } catch { /* best effort */ }
}

// Writes are batched into one transaction per tick: a thread page can produce a dozen verdicts at once.
const queued = new Map();
let flushScheduled = false;

function flushVerdicts() {
  flushScheduled = false;
  if (!database || !queued.size) return;
  const rows = [...queued.values()];
  queued.clear();
  try {
    const store = database.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const row of rows) store.put(row);
  } catch { /* best effort */ }
}

function persistVerdict(id, banned, at) {
  if (!database) return;
  queued.set(Number(id), { id: Number(id), banned, at });
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushVerdicts);
}

let loadPromise = null;
const ensureLoaded = () => (loadPromise ||= loadVerdicts());

// Resolves true only when the profile lookup reports the banned error code. Only definitive answers are cached;
// a network error or rate limit leaves the verdict unknown so the next render can retry.
export async function checkBanned(userOrId) {
  if (!bannedFeatureOn()) return false;
  const user = typeof userOrId === 'object' && userOrId !== null ? userOrId : null;
  const id = Number(user ? user.user_id : userOrId);
  if (!id) return false;
  if (user && !mayBeBanned(user)) return false;
  await ensureLoaded();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.banned;
  try {
    await api.profilePosts(id, 1, { priority: 'low' });
    storeVerdict(id, false);
    return false;
  } catch (err) {
    if (err instanceof ApiError && err.code === BANNED_ERRCODE) {
      storeVerdict(id, true);
      return true;
    }
    // member_limits_viewing_profile is a definite "not banned"; anything else (rate limit, offline) is unknown,
    // so do not cache it and let a later render try again.
    if (err instanceof ApiError && err.code === LIMITED_ERRCODE) storeVerdict(id, false);
    // A 429 means the reader turned this on and hit voz.vn's throttle; say so once instead of failing silently.
    if (err instanceof ApiError && err.status === 429) warnRateLimited();
    return false;
  }
}

let rateWarned = false;

function warnRateLimited() {
  if (rateWarned) return;
  rateWarned = true;
  import('../ui/feedback.js')
    .then(({ toast }) => toast('voz.vn đang giới hạn lượt gọi — tạm dừng kiểm tra nick bị ban, thử lại sau ít phút.'))
    .catch(() => {});
}

function storeVerdict(id, banned) {
  const at = Date.now();
  cache.set(id, { banned, at });
  persistVerdict(id, banned, at);
}

// Prefix match, so a caller can also reach usernames that share the class with something else
// ("username comment-user"). Avatar links carry the same data-member-id but no .username, so they stay clean.
const USERNAME_SELECTOR = '[class*="username"]';

export function forgetBanned(userId) {
  const id = Number(userId);
  cache.delete(id);
  queued.delete(id);
  pruneVerdicts([id]);
}

// Turning the setting off should not leave already-struck names behind. The observer keeps running for the rest
// of the session but every check short-circuits, and re-enabling redraws the page so the wiring runs again.
export function clearBannedMarks(root = document) {
  for (const el of root.querySelectorAll(`.${BANNED_CLASS}`)) el.classList.remove(BANNED_CLASS);
}

// On-demand lookup for one member, used by "smart" mode (member tooltip / profile page). Adds or removes the
// strike on `elements` and resolves to the verdict.
export async function applyBannedMark(elements, userId) {
  const els = (Array.isArray(elements) ? elements : [elements]).filter(Boolean);
  const id = Number(userId);
  if (!id || !bannedFeatureOn() || !els.length) return false;
  const banned = await checkBanned(id);
  for (const el of els) {
    if (!el.isConnected) continue;
    el.classList.toggle(BANNED_CLASS, banned);
  }
  return banned;
}

// Scans a rendered container for usernames and strikes the banned ones. Each username element either carries
// `data-member-id` itself (profile name) or sits under an element that does (post author link). Pass `users` —
// real user objects (thread/post `.User`) — so accounts with a visible profile skip the round-trip entirely.
//
// The ban check is one request per author, so like the reaction strips these wait until the element is near the
// viewport: a full page would otherwise fire a dozen lookups right after render. `checkBanned` caches per user,
// so a member appearing several times costs one request and scrolling back costs none.
function collectBuckets(root, users) {
  const visible = new Set();
  for (const user of users) {
    if (user && typeof user.can_view_profile === 'boolean' && !mayBeBanned(user)) visible.add(Number(user.user_id));
  }
  const buckets = new Map();
  for (const el of root.querySelectorAll(USERNAME_SELECTOR)) {
    if (el.classList.contains(BANNED_CLASS)) continue;
    const id = Number(el.closest('[data-member-id]')?.dataset.memberId);
    if (!id || visible.has(id)) continue;
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(el);
  }
  return buckets;
}

// Start early enough that the strike is in place before the name scrolls into view. Kept tight: every observed
// name that intersects costs one request, and a page of 24 rows fits inside the viewport plus margin almost
// immediately, which would defeat the point.
const OBSERVE_MARGIN = '150px 0px';

// Element -> the lookup that should run when it gets close to the viewport. The observer is shared across the
// whole session (one per page is plenty) but every observed node carries its own callback; keying off the shared
// observer's closure would resolve every name with the first author's id.
const pending = new WeakMap();

let nameObserver = null;

function getObserver() {
  nameObserver ||= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const run = pending.get(entry.target);
        nameObserver.unobserve(entry.target);
        pending.delete(entry.target);
        if (run) run();
      }
    },
    { rootMargin: OBSERVE_MARGIN }
  );
  return nameObserver;
}

export function wireBannedUsernames(root, users = []) {
  // Only "all" scans the page. "smart" leaves the page alone and resolves a member on demand (tooltip/profile).
  if (!shouldLookupBulk()) return;
  if (!root) return;
  for (const [id, els] of collectBuckets(root, users)) {
    const apply = () => {
      checkBanned(id).then((banned) => {
        if (!banned) return;
        for (const el of els) if (el.isConnected) el.classList.add(BANNED_CLASS);
      });
    };
    if (!('IntersectionObserver' in window)) {
      apply();
      continue;
    }
    // Observing the first copy is enough: the whole group is struck together, and the same member can appear
    // several times on one page (several posts, or thread starter plus latest poster).
    pending.set(els[0], apply);
    getObserver().observe(els[0]);
  }
}
