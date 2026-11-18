// Long quotes would push the rest of the thread off screen. voz.vn clips any quote whose content passes 800px
// and fades it into a "Click to expand..." button.
export const MAX_QUOTE_HEIGHT = 800;

function wrapExpandableQuote(quote) {
  // The header stays outside the clip so the reader always sees whose post is quoted.
  const head = quote.querySelector('.quote-source');
  const body = quote.ownerDocument.createElement('div');
  body.className = 'quote-expand-content';
  let node = head ? head.nextSibling : quote.firstChild;
  while (node) {
    const next = node.nextSibling;
    body.append(node);
    node = next;
  }
  if (!body.childNodes.length) return;

  const link = quote.ownerDocument.createElement('button');
  link.type = 'button';
  link.className = 'quote-expand-link';
  link.setAttribute('aria-expanded', 'false');
  const label = quote.ownerDocument.createElement('span');
  label.textContent = 'Bấm để mở rộng...';
  link.append(label);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = quote.classList.toggle('is-expanded');
    link.setAttribute('aria-expanded', String(expanded));
    label.textContent = expanded ? 'Thu gọn' : 'Bấm để mở rộng...';
  });

  quote.append(body, link);
  quote.classList.add('is-expandable');
}

export function wireQuoteExpansion(root = document) {
  const candidates = root.querySelectorAll('blockquote.xfBb-quote:not(.is-expandable)');
  if (!candidates.length) return;
  // Batch all DOM layout reads BEFORE mutating the DOM to prevent forced-reflow layout thrashing.
  // Off-screen posts deferred via `content-visibility: auto` report scrollHeight === 0 until they approach
  // the viewport, where `contentvisibilityautostatechange` triggers re-measurement.
  const tallQuotes = [];
  for (const quote of candidates) {
    if (quote.scrollHeight > MAX_QUOTE_HEIGHT) tallQuotes.push(quote);
  }
  for (const quote of tallQuotes) {
    wrapExpandableQuote(quote);
  }
}

let scheduled = false;

// Quotes can only be measured once laid out, so this runs on an animation frame.
function scheduleQuoteExpansion() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    wireQuoteExpansion();
  });
}

export function wireAllQuoteExpansion() {
  scheduleQuoteExpansion();
  // Watch the whole body: views replace #app and appended pages arrive later.
  new MutationObserver(scheduleQuoteExpansion).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', scheduleQuoteExpansion, { passive: true });
  // When an off-screen `content-visibility: auto` post begins rendering near the viewport, coalesce onto the
  // shared rAF pass so multiple unlocking posts share one layout read/write cycle.
  document.addEventListener('contentvisibilityautostatechange', (event) => {
    if (!event.skipped) scheduleQuoteExpansion();
  }, true);
  // A quote holding a picture measures short until it decodes, so re-measure on image load.
  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement && event.target.closest('blockquote.xfBb-quote')) scheduleQuoteExpansion();
  }, true);
}

const CODE_BLOCK_RE = /\[(code|php|html)(?:=[^\]]*)?\][\s\S]*?\[\/\1\]/gi;
const QUOTE_OPEN_RE = /\[quote(?:=([^\]]*))?\]/gi;
const POST_ID_RE = /,\s*post:\s*(\d+)/i;
const QUOTE_AUTHOR_SPLIT_RE = /,\s*(?:post|member):/i;

export function restoreQuoteLinks(root, bbcode) {
  if (!bbcode || ! QUOTE_OPEN_RE.test(bbcode)) return;
  QUOTE_OPEN_RE.lastIndex = 0;
  const blockquotes = root.querySelectorAll('blockquote.xfBb-quote');
  if (!blockquotes.length) return;
  const source = String(bbcode).replace(CODE_BLOCK_RE, '');
  QUOTE_OPEN_RE.lastIndex = 0;
  const quotes = [];
  let match;
  while ((match = QUOTE_OPEN_RE.exec(source))) {
    const value = (match[1] || '').replace(/^['"]|['"]$/g, '');
    const post = value.match(POST_ID_RE);
    quotes.push({ name: value.split(QUOTE_AUTHOR_SPLIT_RE)[0], id: post?.[1] });
  }
  let index = 0;
  for (const quote of blockquotes) {
    const meta = quotes[index++];
    if (!meta?.id || meta.name !== quote.getAttribute('data-name')) continue;
    const link = root.ownerDocument.createElement('a');
    link.className = 'quote-source';
    link.href = `/p/${meta.id}/`;
    link.textContent = `${meta.name} đã viết: ↑`;
    quote.prepend(link);
    quote.classList.add('has-quote-source');
  }
}
