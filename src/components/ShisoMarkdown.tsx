/**
 * SHISO-C1.7 S6 — safe Markdown rendering for SHISO messages.
 *
 * Untrusted assistant text is rendered as Markdown, never as HTML. There is no
 * `rehype-raw`, `dangerouslySetInnerHTML`, HTML execution, or event-handler
 * path. Only a small allowlist of Markdown elements is emitted and every URL
 * is passed through a strict scheme allowlist before it becomes an href.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/** GFM tables/strikethrough are useful; scripts, frames and forms are not. */
const ALLOWED_ELEMENTS = [
  'p', 'br', 'hr', 'em', 'strong', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
] as const;

/**
 * Only explicit web/email links and in-page anchors are allowed. Relative,
 * protocol-relative, `javascript:`, `data:` and `file:` URLs become inert text.
 */
export function safeShisoHref(value: string | undefined): string | null {
  if (!value) return null;
  const url = value.trim();
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url) || /^#[^ ]*$/.test(url)) return url;
  return null;
}

interface SafeLinkProps extends ComponentPropsWithoutRef<'a'> {
  children?: ReactNode;
}

function SafeLink({ href, children, ...rest }: SafeLinkProps) {
  const safe = safeShisoHref(href);
  if (safe === null) return <span>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow" {...rest}>
      {children}
    </a>
  );
}

export interface ShisoMarkdownProps {
  readonly text: string;
  readonly className?: string;
}

export function ShisoMarkdown({ text, className = '' }: ShisoMarkdownProps) {
  return (
    <div className={`kc-shiso-markdown ${className}`.trim()} data-testid="shiso-markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        allowedElements={[...ALLOWED_ELEMENTS]}
        urlTransform={(url) => safeShisoHref(url) ?? ''}
        components={{
          a: SafeLink,
          // Remote images are not rendered: a model must not be able to make
          // the client fetch arbitrary content from a message.
          img: () => null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default ShisoMarkdown;
