import type { PluginTheme } from "@getpaseo/plugin";
import { Platform, Pressable, Text } from "react-native";

export type Styles = ReturnType<typeof makeStyles>;

export function Button(props: {
  styles: Styles;
  label: string;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
}) {
  const { styles } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.button,
        props.primary && styles.buttonPrimary,
        props.disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={props.primary ? styles.buttonPrimaryText : styles.buttonText}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 12 : 16, gap: 16 },
    queueContent: { paddingHorizontal: compact ? 12 : 32, paddingVertical: compact ? 16 : 24 },
    queueWidth: { width: "100%" as const, maxWidth: 960, alignSelf: "center" as const },
    filters: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
    filter: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: compact ? 10 : 14,
      minHeight: compact ? 44 : 36,
      borderRadius: 6,
    },
    filterSelected: { backgroundColor: colors.surface2 },
    filterText: { color: colors.foregroundMuted, fontSize: 14 },
    filterTextSelected: { color: colors.foreground },
    filterCount: {
      color: colors.foregroundMuted,
      fontSize: 12,
      fontVariant: ["tabular-nums" as const],
    },
    queueDescription: {
      color: colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 20,
      marginTop: 12,
      marginBottom: 24,
    },
    queueList: { borderTopWidth: 1, borderTopColor: colors.border },
    queueItem: { borderBottomWidth: 1, borderBottomColor: colors.border },
    queueRow: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 12,
      paddingHorizontal: compact ? 8 : 12,
      paddingVertical: 16,
    },
    queuePressed: { backgroundColor: colors.surface1 },
    queueIcon: { paddingTop: 2 },
    queueText: { flex: 1, minWidth: 0, gap: 8 },
    queueTitle: { color: colors.foreground, fontSize: 14, lineHeight: 21 },
    queueMeta: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    queueWorkspace: {
      color: colors.foregroundMuted,
      fontSize: 12,
      flexShrink: 1,
      maxWidth: "100%" as const,
    },
    queueDetail: {
      paddingLeft: compact ? 0 : 28,
      paddingRight: compact ? 0 : 12,
      paddingBottom: 8,
    },
    queueEmpty: { flexDirection: "row" as const, gap: 12, paddingVertical: 24 },
    queueEmptyText: { color: colors.foregroundMuted, fontSize: 14, lineHeight: 21, flex: 1 },
    // The host popover already pads, scrolls and caps the size (420×440); sizing it here again clips it.
    popover: { gap: 8 },
    inline: { gap: 6, paddingVertical: 4 },
    group: { gap: 12 },
    section: { gap: 6 },
    workspace: { color: colors.foreground, fontSize: 15, fontWeight: "600" as const },
    sectionTitle: { color: colors.foregroundMuted, fontSize: 11, letterSpacing: 0.5 },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface1,
    },
    cardExpanded: { borderColor: colors.accent },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      padding: compact ? 12 : 10,
    },
    id: { color: colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    title: { color: colors.foreground, flex: 1, fontSize: 14 },
    age: { color: colors.foregroundMuted, fontSize: 12 },
    orphaned: { color: colors.statusWarning, fontSize: 12 },
    detail: { paddingHorizontal: compact ? 12 : 10, paddingBottom: 12, gap: 10 },
    link: { color: colors.accent, fontSize: 13 },
    buttons: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, flex: 1 },
    actionRow: { flexDirection: "row" as const, alignItems: "flex-end" as const, gap: 8 },
    replyRow: { flexDirection: "row" as const, alignItems: "flex-end" as const, gap: 8 },
    replyField: { flex: 1, flexDirection: "row" as const, alignItems: "flex-end" as const },
    send: {
      position: "absolute" as const,
      right: 6,
      bottom: 6,
      padding: 6,
      borderRadius: 6,
      backgroundColor: colors.accent,
    },
    fallback: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
    fallbackItem: { paddingVertical: compact ? 10 : 6, paddingHorizontal: 8 },
    fallbackText: { color: colors.foregroundMuted, fontSize: 13 },
    fallbackDestructive: { color: colors.statusDanger },
    button: {
      paddingVertical: compact ? 10 : 6,
      paddingHorizontal: 12,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
    },
    buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: colors.foreground, fontSize: 13 },
    buttonPrimaryText: { color: colors.accentForeground, fontSize: 13 },
    input: {
      color: colors.foreground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      padding: 8,
      paddingRight: 40,
      minHeight: 36,
      maxHeight: 132,
      flex: 1,
      fontSize: 13,
    },
    placeholder: { color: colors.foregroundMuted },
    badge: { fontSize: 11 },
    good: { color: colors.statusSuccess },
    bad: { color: colors.statusDanger },
    prDetail: { color: colors.foregroundMuted, fontSize: 12 },
    chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      maxWidth: "100%" as const,
      paddingVertical: compact ? 6 : 3,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
    },
    chipText: { fontSize: 12 },
    option: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingVertical: compact ? 10 : 8,
      paddingHorizontal: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
    },
    optionSelected: { borderColor: colors.accent },
    optionText: { flex: 1, minWidth: 0, gap: 2 },
    optionLabel: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
    optionDescription: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    optionPreview: {
      color: colors.foregroundMuted,
      fontSize: 12,
      fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    },
    muted: { color: colors.foregroundMuted },
    danger: { color: colors.statusDanger },
  };
}
