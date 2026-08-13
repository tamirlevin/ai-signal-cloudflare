import type { RssIssue, Source } from "./contracts";
import { ValidationError } from "./validation";

const MAX_RSS_BYTES = 8_000_000;

function decodeEntitiesOnce(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity] ?? _);
}

function firstTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match?.[1]) throw new ValidationError(`RSS is missing ${tag}`);
  return match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, "$1").trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Converts escaped or CDATA HTML to bounded context while preserving each decoded href exactly. */
export function anchorsToMarkdown(encodedHtml: string): { markdown: string; anchors: Source[] } {
  const anchors: Source[] = [];
  const html = /<a\b/i.test(encodedHtml) ? encodedHtml : decodeEntitiesOnce(encodedHtml);
  const markdown = html
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _quote: string, href: string, label: string) => {
      const url = decodeEntitiesOnce(href.trim());
      if (!/^https:\/\/[^\s]+$/i.test(url)) return stripTags(label);
      const source = { label: stripTags(decodeEntitiesOnce(label)) || "Read story", url };
      anchors.push(source);
      return `[${source.label}](${url})`;
    })
    .replace(/<\/?(?:p|div|h[1-6]|li|br|tr|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!anchors.length) throw new ValidationError("RSS issue contains no direct HTTPS story anchors");
  return { markdown: decodeEntitiesOnce(markdown).slice(0, 180_000), anchors };
}

export function parseLatestRss(xml: string): RssIssue {
  const item = xml.match(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/i)?.[1];
  if (!item) throw new ValidationError("RSS has no item");
  const url = decodeEntitiesOnce(firstTag(item, "link"));
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw new ValidationError("RSS issue link is not HTTPS");
  const pubDate = decodeEntitiesOnce(firstTag(item, "pubDate"));
  const rawBody = firstTag(item, "content:encoded");
  const { markdown, anchors } = anchorsToMarkdown(rawBody);
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) throw new ValidationError("RSS issue pubDate is invalid");
  const issueDate = date.toISOString().slice(0, 10);
  const publicationDate = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  return { url, issueDate, publicationDate, body: markdown, anchors };
}

export async function fetchLatestRss(url: string): Promise<RssIssue> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(url, { signal: timeout, headers: { Accept: "application/rss+xml, application/xml;q=0.9" } });
  if (!response.ok) throw new ValidationError(`RSS returned ${response.status}`);
  const size = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(size) && size > MAX_RSS_BYTES) throw new ValidationError("RSS response is too large");
  const xml = await response.text();
  if (xml.length > MAX_RSS_BYTES) throw new ValidationError("RSS response is too large");
  return parseLatestRss(xml);
}
