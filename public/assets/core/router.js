// History-API router. The page number lives in the path (/t/slug.123/page-2).
// Views are loaded on demand via dynamic `import()` so cold-booting one route never downloads or parses the
// rest of the application (e.g. 58 KB settings, 100 KB rich editor, DM, user profile).

import { app } from './dom.js';
import { idFromSegment, threadPath, dmPath, withPage } from './paths.js';
import { api } from '../api.js';
import { navigate, setRouteHandler } from './nav.js';
import { errorBox, finishLoading } from '../ui/feedback.js';
import { ensureSession } from '../ui/session.js';
import { refreshUnreadCounts } from '../ui/unreadCounts.js';
import { teardownInfiniteScroll } from '../ui/infiniteScroll.js';
import { setTitle } from '../ui/title.js';

const viewCache = new Map();
function loadView(specifier, factory) {
  let pending = viewCache.get(specifier);
  if (!pending) {
    pending = factory().catch((err) => {
      viewCache.delete(specifier);
      throw err;
    });
    viewCache.set(specifier, pending);
  }
  return pending;
}

const forumViews = () => loadView('forum', () => import('../views/forum.js'));
const threadViews = () => loadView('thread', () => import('../views/thread.js'));
const searchViews = () => loadView('search', () => import('../views/search.js'));
const dmViews = () => loadView('dm', () => import('../views/dm.js'));
const listViews = () => loadView('lists', () => import('../views/lists.js'));
const userViews = () => loadView('user', () => import('../views/user.js'));
const loginViews = () => loadView('login', () => import('../views/login.js'));
const composeViews = () => loadView('compose', () => import('../views/compose.js'));
const settingsViews = () => loadView('settings', () => import('../views/settings.js'));

export function parsePath() {
  const segments = location.pathname.split('/').filter(Boolean);
  const params = new URLSearchParams(location.search);
  let page = 1;
  const last = segments[segments.length - 1] || '';
  const pageMatch = last.match(/^page-(\d+)$/);
  if (pageMatch) {
    page = Number(pageMatch[1]) || 1;
    segments.pop();
  }
  if (params.get('page')) page = Number(params.get('page')) || page;
  return { segments, params, page };
}

// Kick off the initial route's view chunk download as soon as the router module evaluates.
export function prefetchRouteModule() {
  const head = (location.pathname.split('/').filter(Boolean)[0] || '');
  if (!head || head === 's' || head === 'new') forumViews();
  else if (head === 'f') {
    const segs = location.pathname.split('/').filter(Boolean);
    if (segs[2] === 'post-thread') composeViews();
    else forumViews();
  } else if (head === 't' || head === 'p') threadViews();
  else if (head === 'search') searchViews();
  else if (head === 'direct-messages' || head === 'dm') dmViews();
  else if (head === 'alerts' || head === 'bookmarks' || head === 'watched') listViews();
  else if (head === 'u' || head === 'pp' || head === 'profile-posts') userViews();
  else if (head === 'cai-dat-tuivoz') settingsViews();
  else if (head === 'login') loginViews();
}

// Resolves a thread's first unread post. A read thread falls back to page 1 with no post, like voz.vn. The
// thread object comes back so the caller keeps the canonical slug.
async function unreadTarget(threadId) {
  const [{ resolveUnread, threadLastPage }, head] = await Promise.all([
    import('../lib/unread.js'),
    api.thread(threadId, 1),
  ]);
  const thread = head.thread || { thread_id: threadId, title: '' };
  const fallback = { thread, page: 1, postId: null };
  if (!thread.is_unread) return fallback;

  const target = await resolveUnread(
    { visitorReadDate: thread.visitor_read_date, lastPage: threadLastPage(thread) },
    (p) => api.threadPosts(threadId, p)
  );
  if (!target) return fallback;
  return { thread, page: target.page, postId: target.postId };
}

export async function route() {
  const { segments, params, page } = parsePath();
  const head = segments[0] || '';
  teardownInfiniteScroll({ keepSentinel: true });
  // Leaving the thread screen fires the queued `read` signal (see views/thread.js).
  if (head !== 't') window.dispatchEvent(new Event('voz:leave-thread'));

  try {
    if (!head) {
      const { viewHome } = await forumViews();
      return await viewHome();
    }
    if (head === 'p' && /^\d+$/.test(segments[1] || '')) {
      const { post } = await api.post(Number(segments[1]));
      const threadId = post.thread_id || post.Thread?.thread_id;
      const result = await api.thread(threadId, 1);
      const perPage = result.pagination?.per_page;
      if (!perPage || !Number.isFinite(Number(post.position))) throw new Error('Không xác định được trang của bài viết');
      const targetPage = Math.floor(Number(post.position) / perPage) + 1;
      return navigate(`${withPage(threadPath(result.thread), targetPage)}#post-${post.post_id}`, { replace: true });
    }
    if (head === 'f' && segments[2] === 'post-thread') {
      const { viewCompose } = await composeViews();
      return await viewCompose(idFromSegment(segments[1]));
    }
    if (head === 'f') {
      const { viewForum } = await forumViews();
      return await viewForum(idFromSegment(segments[1]), page);
    }
    if (head === 's') {
      const { viewSearchForum } = await forumViews();
      return await viewSearchForum(idFromSegment(segments[1]), page);
    }
    if (head === 't') {
      const threadId = idFromSegment(segments[1]);
      // /t/<slug>.<id>/unread — resolve the page, then replace the URL like voz.vn's redirect.
      if (segments[2] === 'unread') {
        const target = await unreadTarget(threadId);
        const href = `${withPage(threadPath(target.thread), target.page)}${target.postId ? `#post-${target.postId}` : ''}`;
        return navigate(href, { replace: true });
      }
      const { viewThread } = await threadViews();
      return await viewThread(threadId, page, Number(params.get('post')) || null);
    }
    if (head === 'new') {
      const { viewNewThreads } = await forumViews();
      return await viewNewThreads(page);
    }
    if (head === 'search') {
      const { viewSearch } = await searchViews();
      return await viewSearch(params.get('q') || '', params.get('id'), page);
    }
    if (head === 'direct-messages' || head === 'dm') {
      // voz.vn alert URLs point here for a reacted DM message; the message resolves its conversation.
      if (segments[1] === 'replies' && /^\d+$/.test(segments[2] || '')) {
        const messageId = Number(segments[2]);
        const { message } = await api.conversationMessage(messageId);
        const conversationId = message && message.conversation_id;
        if (!conversationId) throw new Error('Không xác định được hộp thư của tin nhắn');
        const result = await api.conversation(conversationId, 1);
        const conversation = result.conversation || { conversation_id: conversationId, title: '' };
        return navigate(`${dmPath(conversation)}#conversation-message-${messageId}`, { replace: true });
      }
      const { viewDmList, viewDm, viewNewDm } = await dmViews();
      if (segments[1] === 'new') return await viewNewDm(params.get('to') || '');
      if (segments[1]) return await viewDm(idFromSegment(segments[1]), page);
      return await viewDmList(page);
    }
    if (head === 'alerts') {
      const { viewAlerts } = await listViews();
      return await viewAlerts(page);
    }
    if (head === 'bookmarks') {
      const { viewBookmarks } = await listViews();
      return await viewBookmarks(page);
    }
    if (head === 'watched') {
      const { viewWatched } = await listViews();
      return await viewWatched(page);
    }
    if (head === 'u') {
      const { viewUser } = await userViews();
      return await viewUser(idFromSegment(segments[1]), params, segments[2] || '');
    }
    if (head === 'pp' && /^\d+$/.test(segments[1] || '')) {
      const { viewProfilePost } = await userViews();
      return await viewProfilePost(Number(segments[1]), page);
    }
    // voz URLs: /profile-posts/{id}/ → single post; /profile-posts/comments/{id}/ → comment, resolves to parent post.
    if (head === 'profile-posts') {
      if (segments[1] === 'comments' && /^\d+$/.test(segments[2] || '')) {
        const commentId = Number(segments[2]);
        try {
          const res = await api.profilePostComment(commentId);
          const postId = res?.comment?.profile_post_id || res?.profile_post_comment?.profile_post_id;
          if (postId) {
            const { viewProfilePost } = await userViews();
            return await viewProfilePost(postId, page, `profile-post-comment-${commentId}`);
          }
        } catch { /* fall through */ }
        return navigate('/alerts', { replace: true });
      }
      if (/^\d+$/.test(segments[1] || '')) {
        const { viewProfilePost } = await userViews();
        return await viewProfilePost(Number(segments[1]), page);
      }
    }
    if (head === 'cai-dat-tuivoz') {
      const { viewSettings } = await settingsViews();
      return await viewSettings();
    }
    if (head === 'login') {
      const { viewLogin } = await loginViews();
      return await viewLogin();
    }
    setTitle('Oops! We ran into some problems.');
    app.innerHTML = '<div class="empty">Không tìm thấy trang.</div>';
  } catch (err) {
    // voz.vn's own error title.
    setTitle('Oops! We ran into some problems.');
    app.innerHTML = errorBox(err);
  } finally {
    finishLoading();
    ensureSession().then(() => refreshUnreadCounts());
  }
}

setRouteHandler(route);
