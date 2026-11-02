// A preview of how a text transcript will be read, shown before upload. The server's text reader
// decides for real; this only tells the reviewer what to expect.

const NUMBERED_LINE = /^\s*\d{1,2}(?:\s{1,}|$)/;
const PAGE_MARK = /^\s*(?:page\s+)?\d{1,5}\s*$/i;

export function describeText(text: string) {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const content = rows.filter((r) => r.trim());
  const numbered = content.filter((r) => NUMBERED_LINE.test(r)).length;
  const isNumbered = content.length > 0 && numbered / content.length >= 0.6;
  // A page restarts its line numbers at 1, so the 1s count the pages.
  const pages = isNumbered ? Math.max(content.filter((r) => /^\s*1(?:\s|$)/.test(r)).length, 1) : 0;
  return { lines: isNumbered ? numbered : content.filter((r) => !PAGE_MARK.test(r)).length, numbered: isNumbered, pages };
}
