import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { actOnAsk, discussAsk, listAsks, type Action, type Ask, type PrState } from "../shared/asks";
import { Markdown, openLink } from "./Markdown";

export const POLL_MS = 4000;

const KIND_ICONS: Record<Ask["kind"], string> = {
  decision: "Split",
  review: "Eye",
  pr: "GitPullRequest",
  followup: "ListPlus",
  action: "Hand",
  question: "MessageCircle",
};

type Styles = ReturnType<typeof makeStyles>;

interface ViewProps {
  theme: PluginTheme;
  compact: boolean;
  /** Absent on the global screen: every workspace on this host. */
  workspaceId?: string;
  openAgent?: (agentId: string) => void;
}

export function useAsks(workspaceId?: string) {
  const list = useRpc(listAsks);
  return useQuery({
    queryKey: ["asks", workspaceId ?? "*"],
    queryFn: () => list({ workspaceId }),
    refetchInterval: POLL_MS,
  });
}

export function AsksView({ theme, compact, workspaceId, openAgent }: ViewProps) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const asks = useAsks(workspaceId);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (asks.isPending) return <Message styles={styles} text="Loading asks…" />;
  if (asks.isError) return <Message styles={styles} text={`Could not load asks: ${asks.error.message}`} danger />;
  const all = asks.data.asks;
  if (all.length === 0) return <Message styles={styles} text={workspaceId ? "Nothing waiting on you here." : "Nothing waiting on you."} />;

  const groups = workspaceId ? [[workspaceId, all] as const] : [...groupBy(all, (ask) => ask.workspaceId)];
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {groups.map(([groupId, items]) => (
        <View key={groupId} style={styles.group}>
          {!workspaceId && <Text style={styles.workspace}>{asks.data.workspaceNames?.[groupId] ?? groupId}</Text>}
          {(["open", "in_progress"] as const).map((status) => {
            const rows = items.filter((ask) => ask.status === status);
            if (rows.length === 0) return null;
            return (
              <View key={status} style={styles.section}>
                <Text style={styles.sectionTitle}>{status === "open" ? "NEEDS YOU" : "IN PROGRESS"}</Text>
                {rows.map((ask) => {
                  const key = `${ask.workspaceId}/${ask.id}`;
                  return (
                    <AskRow
                      key={key}
                      ask={ask}
                      styles={styles}
                      theme={theme}
                      expanded={expanded === key}
                      onToggle={() => setExpanded(expanded === key ? null : key)}
                      openAgent={openAgent}
                    />
                  );
                })}
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

function AskRow(props: {
  ask: Ask;
  styles: Styles;
  theme: PluginTheme;
  expanded: boolean;
  onToggle(): void;
  openAgent?: (agentId: string) => void;
}) {
  const { ask, styles, theme, expanded } = props;
  return (
    <View style={[styles.card, expanded && styles.cardExpanded]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ask.id}: ${ask.title}`}
        onPress={props.onToggle}
        style={styles.row}
      >
        <Icon name={KIND_ICONS[ask.kind]} size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.id}>{ask.id}</Text>
        <Text style={styles.title} numberOfLines={expanded ? undefined : 1}>
          {ask.title}
        </Text>
        {ask.pr && <PrBadge pr={ask.pr} styles={styles} />}
        {ask.orphaned && <Text style={styles.orphaned}>orphaned</Text>}
        <Text style={styles.age}>{age(ask.updatedAt)}</Text>
      </Pressable>
      {expanded && <AskDetail {...props} />}
    </View>
  );
}

function AskDetail({
  ask,
  styles,
  theme,
  openAgent,
}: {
  ask: Ask;
  styles: Styles;
  theme: PluginTheme;
  openAgent?: (agentId: string) => void;
}) {
  const act = useRpc(actOnAsk);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: (input: { verb: "action" | "done" | "drop" | "reply"; actionId?: string }) =>
      act({ workspaceId: ask.workspaceId, id: ask.id, note, ...input }),
    onSuccess: ({ notified }) => {
      setNote("");
      if (!notified) toast.show(`${ask.id} closed; its agent is gone, so nobody was told.`, { variant: "warning" });
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const startDiscussion = useRpc(discussAsk);
  const discussion = useMutation({
    mutationFn: () => startDiscussion({ workspaceId: ask.workspaceId, id: ask.id }),
    onSuccess: ({ agentId }) => {
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      openAgent?.(agentId);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const press = (action: Action) => {
    if (action.kind === "open" && action.url) return openLink(action.url);
    mutation.mutate({ verb: "action", actionId: action.id });
  };

  return (
    <View style={styles.detail}>
      {ask.body ? <Markdown source={ask.body} theme={theme} /> : null}
      {ask.links.map((link) => (
        <Pressable key={link.url} accessibilityRole="link" onPress={() => openLink(link.url)}>
          <Text style={styles.link}>{link.label} ↗</Text>
        </Pressable>
      ))}
      {ask.pr && <PrDetail pr={ask.pr} styles={styles} />}
      {ask.orphaned && (
        <Text style={styles.orphaned}>The agent that raised this is archived. Closing it here notifies nobody.</Text>
      )}
      {ask.status === "open" && ask.actions.length > 0 && (
        <View style={styles.buttons}>
          {ask.actions.map((action) => (
            <Button
              key={action.id}
              styles={styles}
              primary={action.recommended}
              disabled={mutation.isPending}
              label={`${action.label}${action.recommended ? " ★" : ""}${action.kind === "open" ? " ↗" : ""}`}
              onPress={() => press(action)}
            />
          ))}
        </View>
      )}
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Note or reply (optional)"
        placeholderTextColor={styles.placeholder.color}
        style={styles.input}
        multiline
      />
      <View style={styles.buttons}>
        <Button styles={styles} label="Reply" disabled={mutation.isPending || !note.trim()} onPress={() => mutation.mutate({ verb: "reply" })} />
        <Button styles={styles} label="Done" disabled={mutation.isPending} onPress={() => mutation.mutate({ verb: "done" })} />
        <Button styles={styles} label="Drop" disabled={mutation.isPending} onPress={() => mutation.mutate({ verb: "drop" })} />
        {!ask.orphaned && (
          <Button
            styles={styles}
            label={discussion.isPending ? "Opening…" : ask.discussionAgentId ? "Open discussion" : "Discuss"}
            disabled={discussion.isPending}
            onPress={() => discussion.mutate()}
          />
        )}
        {openAgent && <Button styles={styles} label="Open chat" onPress={() => openAgent(ask.ownerAgentId)} />}
      </View>
    </View>
  );
}

const PR_STATE: Record<PrState["state"], string> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };
const CHECKS: Record<PrState["checks"], string> = { passing: "checks ✓", failing: "checks ✗", pending: "checks …", none: "" };

function PrBadge({ pr, styles }: { pr: PrState; styles: Styles }) {
  const tone =
    pr.state === "CLOSED" || pr.checks === "failing"
      ? styles.bad
      : pr.state === "MERGED" || pr.checks === "passing"
        ? styles.good
        : styles.muted;
  const label = pr.state === "OPEN" ? (pr.isDraft ? "draft" : CHECKS[pr.checks] || "open") : PR_STATE[pr.state];
  return <Text style={[styles.badge, tone]}>{label}</Text>;
}

function PrDetail({ pr, styles }: { pr: PrState; styles: Styles }) {
  const parts = [
    `PR #${pr.number} ${pr.isDraft ? "draft" : PR_STATE[pr.state]}`,
    CHECKS[pr.checks],
    pr.reviewDecision ? pr.reviewDecision.toLowerCase().replace(/_/g, " ") : "no review decision",
    pr.state === "OPEN" && pr.mergeable === "CONFLICTING" ? "has conflicts" : "",
  ].filter(Boolean);
  return <Text style={styles.prDetail}>{parts.join(" · ")}</Text>;
}

function Button(props: { styles: Styles; label: string; onPress(): void; primary?: boolean; disabled?: boolean }) {
  const { styles } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, props.primary && styles.buttonPrimary, props.disabled && styles.buttonDisabled]}
    >
      <Text style={props.primary ? styles.buttonPrimaryText : styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

function Message({ styles, text, danger }: { styles: Styles; text: string; danger?: boolean }) {
  return (
    <View style={[styles.screen, styles.content]}>
      <Text style={danger ? styles.danger : styles.muted}>{text}</Text>
    </View>
  );
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 12 : 16, gap: 16 },
    group: { gap: 12 },
    section: { gap: 6 },
    workspace: { color: colors.foreground, fontSize: 15, fontWeight: "600" as const },
    sectionTitle: { color: colors.foregroundMuted, fontSize: 11, letterSpacing: 0.5 },
    card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1 },
    cardExpanded: { borderColor: colors.accent },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, padding: compact ? 12 : 10 },
    id: { color: colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    title: { color: colors.foreground, flex: 1, fontSize: 14 },
    age: { color: colors.foregroundMuted, fontSize: 12 },
    orphaned: { color: colors.statusWarning, fontSize: 12 },
    detail: { paddingHorizontal: compact ? 12 : 10, paddingBottom: 12, gap: 10 },
    link: { color: colors.accent, fontSize: 13 },
    buttons: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
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
      minHeight: 36,
      fontSize: 13,
    },
    placeholder: { color: colors.foregroundMuted },
    badge: { fontSize: 11 },
    good: { color: colors.statusSuccess },
    bad: { color: colors.statusDanger },
    prDetail: { color: colors.foregroundMuted, fontSize: 12 },
    muted: { color: colors.foregroundMuted },
    danger: { color: colors.statusDanger },
  };
}
