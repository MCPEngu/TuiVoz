// Toast, loading placeholder and error box.

import { app, toastEl } from '../core/dom.js';
import { esc } from '../core/utils.js';
import { ApiError } from '../api.js';

export function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `toast is-visible${isError ? ' is-error' : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3200);
}

export function loading() {
  app.innerHTML = `
    <div class="loading-skeleton" aria-label="Đang tải nội dung" role="status">
      <span class="skeleton-line skeleton-title"></span>
      <span class="skeleton-line skeleton-meta"></span>
      <div class="skeleton-card">
        <span class="skeleton-line skeleton-wide"></span>
        <span class="skeleton-line skeleton-medium"></span>
        <span class="skeleton-line skeleton-short"></span>
      </div>
      <div class="skeleton-card">
        <span class="skeleton-line skeleton-wide"></span>
        <span class="skeleton-line skeleton-medium"></span>
        <span class="skeleton-line skeleton-short"></span>
      </div>
      <div class="skeleton-card">
        <span class="skeleton-line skeleton-wide"></span>
        <span class="skeleton-line skeleton-medium"></span>
      </div>
    </div>`;
}

export function errorBox(err) {
  const message = err instanceof ApiError ? err.message : err && err.message ? err.message : String(err);
  const code = err instanceof ApiError && err.code ? ` <span class="u-dimmed">(${esc(err.code)})</span>` : '';
  return `<div class="error-box">${esc(message)}${code}</div>`;
}
