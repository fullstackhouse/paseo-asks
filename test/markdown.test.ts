import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../shared/markdown";

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

describe("markdown", () => {
  it("parses the shape of body agents write", () => {
    const blocks = parseMarkdown(BODY);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "code", "paragraph", "list", "paragraph"]);
    expect(blocks[2]).toEqual({ type: "code", lang: "ts", text: "res.cookie('cart', JSON.stringify(cart))" });
    const list = blocks[4]!;
    if (list.type !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(3);
    expect(list.items[0]![0]).toEqual({
      type: "strong",
      children: [
        { type: "code", text: "postgres" },
        { type: "text", text: " (recommended)." },
      ],
    });
    expect(list.items[1]!.at(-1)).toEqual({ type: "text", text: " One more service on call." });
  });

  it("links bare URLs without swallowing trailing punctuation", () => {
    const last = parseMarkdown(BODY).at(-1)!;
    if (last.type !== "paragraph") throw new Error("expected a paragraph");
    expect(last.inlines.at(-2)).toEqual({ type: "link", url: "https://github.com/acme/shop-api/pull/22", children: [{ type: "text", text: "https://github.com/acme/shop-api/pull/22" }] });
    expect(last.inlines.at(-1)).toEqual({ type: "text", text: "." });
  });

  it("handles emphasis, links, headings, numbered lists and quotes", () => {
    expect(parseInline("*a* and [the PR](https://x.y/1) and snake_case_name")).toEqual([
      { type: "em", children: [{ type: "text", text: "a" }] },
      { type: "text", text: " and " },
      { type: "link", url: "https://x.y/1", children: [{ type: "text", text: "the PR" }] },
      { type: "text", text: " and snake_case_name" },
    ]);
    expect(parseMarkdown("## Stake\n1. one\n2. two\n> quoted\n> more").map((block) => block.type)).toEqual(["heading", "list", "quote"]);
  });

  it("leaves unmatched markers as text", () => {
    expect(parseInline("2 * 3 = 6, a ** b, `open")).toEqual([{ type: "text", text: "2 * 3 = 6, a ** b, `open" }]);
  });
});
