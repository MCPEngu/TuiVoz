// voz.vn native attachments: the same flow the app uses — POST /attachments/new-key, upload each file to
// /attachments with that key, then pass `attachment_key` on the post body and reference files as [ATTACH]<id>.
// Needs a logged-in session with attachment:write; guests (and pre-relogin sessions lacking the scope) fall
// back to pik.vn [IMG] uploads.

import { api, ApiError } from '../api.js';
import { state } from '../core/dom.js';
import { registerAttachments } from './attachments.js';

export const ATTACH_MAX_BYTES = 8 * 1024 * 1024; // images ≤ 8 MB like the app
// voz's attach picker `accept` list, taken from its own .js-attachmentUpload button: archives, text, PDF and
// the image formats it accepts (svg included — it is not a raster type, so it cannot go through pik.vn).
export const ATTACH_ACCEPT = '.zip,.7z,.tgz,.txt,.pdf,.png,.jpg,.jpeg,.gif,.svg,.webp';

// Editors declare what their post will be attached to so the key carries the right context:
// { thread_id } for replies, { post_id } for edits, { node_id } for new threads.
export function attachmentSupported() {
  return !!(state.loggedIn && state.me);
}

export class AttachmentUploads {
  constructor(context = {}) {
    this.context = context;
    this.keyPromise = null;
    this.items = []; // { id, file, attachment, status, error }
  }

  get key() {
    // One key per compose box, created lazily on first file like the app's ensureKey().
    if (!this.keyPromise) {
      this.keyPromise = api
        .attachmentKey(this.context)
        .then((res) => res.key || res.attachment_key || (res.keys && res.keys.key) || null);
    }
    return this.keyPromise;
  }

  get done() {
    return this.items.filter((item) => item.status === 'done');
  }

  get pending() {
    return this.items.some((item) => item.status === 'uploading');
  }

  async add(files, onChange) {
    // No size filter here: voz's own uploader lets the server reject an oversized file, and the API reports the
    // reason (413 / "too large"), which reads better than a silent drop.
    const list = [...(files || [])].filter((file) => file && file.size > 0);
    if (!list.length) return;
    const notify = () => onChange?.(this.items);
    const key = await this.key;
    if (!key) throw new Error('Không lấy được attachment key.');
    await Promise.all(
      list.map(async (file) => {
        const item = { file, name: file.name || 'attachment', status: 'uploading' };
        this.items.push(item);
        notify();
        try {
          const res = await api.uploadAttachment(key, file);
          const attachment = res.attachment || res.Attachment || {};
          item.status = 'done';
          item.attachment = attachment;
          item.id = attachment.attachment_id;
          registerAttachments([attachment]);
        } catch (err) {
          item.status = 'error';
          item.error = err instanceof ApiError && err.code === 'missing_scope' ? 'Hãy đăng xuất rồi đăng nhập lại để cấp quyền đính kèm.' : err.message || 'Tải lên thất bại';
        }
        notify();
      })
    );
  }

  async remove(item) {
    this.items = this.items.filter((entry) => entry !== item);
    if (item.id) {
      await api.deleteAttachment(item.id, await this.key.catch(() => null)).catch(() => {});
    }
  }

  // BBCode the app inserts into the message for one uploaded file.
  attachBbcode(item) {
    return item?.id ? `[ATTACH]${item.id}[/ATTACH]` : '';
  }

  async attachmentKeyOrNull() {
    if (!this.done.length) return null;
    const key = await this.key.catch(() => null);
    return this.done.length ? key : null;
  }
}
