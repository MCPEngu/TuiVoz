// BBCode helpers: sanitising server HTML, restoring image sizes, building quote blocks.

import { renderSmilies } from './smilies.js';
import { restoreMedia } from './media.js';
import { restoreQuoteLinks } from './quotes.js';
import { restoreSpoilers } from './spoilers.js';
import { rewriteVozLinks } from './postLinks.js';

let parseDoc = null;
let parseTemplate = null;
const JS_URI_RE = /^\s*javascript:/i;
const ATTACH_SRC_RE = /\/attachments\/(?:[^/?#]*\.)?(\d+)\/?/i;
const VOZ_ORIGIN_RE = /^https?:\/\/voz\.vn/i;
const QUERY_HASH_RE = /[?#].*$/;
const TRAILING_SLASH_RE = /\/+$/;
const HAS_IMG_OR_ATTACH_RE = /\[(?:img|attach)\b/i;
const BBCODE_IMG_SIZE_RE = /\[(IMG|ATTACH)([^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
const SIZE_ATTR_RE = /size\s*=\s*"(\d+)\s*x\s*(\d+)"/i;
const WIDTH_ATTR_RE = /width\s*=\s*"(\d+)/i;
const HEIGHT_ATTR_RE = /height\s*=\s*"(\d+)/i;
const STRIP_QUOTE_BLOCK_RE = /\[quote(?:=[^\]]*)?\][\s\S]*?\[\/quote\]/gi;
const STRIP_BBCODE_TAG_RE = /\[\/?[a-z*][^\]]*\]/gi;
const EXTRA_NEWLINES_RE = /\n{3,}/g;
const QUOTE_TOKEN_RE = /\[(\/?)quote(?:=[^\]]*)?\]/gi;

// message_parsed is server HTML; strip anything executable. The API drops image sizes, so they are re-applied
// from the raw BBCode.
export function sanitizeHtml(html, bbcode, { lazyImages = false } = {}) {
  if (!parseTemplate) {
    parseDoc = document.implementation.createHTMLDocument('');
    parseTemplate = parseDoc.createElement('template');
  }
  parseTemplate.innerHTML = html || '';
  const root = parseTemplate.content;
  restoreSpoilers(root, bbcode);
  for (const bad of root.querySelectorAll('script, style, object, embed, form, input, button')) {
    bad.remove();
  }
  for (const el of root.querySelectorAll('*')) {
    const attrs = el.attributes;
    for (let i = attrs.length - 1; i >= 0; i--) {
      const attr = attrs[i];
      const name = attr.name.toLowerCase();
      if (name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src') && JS_URI_RE.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener nofollow ugc');
    }
  }
  // Runs after the target/_blank pass: a link back into this app navigates in place. Voice-only (…/ignore)
  // links stay absolute.
  rewriteVozLinks(root);
  restoreQuoteLinks(root, bbcode);
  restoreMedia(root);
  applyImageSizes(root, bbcode, lazyImages);
  renderSmilies(root, lazyImages);
  const out = parseTemplate.innerHTML;
  parseTemplate.content.replaceChildren();
  return out;
}

function normalizeImgSrc(src) {
  const raw = String(src || '').trim();
  // Two URL shapes (/attachments/3823398/ and /attachments/<name>.3823398/) key on the id.
  const attach = raw.match(ATTACH_SRC_RE);
  if (attach) return `attach:${attach[1]}`;
  return raw
    .replace(VOZ_ORIGIN_RE, '')
    .replace(QUERY_HASH_RE, '')
    .replace(TRAILING_SLASH_RE, '');
}

// [IMG size="80x80"] → 80x80; [IMG width="150px"] → 150; [ATTACH width="150px"] → 150.
function parseBbcodeImageSizes(bbcode) {
  const sizes = new Map();
  if (!bbcode || !HAS_IMG_OR_ATTACH_RE.test(bbcode)) return sizes;
  BBCODE_IMG_SIZE_RE.lastIndex = 0;
  let match;
  while ((match = BBCODE_IMG_SIZE_RE.exec(bbcode))) {
    const attrs = match[2];
    if (!attrs) continue;
    const tag = match[1].toUpperCase();
    const inner = match[3].trim();
    let src;
    if (tag === 'IMG') {
      src = inner;
    } else {
      const id = inner.replace(/\D/g, '');
      if (!id) continue;
      src = `attach:${id}`;
    }
    const size = attrs.match(SIZE_ATTR_RE);
    const width = size ? null : attrs.match(WIDTH_ATTR_RE);
    const height = size ? null : attrs.match(HEIGHT_ATTR_RE);
    const spec = { width: 0, height: 0 };
    if (size) {
      spec.width = Number(size[1]);
      spec.height = Number(size[2]);
    } else {
      if (width) spec.width = Number(width[1]);
      if (height) spec.height = Number(height[1]);
    }
    if (spec.width || spec.height) sizes.set(normalizeImgSrc(src), spec);
  }
  return sizes;
}

function applyImageSizes(root, bbcode, lazyImages) {
  const imgs = root.querySelectorAll('img');
  if (!imgs.length) return;
  const sizes = parseBbcodeImageSizes(bbcode);
  for (const img of imgs) {
    if (img.closest('.bbCodeBlock--unfurl')) continue;
    img.classList.add('bbImage');
    // Below-the-fold post images defer network fetch until scrolled near (`optimize-image-priority`);
    // never combine `fetchpriority="low"` with `loading="lazy"`.
    if (lazyImages) {
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
    }
    if (!sizes.size) continue;
    const spec = sizes.get(normalizeImgSrc(img.getAttribute('src')));
    if (!spec) continue;
    if (spec.width) img.setAttribute('width', String(spec.width));
    if (spec.height) img.setAttribute('height', String(spec.height));
  }
}

export function bbcodeToPlain(bbcode) {
  return String(bbcode || '')
    .replace(STRIP_QUOTE_BLOCK_RE, '')
    .replace(STRIP_BBCODE_TAG_RE, '')
    .replace(EXTRA_NEWLINES_RE, '\n\n')
    .trim();
}

export function stripQuotes(bbcode) {
  if (!bbcode) return '';
  let depth = 0;
  let out = '';
  let last = 0;
  QUOTE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = QUOTE_TOKEN_RE.exec(bbcode))) {
    if (depth === 0) out += bbcode.slice(last, match.index);
    depth += match[1] ? -1 : 1;
    if (depth < 0) depth = 0;
    last = QUOTE_TOKEN_RE.lastIndex;
  }
  if (depth === 0) out += bbcode.slice(last);
  return out.replace(EXTRA_NEWLINES_RE, '\n\n').trim();
}

export function quoteBlock(post) {
  const author = String(post.username || '').replace(/"/g, '');
  const member = post.user_id ? `, member: ${post.user_id}` : '';
  const body = stripQuotes(post.message || '');
  // The caller adds one trailing blank line; two rendered as three in the reply box.
  return `[QUOTE="${author}, post: ${post.post_id}${member}"]\n${body}\n[/QUOTE]`;
}
