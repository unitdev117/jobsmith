// `{}`-wrapped Markdown descriptions for job listings.
//
// Security invariants (non-negotiable):
// 1. Parser options escape ALL raw HTML below — injected markup renders as
//    visible text, never markup.
// 2. Link destinations are restricted to http/https/mailto by post-processing;
//    anything else degrades to a dead "#" link.
//
// Bun 1.4's markdown.html() IGNORES render callbacks (they belong to
// render()), which is why sanitization post-processes the emitted string.

export const WRAPPER_OPEN = "{";
export const WRAPPER_CLOSE = "}";

/** True when the trimmed description opts into Markdown mode. */
export const isWrappedDescription = (raw: string): boolean => {
  const trimmed = raw.trim();
  return (
    trimmed.length >= 2 && trimmed.startsWith("{") && trimmed.endsWith("}")
  );
};

/** Inner markdown source between the wrapper braces, inner-trimmed. */
export const unwrapDescription = (raw: string): string =>
  raw.trim().slice(1, -1).trim();

const MARKDOWN_OPTIONS = {
  // Raw HTML must stay escaped; never remove these two.
  noHtmlBlocks: true,
  noHtmlSpans: true,
};

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

// Decode the entities the generator emits so URL validation sees real
// characters; numeric forms cover the rest.
const decodeEntities = (value: string): string =>
  value.replace(
    /&(?:amp|quot|lt|gt|#\d+|#[xX][0-9a-fA-F]+);/g,
    (entity): string => {
      if (entity === "&amp;") return "&";
      if (entity === "&quot;") return '"';
      if (entity === "&lt;") return "<";
      if (entity === "&gt;") return ">";
      const codePoint =
        entity.startsWith("&#x") || entity.startsWith("&#X")
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number.parseInt(entity.slice(2, -1), 10);
      return Number.isFinite(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );

// The generator emits double-quoted attributes only (verified), so these
// targeted regexes suffice — no general HTML parser.
const sanitizeHtml = (html: string): string =>
  html
    // Remote images are dropped wholesale: no dashboard fetches, no src abuse.
    .replaceAll(/<img\b[^>]*>/g, "")
    .replace(/\shref="([^"]*)"/g, (_match, href: string) => {
      const decoded = decodeEntities(href);
      let allowed = false;
      try {
        allowed = ALLOWED_PROTOCOLS.has(
          new URL(decoded).protocol.toLowerCase(),
        );
      } catch {
        allowed = false;
      }
      return ` href="${allowed ? Bun.escapeHTML(decoded) : "#"}"`;
    });

/**
 * Rendered, sanitized HTML for wrapped descriptions; null for plain text
 * or empty markdown bodies (those display as their raw source instead).
 */
export const renderDescription = (raw: string): string | null => {
  if (!isWrappedDescription(raw)) return null;
  const body = unwrapDescription(raw);
  // "{}"/"{ }" fall back to raw display rather than an empty document.
  if (!body) return null;
  return sanitizeHtml(Bun.markdown.html(body, MARKDOWN_OPTIONS));
};
