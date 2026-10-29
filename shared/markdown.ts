// The markdown agents write in asks: headings, paragraphs, lists, quotes, fenced code, GFM tables,
// and inline bold/italic/code/links. Plugin client code can only import host modules, so no library.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em"; children: Inline[] }
  | { type: "link"; url: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: number; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "quote"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] };

export type Align = "left" | "center" | "right" | null;

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  const startsTable = (at: number) => {
    const header = lines[at];
    const delimiter = lines[at + 1];
    if (header === undefined || delimiter === undefined || !header.includes("|") || !TABLE_DELIMITER.test(delimiter)) return false;
    return splitRow(header).length === splitRow(delimiter).length;
  };
  const startsBlock = (at: number) => {
    const line = lines[at]!;
    return FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line) || startsTable(at);
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!)) body.push(lines[index++]!);
      index++; // closing fence, or past the end when it is missing
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (startsTable(index)) {
      const header = splitRow(line);
      const align = splitRow(lines[index + 1]!).map(cellAlign);
      index += 2;
      const rows: Inline[][][] = [];
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) {
        const cells = splitRow(lines[index++]!);
        rows.push(header.map((_, column) => parseInline(cells[column] ?? "")));
      }
      blocks.push({ type: "table", align, header: header.map(parseInline), rows });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, inlines: parseInline(heading[2]!) });
      index++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) body.push(lines[index++]!.match(QUOTE)![1]!);
      blocks.push({ type: "quote", inlines: parseInline(body.join(" ")) });
      continue;
    }
    const numbered = line.match(NUMBERED);
    if (BULLET.test(line) || numbered) {
      const ordered = Boolean(numbered);
      const marker = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const item = current.match(marker);
        if (item) items.push(item[ordered ? 2 : 1]!);
        else if (current.trim() && !startsBlock(index) && /^\s+/.test(current) && items.length) {
          items[items.length - 1] += ` ${current.trim()}`; // an indented continuation line
        } else break;
        index++;
      }
      blocks.push({ type: "list", ordered, start: ordered ? Number(numbered![1]) : 1, items: items.map(parseInline) });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index]!.trim() && (body.length === 0 || !startsBlock(index))) {
      body.push(lines[index++]!.trim());
    }
    blocks.push({ type: "paragraph", inlines: parseInline(body.join(" ")) });
  }
  return blocks;
}

/** A table row's cells, honouring `\|` and pipes inside code spans. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  const text = line.trim().replace(/^\|/, "");
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && text[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  if (cell.trim() || !text.endsWith("|")) cells.push(cell.trim());
  return cells;
}

function cellAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

const URL_CHARS = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length && /[\\`*_[\]()#>-]/.test(text[index + 1]!)) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        out.push({ type: "code", text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const end = closing(text, index + 2, rest.slice(0, 2));
      if (end > index + 2) {
        flush();
        out.push({ type: "strong", children: parseInline(text.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }
    if ((char === "*" || char === "_") && text[index + 1] !== " " && !(char === "_" && /\w/.test(text[index - 1] ?? ""))) {
      const end = closing(text, index + 1, char);
      if (end > index + 1 && text[end - 1] !== " " && !(char === "_" && /\w/.test(text[end + 1] ?? ""))) {
        flush();
        out.push({ type: "em", children: parseInline(text.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const link = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
      if (link) {
        flush();
        out.push({ type: "link", url: link[2]!, children: parseInline(link[1]!) });
        index += link[0].length;
        continue;
      }
    }
    if (char === "h" && !/\w/.test(text[index - 1] ?? "")) {
      const url = rest.match(URL_CHARS);
      if (url) {
        flush();
        out.push({ type: "link", url: url[0], children: [{ type: "text", text: url[0] }] });
        index += url[0].length;
        continue;
      }
    }
    plain += char;
    index++;
  }
  flush();
  return out;
}

/** The index of the closing delimiter, skipping over inline code spans. */
function closing(text: string, from: number, delimiter: string): number {
  for (let index = from; index < text.length; index++) {
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index) index = end;
      continue;
    }
    if (text.startsWith(delimiter, index)) {
      if (delimiter.length === 1 && text[index + 1] === delimiter) {
        index++; // part of a ** pair, not our closer
        continue;
      }
      return index;
    }
  }
  return -1;
}
