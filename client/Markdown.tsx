import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Fragment, useMemo, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { parseMarkdown, type Inline } from "../shared/markdown";

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
        }
      })}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

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
    codeBlockText: { fontFamily: MONO, fontSize: 12, lineHeight: 18, color: colors.foreground },
  };
}
