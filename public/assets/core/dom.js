// Shared DOM handles and app-wide mutable state.

export const app = document.getElementById('app');
export const breadcrumbsEl = document.getElementById('breadcrumbs');
export const accountEl = document.getElementById('header-account');
export const navEl = document.getElementById('nav-list');
export const toastEl = document.getElementById('toast');
export const modalRoot = document.getElementById('modal-root');

export const state = {
  me: null,
  loggedIn: false,
  reactions: null,
  nodes: null,
  config: null,
};

// Promotes a print-deferred <link rel="stylesheet"> immediately when a route needs it.
export function ensureStylesheet(href) {
  const link = document.querySelector(`link[rel="stylesheet"][href="${href}"]`);
  if (!link) return Promise.resolve();
  // Promoting `media` from `print` to `all` upfront boosts Chromium's fetch priority out of Idle.
  if (link.media && link.media !== 'all') link.media = 'all';
  if (link.sheet) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    if (link.sheet) done();
  });
}
