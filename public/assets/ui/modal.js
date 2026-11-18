// Modal shell + the report dialog. Post editing happens in place (ui/inlineEdit.js).

import { modalRoot } from '../core/dom.js';
import { esc } from '../core/utils.js';
import { api } from '../api.js';
import { toast } from './feedback.js';

export function openModal(title, bodyHtml, footerHtml, { className = '' } = {}) {
  modalRoot.innerHTML = `
    <dialog class="modal${className ? ` ${className}` : ''}" closedby="any" aria-labelledby="modal-title">
      <div class="modal-header"><h2 class="modal-title" id="modal-title">${esc(title)}</h2><button type="button" data-close aria-label="Đóng">&times;</button></div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </dialog>`;
  const dialog = modalRoot.querySelector('dialog');
  const cleanup = () => {
    modalRoot.replaceChildren();
  };
  const close = () => {
    if (dialog.open) dialog.close();
    else cleanup();
  };
  dialog.addEventListener('close', cleanup, { once: true });
  dialog.querySelector('[data-close]').addEventListener('click', close);

  // Fallback for browsers without native <dialog closedby="any"> light-dismiss support (e.g. Safari).
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e)) close();
    });
  }

  dialog.showModal();
  return { close, root: modalRoot };
}

export function openReportModal(postId) {
  const { close } = openModal(
    'Báo cáo bài viết',
    `<form id="report-form">
       <div class="formRow">
         <label for="report-message">Lý do</label>
         <textarea class="textarea" id="report-message" placeholder="Mô tả vấn đề…" autofocus></textarea>
       </div>
     </form>`,
    `<button class="button" type="button" data-cancel>Huỷ</button>
     <button class="button button--primary" type="submit" form="report-form">Gửi báo cáo</button>`
  );
  modalRoot.querySelector('[data-cancel]').addEventListener('click', close);
  modalRoot.querySelector('#report-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.getElementById('report-message').value.trim();
    if (!message) return toast('Nhập lý do', true);
    try {
      await api.reportPost(postId, message);
      close();
      toast('Đã gửi báo cáo');
    } catch (err) {
      toast(err.message || 'Gửi báo cáo thất bại', true);
    }
  });
}
