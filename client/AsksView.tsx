import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import {
  actOnAsk,
  discussAsk,
  listAsks,
  prLinkOf,
  refreshAsks,
  type Action,
  type Ask,
  type PrState,
} from "../shared/asks";
import { displaySettings } from "../shared/settings";
import type { AskCard as AskCardData } from "../shared/timeline";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { OpenPrContext } from "./inbox";
import { openLink } from "./open-link";
import { askQueue, type QueueFilter } from "./queue";
import { useSnoozedWorkspaceIds } from "./snoozed";

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

export function useAsks(workspaceId?: string, includeClosed = false) {
  const list = useRpc(listAsks);
  return useQuery({
    queryKey: ["asks", workspaceId ?? "*", includeClosed ? "all" : "open"],
    queryFn: () => list({ workspaceId, includeClosed }),
    refetchInterval: POLL_MS,
  });
}

export function AsksView(props: ViewProps) {
  return props.workspaceId ? <WorkspaceAsks {...props} /> : <MainAsks {...props} />;
}

const FILTERS: { id: QueueFilter; label: string; description: string; empty: string }[] = [
  {
    id: "needs_you",
    label: "Needs you",
    description: "Decisions and actions waiting on you.",
    empty: "Nothing waiting on you. In-progress work and other asks are in their own views.",
  },
  {
    id: "in_progress",
    label: "In progress",
    description: "Work agents are already handling.",
    empty: "No asks in progress.",
  },
  {
    id: "other",
    label: "Other",
    description: "Asks from snoozed workspaces or linked to merged or closed PRs.",
    empty: "No other open asks.",
  },
];

function MainAsks({ theme, compact, openAgent }: ViewProps) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const asks = useAsks();
  const snoozed = useSnoozedWorkspaceIds();
  const [filter, setFilter] = useState<QueueFilter>("needs_you");
  const [expanded, setExpanded] = useState<string | null>(null);
  const queue = useMemo(() => askQueue(asks.data?.asks ?? [], snoozed), [asks.data, snoozed]);
  const selected = FILTERS.find((item) => item.id === filter)!;

  if (asks.isPending) return <Message styles={styles} text="Loading asks…" />;
  if (asks.isError)
    return <Message styles={styles} text={`Could not load asks: ${asks.error.message}`} danger />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.queueContent}>
      <View style={styles.queueWidth}>
        <View style={styles.filters}>
          {FILTERS.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`${item.label}, ${queue[item.id].length} asks`}
              accessibilityState={{ selected: filter === item.id }}
              onPress={() => {
                setFilter(item.id);
                setExpanded(null);
              }}
              style={({ pressed }) => [
                styles.filter,
                filter === item.id && styles.filterSelected,
                pressed && styles.queuePressed,
              ]}
            >
              <Text style={[styles.filterText, filter === item.id && styles.filterTextSelected]}>
                {item.label}
              </Text>
              <Text style={[styles.filterCount, filter === item.id && styles.filterTextSelected]}>
                {queue[item.id].length}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.queueDescription}>{selected.description}</Text>
        {queue[filter].length === 0 ? (
          <View style={styles.queueEmpty}>
            <Icon
              name={filter === "needs_you" ? "Check" : "MessageCircleQuestionMark"}
              size={20}
              color={theme.colors.foregroundMuted}
            />
            <Text style={styles.queueEmptyText}>{selected.empty}</Text>
          </View>
        ) : (
          <View style={styles.queueList}>
            {queue[filter].map((ask) => {
              const key = `${ask.workspaceId}/${ask.id}`;
              return (
                <QueueRow
                  key={key}
                  ask={ask}
                  workspaceName={asks.data.workspaceNames?.[ask.workspaceId] ?? ask.workspaceId}
                  snoozed={snoozed.has(ask.workspaceId)}
                  styles={styles}
                  theme={theme}
                  expanded={expanded === key}
                  onToggle={() => setExpanded(expanded === key ? null : key)}
                  openAgent={openAgent}
                />
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function QueueRow(props: {
  ask: Ask;
  workspaceName: string;
  snoozed: boolean;
  styles: Styles;
  theme: PluginTheme;
  expanded: boolean;
  onToggle(): void;
  openAgent?: (agentId: string) => void;
}) {
  const { ask, workspaceName, snoozed, styles, theme, expanded } = props;
  const [hovered, setHovered] = useState(false);
  return (
    <View style={styles.queueItem}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ask.title}, ${workspaceName}`}
        accessibilityHint="Show details and actions"
        accessibilityState={{ expanded }}
        onPress={props.onToggle}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => [
          styles.queueRow,
          (hovered || pressed || expanded) && styles.queuePressed,
        ]}
      >
        <View style={styles.queueIcon}>
          <Icon name={KIND_ICONS[ask.kind]} size={16} color={theme.colors.foregroundMuted} />
        </View>
        <View style={styles.queueText}>
          <Text style={styles.queueTitle}>{ask.title}</Text>
          <View style={styles.queueMeta}>
            <Text style={styles.queueWorkspace} numberOfLines={1}>
              {workspaceName}
            </Text>
            <Text style={styles.id}>{ask.id}</Text>
            <Text style={styles.age}>{age(ask.updatedAt)}</Text>
            {ask.pr && <PrBadge pr={ask.pr} styles={styles} />}
            {snoozed && <Text style={styles.age}>Snoozed</Text>}
            {ask.orphaned && <Text style={styles.orphaned}>Agent archived</Text>}
          </View>
        </View>
        <View style={styles.queueIcon}>
          <Icon
            name={expanded ? "ChevronUp" : "ChevronDown"}
            size={16}
            color={theme.colors.foregroundMuted}
          />
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.queueDetail}>
          <AskDetail {...props} actionsFirst />
        </View>
      )}
    </View>
  );
}

function WorkspaceAsks({ theme, compact, workspaceId, openAgent }: ViewProps) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const asks = useAsks(workspaceId);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (asks.isPending) return <Message styles={styles} text="Loading asks…" />;
  if (asks.isError)
    return <Message styles={styles} text={`Could not load asks: ${asks.error.message}`} danger />;
  const all = asks.data.asks;
  if (all.length === 0)
    return (
      <Message
        styles={styles}
        text={workspaceId ? "Nothing waiting on you here." : "Nothing waiting on you."}
      />
    );

  const groups = workspaceId
    ? [[workspaceId, all] as const]
    : [...groupBy(all, (ask) => ask.workspaceId)];
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {groups.map(([groupId, items]) => (
        <View key={groupId} style={styles.group}>
          {!workspaceId && (
            <Text style={styles.workspace}>{asks.data.workspaceNames?.[groupId] ?? groupId}</Text>
          )}
          <StatusSections
            asks={items}
            styles={styles}
            renderRow={(ask) => {
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
            }}
          />
        </View>
      ))}
    </ScrollView>
  );
}

/** Splits asks into what waits on the human and what the agent is already doing. */
function StatusSections({
  asks,
  styles,
  renderRow,
}: {
  asks: Ask[];
  styles: Styles;
  renderRow: (ask: Ask) => ReactNode;
}) {
  return (
    <>
      {(["open", "in_progress"] as const).map((status) => {
        const rows = asks.filter((ask) => ask.status === status);
        if (rows.length === 0) return null;
        return (
          <View key={status} style={styles.section}>
            <Text style={styles.sectionTitle}>
              {status === "open" ? "NEEDS YOU" : "IN PROGRESS"}
            </Text>
            {rows.map(renderRow)}
          </View>
        );
      })}
    </>
  );
}

/** The workspace's asks, this agent's first, and a Refresh that asks this agent to bring its own up to date, for the composer pill's side panel. */
export function AgentAsks(props: {
  theme: PluginTheme;
  compact: boolean;
  workspaceId: string;
  agentId: string;
  openAgent?: (agentId: string) => void;
}) {
  const { theme, compact, workspaceId, agentId, openAgent } = props;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const asks = useAsks(workspaceId);
  const [expanded, setExpanded] = useState<string | null>(null);
  const refresh = useRpc(refreshAsks);
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => refresh({ agentId }),
    onSuccess: ({ sent }) =>
      toast.show(
        sent
          ? "Asked the agent to update its asks."
          : "The agent will update its asks when its turn ends.",
      ),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  if (asks.isPending) return <Message styles={styles} text="Loading asks…" />;
  if (asks.isError)
    return <Message styles={styles} text={`Could not load asks: ${asks.error.message}`} danger />;
  const own = (ask: Ask) => (ask.ownerAgentId === agentId ? 0 : 1);
  const ordered = [...asks.data.asks].sort((a, b) => own(a) - own(b));
  return (
    <View style={styles.popover}>
      {ordered.length === 0 && <Text style={styles.muted}>No open asks in this workspace.</Text>}
      <StatusSections
        asks={ordered}
        styles={styles}
        renderRow={(ask) => (
          <AskRow
            key={ask.id}
            ask={ask}
            styles={styles}
            theme={theme}
            expanded={expanded === ask.id}
            onToggle={() => setExpanded(expanded === ask.id ? null : ask.id)}
            openAgent={openAgent}
            viewingAgentId={agentId}
          />
        )}
      />
      <View style={styles.buttons}>
        <Button
          styles={styles}
          label={mutation.isPending ? "Asking…" : "Refresh asks"}
          disabled={mutation.isPending}
          onPress={() => mutation.mutate()}
        />
      </View>
    </View>
  );
}

const VERBS: Record<AskCardData["verb"], string> = {
  create: "Asked",
  update: "Updated",
  resolve: "Resolved",
};

/**
 * An ask shown in the agent chat where the agent created, updated or resolved it. Open asks start expanded.
 * The chat around it already explains the ask, so its buttons come first, then its body, folded if the setting says so.
 */
export function AskCard(
  props: {
    theme: PluginTheme;
    compact: boolean;
    agentId: string;
    openAgent?: (agentId: string) => void;
  } & AskCardData,
) {
  const { theme, compact, agentId, askId, verb, openAgent } = props;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  // Every card in a chat shares this one query, so a long chat still polls once.
  const asks = useAsks(workspaceId ?? undefined, true);
  const ask = asks.data?.asks.find(
    (candidate) => candidate.workspaceId === workspaceId && candidate.id === askId,
  );
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? ask?.status === "open";
  const settings = useSettings(displaySettings);

  const note =
    !workspaceId || asks.isPending
      ? "loading…"
      : asks.isError
        ? "could not load"
        : !ask
          ? "not found"
          : null;
  return (
    <View style={styles.inline}>
      <Text style={styles.muted}>
        {VERBS[verb]} {askId}
        {note ? ` (${note})` : ""}
      </Text>
      {ask && (
        <AskRow
          ask={ask}
          styles={styles}
          theme={theme}
          expanded={expanded}
          onToggle={() => setToggled(!expanded)}
          openAgent={openAgent}
          viewingAgentId={agentId}
          actionsFirst
          foldBody={settings.status === "ready" && settings.values.foldChatBodies}
        />
      )}
    </View>
  );
}

function AskRow(props: {
  ask: Ask;
  styles: Styles;
  theme: PluginTheme;
  expanded: boolean;
  onToggle(): void;
  openAgent?: (agentId: string) => void;
  /** The agent whose chat this is shown in, so "Open chat" does not point at itself. */
  viewingAgentId?: string;
  actionsFirst?: boolean;
  foldBody?: boolean;
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
  openAgent,
  viewingAgentId,
  actionsFirst = false,
  foldBody = false,
}: {
  ask: Ask;
  styles: Styles;
  openAgent?: (agentId: string) => void;
  viewingAgentId?: string;
  /** Show the action buttons above the body. */
  actionsFirst?: boolean;
  /** Keep the body behind a "Details" link. */
  foldBody?: boolean;
}) {
  const act = useRpc(actOnAsk);
  const openPr = useContext(OpenPrContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [bodyOpened, setBodyOpened] = useState(false);
  const bodyShown = !foldBody || bodyOpened;
  const mutation = useMutation({
    mutationFn: (input: { verb: "action" | "done" | "drop" | "reply"; actionId?: string }) =>
      act({ workspaceId: ask.workspaceId, id: ask.id, note, ...input }),
    onSuccess: ({ notified }) => {
      setNote("");
      if (!notified)
        toast.show(`${ask.id} closed; its agent is gone, so nobody was told.`, {
          variant: "warning",
        });
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const startDiscussion = useRpc(discussAsk);
  const discussion = useMutation({
    mutationFn: () => startDiscussion({ workspaceId: ask.workspaceId, id: ask.id, note }),
    onSuccess: ({ agentId }) => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      openAgent?.(agentId);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const press = (action: Action) => {
    if (action.kind === "open" && action.url) return openLink(action.url);
    mutation.mutate({ verb: "action", actionId: action.id });
  };

  const actions = ask.status === "open" && ask.actions.length > 0 && (
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
  );

  return (
    <View style={styles.detail}>
      {actionsFirst && actions}
      {foldBody && ask.body?.trim() ? (
        <Pressable accessibilityRole="button" onPress={() => setBodyOpened(!bodyOpened)}>
          <Text style={styles.link}>{bodyOpened ? "Hide details" : "Details"}</Text>
        </Pressable>
      ) : null}
      {bodyShown && ask.body?.trim() ? <Markdown>{ask.body}</Markdown> : null}
      {ask.links.map((link) => {
        const pr = openPr && prLinkOf(link.url);
        return pr ? (
          <InboxLink key={link.url} styles={styles} onPress={() => openPr(pr)}>
            <Text style={styles.link}>{link.label}</Text>
          </InboxLink>
        ) : (
          <Pressable key={link.url} accessibilityRole="link" onPress={() => openLink(link.url)}>
            <Text style={styles.link}>{link.label} ↗</Text>
          </Pressable>
        );
      })}
      {ask.pr &&
        (openPr ? (
          <InboxLink styles={styles} onPress={() => openPr(ask.pr!.url)}>
            <PrDetail pr={ask.pr} styles={styles} />
          </InboxLink>
        ) : (
          <PrDetail pr={ask.pr} styles={styles} />
        ))}
      {ask.orphaned && (
        <Text style={styles.orphaned}>
          The agent that raised this is archived. Closing it here notifies nobody.
        </Text>
      )}
      {!actionsFirst && actions}
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Note or reply (optional)"
        placeholderTextColor={styles.placeholder.color}
        style={styles.input}
        multiline
      />
      <View style={styles.buttons}>
        <Button
          styles={styles}
          label="Reply"
          disabled={mutation.isPending || !note.trim()}
          onPress={() => mutation.mutate({ verb: "reply" })}
        />
        <Button
          styles={styles}
          label="Done"
          disabled={mutation.isPending}
          onPress={() => mutation.mutate({ verb: "done" })}
        />
        <Button
          styles={styles}
          label="Drop"
          disabled={mutation.isPending}
          onPress={() => mutation.mutate({ verb: "drop" })}
        />
        {!ask.orphaned && (
          <Button
            styles={styles}
            label={
              discussion.isPending
                ? "Opening…"
                : ask.discussionAgentId
                  ? "Open discussion"
                  : "Discuss"
            }
            disabled={discussion.isPending || mutation.isPending}
            onPress={() => discussion.mutate()}
          />
        )}
        {openAgent && ask.ownerAgentId !== viewingAgentId && (
          <Button styles={styles} label="Open chat" onPress={() => openAgent(ask.ownerAgentId)} />
        )}

      </View>
    </View>
  );
}

const PR_STATE: Record<PrState["state"], string> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};
const CHECKS: Record<PrState["checks"], string> = {
  passing: "checks ✓",
  failing: "checks ✗",
  pending: "checks …",
  none: "",
};

function PrBadge({ pr, styles }: { pr: PrState; styles: Styles }) {
  const tone =
    pr.state === "CLOSED" || pr.checks === "failing"
      ? styles.bad
      : pr.state === "MERGED" || pr.checks === "passing"
        ? styles.good
        : styles.muted;
  const label =
    pr.state === "OPEN" ? (pr.isDraft ? "draft" : CHECKS[pr.checks] || "open") : PR_STATE[pr.state];
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

/**
 * A PR link that opens the PR's review screen in paseo-inbox. The Inbox icon says where it goes on
 * every platform; hovering (desktop and web) also spells it out, since plugins have no tooltip.
 */
function InboxLink({ styles, onPress, children }: { styles: Styles; onPress(): void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="link" accessibilityHint="Opens in Inbox" onPress={onPress} style={styles.inboxLink}>
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          {children}
          <Icon name="Inbox" size={12} color={styles.inboxHint.color} />
          {hovered && <Text style={styles.inboxHint}>Open in Inbox</Text>}
        </>
      )}
    </Pressable>
  );
}

function Button(props: {
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
    inboxLink: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, alignSelf: "flex-start" as const },
    inboxHint: { color: colors.foregroundMuted, fontSize: 12 },
    muted: { color: colors.foregroundMuted },
    danger: { color: colors.statusDanger },
  };
}
