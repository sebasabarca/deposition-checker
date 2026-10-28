// Reads a DOJ HTML deposition transcript into page:line source lines.
// The DOJ pages render each transcript line as a table row:
//   <tr><td colspan="2">00009</td></tr>                 printed page marker
//   <tr><td align="right">14</td><td>BY MR. SCOTT:</td></tr>   numbered line
//   <tr><td align="right">&nbsp;</td><td>&nbsp;</td></tr>      redacted or blank line

export type SourceLine = { page: number; line: number; text: string };

export type HtmlReadResult = {
  lines: SourceLine[];
  pages: number[];
  // Rows that have text but no line number, or a line number outside 1..25.
  anomalies: { page: number | null; row: string }[];
};

const PAGE_MARKER = /<td colspan="2">\s*(\d{3,6})\s*<\/td>/;
const NUMBERED_ROW = /<td align="right">([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>/;

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
};

export function decodeEntities(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function readHtmlTranscript(html: string): HtmlReadResult {
  const lines: SourceLine[] = [];
  const pages: number[] = [];
  const anomalies: HtmlReadResult["anomalies"] = [];
  let page: number | null = null;

  for (const row of html.split(/<tr\b[^>]*>/).slice(1)) {
    const marker = row.match(PAGE_MARKER);
    if (marker) {
      page = Number(marker[1]);
      pages.push(page);
      continue;
    }
    const cells = row.match(NUMBERED_ROW);
    if (!cells) continue;

    const number = decodeEntities(cells[1]).trim();
    const text = decodeEntities(cells[2].replace(/<[^>]+>/g, "")).replace(/\s+$/, "");
    if (!number) {
      if (text.trim()) anomalies.push({ page, row: text.trim() });
      continue;
    }
    const line = Number(number);
    if (page === null || !Number.isInteger(line) || line < 1 || line > 25) {
      anomalies.push({ page, row: `${number} ${text.trim()}` });
      continue;
    }
    lines.push({ page, line, text });
  }

  return { lines, pages, anomalies };
}
