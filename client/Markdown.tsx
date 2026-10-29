import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { parseMarkdown, type Block, type Inline } from "../shared/markdown";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

export function openLink(url: string): void {
  void openExternalUrl(url).catch((error) => console.error("[asks] could not open", url, error));
}

export function Markdown({ source, theme }: { source: string; theme: PluginTheme }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return (
              <Text key={index} style={[styles.text, styles.heading]} selectable>
                {inlines(block.inlines, styles)}
              </Text>
            );
          case "paragraph":
            return (
              <Text key={index} style={styles.text} selectable>
                {inlines(block.inlines, styles)}
              </Text>
            );
          case "quote":
            return (
              <View key={index} style={styles.quote}>
                <Text style={[styles.text, styles.muted]} selectable>
                  {inlines(block.inlines, styles)}
                </Text>
              </View>
            );
          case "list":
            return (
              <View key={index} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={styles.item}>
                    <Text style={[styles.text, styles.marker]}>{block.ordered ? `${block.start + itemIndex}.` : "•"}</Text>
                    <Text style={[styles.text, styles.itemText]} selectable>
                      {inlines(item, styles)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "code":
            return (
              <ScrollView key={index} horizontal style={styles.codeBlock} contentContainerStyle={styles.codeContent}>
                <Text style={styles.codeBlockText} selectable>
                  {block.text}
                </Text>
              </ScrollView>
            );
          case "table":
            return <Table key={index} block={block} styles={styles} />;
        }
      })}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;
type TableBlock = Extract<Block, { type: "table" }>;

/** Columns share the card's width (short ones keep their natural width) so rows line up; a table too wide even then scrolls sideways. */
function Table({ block, styles }: { block: TableBlock; styles: Styles }) {
  const [available, setAvailable] = useState(0);
  const natural = block.header.map((cell, column) => {
    const longest = Math.max(plainLength(cell), ...block.rows.map((row) => plainLength(row[column] ?? [])));
    return longest * CHAR_WIDTH + CELL_PADDING;
  });
  const widths = fitColumns(natural, available - 2);
  const row = (cells: Inline[][], rowIndex: number, header: boolean) => (
    <View key={rowIndex} style={[styles.tableRow, rowIndex > 0 || !header ? styles.tableRowBorder : null]}>
      {cells.map((cell, column) => (
        <View key={column} style={[styles.tableCell, { width: widths[column] }]}>
          <Text style={[styles.text, header ? styles.strong : null, { textAlign: block.align[column] ?? "left" }]} selectable>
            {inlines(cell, styles)}
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal style={styles.table} onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
      <View>
        {row(block.header, 0, true)}
        {block.rows.map((cells, rowIndex) => row(cells, rowIndex, false))}
      </View>
    </ScrollView>
  );
}

const CHAR_WIDTH = 7;
const CELL_PADDING = 16;
const MIN_COLUMN = 72;

/** Water-fill: columns narrower than an equal share keep their width, the rest split what is left. */
function fitColumns(natural: number[], available: number): number[] {
  if (available <= 0) return natural.map((width) => Math.min(Math.max(width, MIN_COLUMN), 260));
  const widths: Array<number | null> = natural.map(() => null);
  let remaining = available;
  let open = natural.length;
  for (let settled = true; settled && open > 0; ) {
    settled = false;
    const share = remaining / open;
    natural.forEach((width, column) => {
      if (widths[column] === null && width <= share) {
        widths[column] = width;
        remaining -= width;
        open--;
        settled = true;
      }
    });
  }
  const share = open > 0 ? remaining / open : 0;
  const filled = widths.map((width) => Math.max(width ?? share, MIN_COLUMN));
  const total = filled.reduce((sum, width) => sum + width, 0);
  return total < available ? filled.map((width) => width * (available / total)) : filled;
}

function plainLength(nodes: Inline[]): number {
  return nodes.reduce((sum, node) => sum + (node.type === "text" || node.type === "code" ? node.text.length : plainLength(node.children)), 0);
}

function inlines(nodes: Inline[], styles: Styles): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "code":
        return (
          <Text key={index} style={styles.code}>
            {node.text}
          </Text>
        );
      case "strong":
        return (
          <Text key={index} style={styles.strong}>
            {inlines(node.children, styles)}
          </Text>
        );
      case "em":
        return (
          <Text key={index} style={styles.em}>
            {inlines(node.children, styles)}
          </Text>
        );
      case "link":
        return (
          <Text key={index} style={styles.link} accessibilityRole="link" onPress={() => openLink(node.url)}>
            {inlines(node.children, styles)}
          </Text>
        );
    }
  });
}

function makeStyles(theme: PluginTheme) {
  const { colors } = theme;
  return {
    root: { gap: 8 },
    text: { color: colors.foreground, fontSize: 13, lineHeight: 20 },
    heading: { fontSize: 14, fontWeight: "600" as const },
    muted: { color: colors.foregroundMuted },
    strong: { fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    link: { color: colors.accent, textDecorationLine: "underline" as const },
    code: { fontFamily: MONO, fontSize: 12, color: colors.foreground, backgroundColor: colors.surface2 },
    quote: { borderLeftWidth: 3, borderColor: colors.border, paddingLeft: 10 },
    list: { gap: 4 },
    item: { flexDirection: "row" as const, gap: 6 },
    marker: { color: colors.foregroundMuted, minWidth: 14 },
    itemText: { flex: 1 },
    codeBlock: { backgroundColor: colors.surface2, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    codeContent: { padding: 10 },
    table: { borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    tableRow: { flexDirection: "row" as const },
    tableRowBorder: { borderTopWidth: 1, borderColor: colors.border },
    tableCell: { paddingHorizontal: 8, paddingVertical: 4 },
    codeBlockText: { fontFamily: MONO, fontSize: 12, lineHeight: 18, color: colors.foreground },
  };
}
