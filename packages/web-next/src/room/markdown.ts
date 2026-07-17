import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Chat prose is markdown: GFM with single-newline breaks (chat rhythm), then
// sanitized down to the structures the transcript styles. Author-supplied raw
// HTML never survives — only what markdown itself produces.
marked.use({ gfm: true, breaks: true });

const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'a',
];
const ALLOWED_ATTR = ['href', 'title', 'start', 'target', 'rel'];

// Every surviving link leaves the room in a new tab and drops the opener.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(body: string): string {
  const html = marked.parse(body, { async: false });
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
