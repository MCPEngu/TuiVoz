import { esc } from '../core/utils.js';
import { api } from '../api.js';

let reactionsPromise;

export async function alertTextMarkup(alert) {
  const text = alert.alert_text || alert.content_title || '';
  if (alert.action !== 'reaction' || !alert.reaction_title) return esc(text);
  reactionsPromise ||= api.reactions().then((res) => res.reactions || []).catch(() => []);
  const reaction = (await reactionsPromise).find((item) => item.title === alert.reaction_title);
  if (!reaction) return esc(text);
  const suffix = `with ${alert.reaction_title}.`;
  if (!text.endsWith(suffix)) return esc(text);
  return `${esc(text.slice(0, -suffix.length))}<img src="${esc(reaction.image_url)}" alt="${esc(reaction.title)}" title="${esc(reaction.title)}" class="reaction-image alert-reaction-image" referrerpolicy="no-referrer">`;
}
