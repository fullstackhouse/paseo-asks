// Ask bodies are parsed on the server with a full GFM parser (server/markdown.ts) and sent to the
// client as these blocks: plugin client code can import only host modules, so it renders, never parses.
import { z } from "zod";

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "break" }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; url: string; children: Inline[] };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "heading"; level: number; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "rule" }
  /** Markdown the renderer has no block for, shown as its source so nothing is mangled. */
  | { type: "raw"; text: string };

export type ListItem = { checked: boolean | null; blocks: Block[] };

const InlineSchema: z.ZodType<Inline> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("code"), text: z.string() }),
    z.object({ type: z.literal("break") }),
    z.object({ type: z.enum(["strong", "em", "del"]), children: z.array(InlineSchema) }),
    z.object({ type: z.literal("link"), url: z.string(), children: z.array(InlineSchema) }),
  ]),
);

export const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("heading"), level: z.number(), inlines: z.array(InlineSchema) }),
    z.object({ type: z.literal("paragraph"), inlines: z.array(InlineSchema) }),
    z.object({ type: z.literal("quote"), blocks: z.array(BlockSchema) }),
    z.object({
      type: z.literal("list"),
      ordered: z.boolean(),
      start: z.number(),
      items: z.array(z.object({ checked: z.boolean().nullable(), blocks: z.array(BlockSchema) })),
    }),
    z.object({ type: z.literal("code"), lang: z.string(), text: z.string() }),
    z.object({
      type: z.literal("table"),
      align: z.array(z.enum(["left", "center", "right"]).nullable()),
      header: z.array(z.array(InlineSchema)),
      rows: z.array(z.array(z.array(InlineSchema))),
    }),
    z.object({ type: z.literal("rule") }),
    z.object({ type: z.literal("raw"), text: z.string() }),
  ]),
);
