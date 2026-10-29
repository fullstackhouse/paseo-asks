import { describe, expect, it } from "vitest";
import { toBlocks } from "../server/markdown";
import type { Block, Inline } from "../shared/markdown";

const BODY = `**Why decide now:** the rework writes the cart on every click, and the choice shapes the interface (\`CartStore\`, \`carts.ttl\`, ...).

**What's true today:** carts live in the session cookie, capped at 4 KB. So a write looks like:
\`\`\`ts
res.cookie('cart', JSON.stringify(cart))
\`\`\`

**Options:**
- **\`postgres\` (recommended).** Already running and transactional with orders.
- **\`redis\` (fastest writes).** One more service
  on call.
- **\`cookie\`.** No work.

After this I'll ask about the \`carts.ttl\` default. See https://github.com/acme/shop-api/pull/22.`;

/** Shapes agents put in real ask bodies; each once rendered as mangled text. */
const REAL_SHAPES: Record<string, string> = {
  table: "**Rule:** party holds identity.\n| Data | Home |\n|---|---|\n| Tags | customers |",
  nestedList: "- **Party**\n  - addresses\n  - identifiers\n- **Customer**\n  1. status\n  2. owner",
  multiParagraphItem: "1. First option\n\n   It costs a day.\n\n2. Second option",
  rule: "Context.\n\n---\n\nDecision.",
  taskList: "- [x] migration written\n- [ ] backfill run",
  boldNumberedLabel: "**1. Unit change (major).** Shipped quantities keep no unit.",
  html: "Rows<br>wrap\n\n<details><summary>Log</summary>\n\nlong\n\n</details>",
};

const LEFTOVER_SYNTAX = /^\s*([-*+]|\d+[.)])\s|\|\s*:?-{3}|^\s*(-{3,}|\*{3,})\s*$|^\s*>\s/m;

/** Plain text of a paragraph; emphasis keeps a marker so a bold "**1. Label**" isn't mistaken for a list. */
function text(inlines: Inline[]): string {
  return inlines
    .map((node) => {
      if (node.type === "text" || node.type === "code") return node.text;
      if (node.type === "break") return "\n";
      return node.type === "link" ? text(node.children) : `*${text(node.children)}*`;
    })
    .join("");
}

function paragraphs(blocks: Block[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "paragraph") return [text(block.inlines)];
    if (block.type === "quote") return paragraphs(block.blocks);
    if (block.type === "list") return block.items.flatMap((item) => paragraphs(item.blocks));
    return [];
  });
}

describe("markdown", () => {
  it("parses the shape of body agents write", () => {
    const blocks = toBlocks(BODY);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "code", "paragraph", "list", "paragraph"]);
    expect(blocks[2]).toEqual({ type: "code", lang: "ts", text: "res.cookie('cart', JSON.stringify(cart))" });
    const list = blocks[4]!;
    if (list.type !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(3);
    const first = list.items[0]!.blocks[0]!;
    if (first.type !== "paragraph") throw new Error("expected a paragraph");
    expect(first.inlines[0]).toEqual({
      type: "strong",
      children: [
        { type: "code", text: "postgres" },
        { type: "text", text: " (recommended)." },
      ],
    });
  });

  it("links bare URLs without swallowing trailing punctuation", () => {
    const last = toBlocks(BODY).at(-1)!;
    if (last.type !== "paragraph") throw new Error("expected a paragraph");
    expect(last.inlines.at(-2)).toEqual({ type: "link", url: "https://github.com/acme/shop-api/pull/22", children: [{ type: "text", text: "https://github.com/acme/shop-api/pull/22" }] });
    expect(last.inlines.at(-1)).toEqual({ type: "text", text: "." });
  });

  it("parses tables with alignment, inline formatting, escaped pipes and short rows", () => {
    const [table] = toBlocks("| Data | Home | Why |\n|---|:---:|--:|\n| **Tags** | customers | `a\\|b` |\n| Addresses | party |");
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.align).toEqual([null, "center", "right"]);
    expect(table.rows[0]![0]).toEqual([{ type: "strong", children: [{ type: "text", text: "Tags" }] }]);
    expect(table.rows[0]![2]).toEqual([{ type: "code", text: "a|b" }]);
    expect(table.rows[1]![2]).toEqual([]);
  });

  it("keeps list hierarchy and task state", () => {
    const [list] = toBlocks(REAL_SHAPES.nestedList!);
    if (list?.type !== "list") throw new Error("expected a list");
    expect(list.items[1]!.blocks[1]).toMatchObject({ type: "list", ordered: true, start: 1 });
    const [tasks] = toBlocks(REAL_SHAPES.taskList!);
    if (tasks?.type !== "list") throw new Error("expected a list");
    expect(tasks.items.map((item) => item.checked)).toEqual([true, false]);
  });

  it("only links http(s) URLs", () => {
    expect(toBlocks("[local](./x) and [web](https://x.y)")).toEqual([
      { type: "paragraph", inlines: [{ type: "text", text: "local" }, { type: "text", text: " and " }, { type: "link", url: "https://x.y", children: [{ type: "text", text: "web" }] }] },
    ]);
  });

  it.each(Object.entries(REAL_SHAPES))("renders %s without leftover markdown syntax", (_, body) => {
    for (const paragraph of paragraphs(toBlocks(body))) expect(paragraph).not.toMatch(LEFTOVER_SYNTAX);
  });
});
