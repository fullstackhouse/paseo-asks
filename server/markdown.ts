import type { BlockContent, DefinitionContent, Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Block, Inline } from "../shared/markdown";

const CACHE_LIMIT = 500;
const cache = new Map<string, Block[]>();

/** Ask body markdown → render blocks. Memoised: the client polls the same bodies over and over. */
export function toBlocks(source: string): Block[] {
  const hit = cache.get(source);
  if (hit) return hit;
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const blocks = tree.children.flatMap((node) => block(node, source));
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(source, blocks);
  return blocks;
}

function block(node: RootContent | BlockContent | DefinitionContent, source: string): Block[] {
  switch (node.type) {
    case "paragraph":
      return [{ type: "paragraph", inlines: inlines(node.children) }];
    case "heading":
      return [{ type: "heading", level: node.depth, inlines: inlines(node.children) }];
    case "blockquote":
      return [{ type: "quote", blocks: node.children.flatMap((child) => block(child, source)) }];
    case "list":
      return [
        {
          type: "list",
          ordered: Boolean(node.ordered),
          start: node.start ?? 1,
          items: node.children.map((item) => ({
            checked: item.checked ?? null,
            blocks: item.children.flatMap((child) => block(child, source)),
          })),
        },
      ];
    case "code":
      return [{ type: "code", lang: node.lang ?? "", text: node.value }];
    case "thematicBreak":
      return [{ type: "rule" }];
    case "table": {
      const [head, ...body] = node.children.map((row) => row.children.map((cell) => inlines(cell.children)));
      const header = head ?? [];
      return [
        {
          type: "table",
          align: header.map((_, column) => node.align?.[column] ?? null),
          header,
          rows: body.map((cells) => header.map((_, column) => cells[column] ?? [])),
        },
      ];
    }
    case "definition":
      return [];
    default:
      return [{ type: "raw", text: sourceOf(node, source) }];
  }
}

function inlines(nodes: PhrasingContent[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    switch (node.type) {
      case "text":
        return [{ type: "text", text: node.value }];
      case "inlineCode":
        return [{ type: "code", text: node.value }];
      case "break":
        return [{ type: "break" }];
      case "strong":
        return [{ type: "strong", children: inlines(node.children) }];
      case "emphasis":
        return [{ type: "em", children: inlines(node.children) }];
      case "delete":
        return [{ type: "del", children: inlines(node.children) }];
      case "link":
        return /^https?:\/\//.test(node.url)
          ? [{ type: "link", url: node.url, children: inlines(node.children) }]
          : inlines(node.children);
      case "image":
        return /^https?:\/\//.test(node.url)
          ? [{ type: "link", url: node.url, children: [{ type: "text", text: node.alt || node.url }] }]
          : [{ type: "text", text: node.alt ?? "" }];
      case "html":
        return [{ type: "text", text: node.value }];
      default:
        return "children" in node ? inlines(node.children) : [];
    }
  });
}

function sourceOf(node: Nodes, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}
