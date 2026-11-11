import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { AsksMessage as AsksMessageData } from "../shared/messages";

/**
 * An `[asks]` message as the human reads it: a bubble like their own message, headed by the ask it answers.
 * The agent still receives the full text with its instructions.
 */
export function AsksMessage({ theme, askId, title, event, note }: { theme: PluginTheme } & AsksMessageData) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // A reply is the human's words alone; any other event leads with what happened.
  const lead = event === "replied" ? null : event;
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <View style={styles.head}>
          <Icon name="MessageCircleQuestionMark" size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.headText} numberOfLines={1}>
            {askId ? `${askId}${title ? ` · ${title}` : ""}` : "Asks"}
          </Text>
        </View>
        {lead && <Text style={note ? styles.event : styles.text}>{lead}</Text>}
        {note && <Text style={styles.text}>{note}</Text>}
      </View>
    </View>
  );
}

function makeStyles({ colors }: PluginTheme) {
  return StyleSheet.create({
    row: { flexDirection: "row", justifyContent: "flex-end", marginVertical: 16 },
    bubble: {
      backgroundColor: colors.surface2,
      borderRadius: 16,
      borderTopRightRadius: 4,
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 6,
      flexShrink: 1,
      minWidth: 0,
    },
    head: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    headText: { color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    event: { color: colors.foregroundMuted, fontSize: 13 },
    text: { color: colors.foreground, fontSize: 15, lineHeight: 21 },
  });
}
