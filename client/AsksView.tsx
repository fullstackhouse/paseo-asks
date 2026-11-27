import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { asksChanged } from "./changes";
import { useDraft } from "./drafts";
import { MoreMenu, type MenuEntry } from "./menu";
import type { OpenAgent } from "./navigation";
import {
  actOnAsk,
  awaitsYou,
  discussAsk,
  discussionTitle,
  listAsks,
  locateAsk,
  prLinkOf,
  prPreviewOf,
  refreshAsks,
  waitingOnOf,
  type Action,
  type Ask,
  type Deployment,
  type PrState,
  type WaitingOn,
  type WaitTone,
} from "../shared/asks";
import { displaySettings } from "../shared/settings";
import type { AskCard as AskCardData } from "../shared/timeline";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { OpenPrContext } from "./inbox";
import { openLink } from "./open-link";
import { useRevealInScroll } from "./reveal";
import { askQueue, nextWaitingAsk, type QueueFilter } from "./queue";
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
  openAgent?: OpenAgent;
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
  const queue = useMemo(() => askQueue(asks.data?.asks ?? [], snoozed), [asks.data, snoozed]);
  const open = useOpenAsk(queue[filter]);
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
                open.close();
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
            {queue[filter].map((ask) => (
              <QueueRow
                key={askKey(ask)}
                ask={ask}
                workspaceName={asks.data.workspaceNames?.[ask.workspaceId] ?? ask.workspaceId}
                snoozed={snoozed.has(ask.workspaceId)}
                styles={styles}
                theme={theme}
                {...open.rowProps(ask)}
                openAgent={openAgent}
              />
            ))}
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
  reveal?: number;
  onToggle(): void;
  onAnswered?(): boolean | void;
  openAgent?: OpenAgent;
}) {
  const { ask, workspaceName, snoozed, styles, theme, expanded } = props;
  const [hovered, setHovered] = useState(false);
  const onAnswered = useFoldInPlace(props.onAnswered, props.reveal);
  return (
    <View ref={onAnswered.ref} style={styles.queueItem}>
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
          <AskDetail {...props} onAnswered={onAnswered.fold} />
        </View>
      )}
    </View>
  );
}

function WorkspaceAsks({ theme, compact, workspaceId, openAgent }: ViewProps) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const asks = useAsks(workspaceId);
  const groups = useMemo(() => {
    const all = asks.data?.asks ?? [];
    return workspaceId ? [[workspaceId, all] as const] : [...groupBy(all, (ask) => ask.workspaceId)];
  }, [asks.data, workspaceId]);
  // The order rows render in: by workspace, then waiting before in progress.
  const rows = useMemo(() => groups.flatMap(([, items]) => statusOrder(items)), [groups]);
  const open = useOpenAsk(rows);

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
            renderRow={(ask) => (
              <AskRow
                key={askKey(ask)}
                ask={ask}
                styles={styles}
                theme={theme}
                {...open.rowProps(ask)}
                openAgent={openAgent}
              />
            )}
          />
        </View>
      ))}
    </ScrollView>
  );
}

const SECTIONS = ["open", "in_progress"] as const;

/** Asks in the order `StatusSections` draws them. */
function statusOrder(asks: readonly Ask[]): Ask[] {
  return SECTIONS.flatMap((status) => asks.filter((ask) => ask.status === status));
}

function askKey(ask: Pick<Ask, "workspaceId" | "id">): string {
  return `${ask.workspaceId}/${ask.id}`;
}

/**
 * One ask open at a time in a list of `rows` (in the order they render). Answering the open ask opens the next one
 * that waits on you and scrolls to it, so you can work down the list without tapping each row.
 */
function useOpenAsk(rows: readonly Ask[]) {
  // `answered`: the ask whose answer opened this one.
  const [open, setOpen] = useState<{ key: string; answered?: string } | null>(null);
  // The answered ask keeps its slot until the refetch moves it out (closed, or to In progress), which shifts the
  // rows below it: the opened card scrolls to itself once more then.
  const answeredInSlot = rows.some((ask) => askKey(ask) === open?.answered && awaitsYou(ask));
  return {
    close: () => setOpen(null),
    rowProps: (ask: Ask) => {
      const key = askKey(ask);
      const expanded = open?.key === key;
      return {
        expanded,
        reveal: expanded && open.answered ? (answeredInSlot ? 1 : 2) : 0,
        onToggle: () => setOpen(expanded ? null : { key }),
        onAnswered: () => {
          const next = nextWaitingAsk(rows, ask);
          setOpen(next ? { key: askKey(next), answered: key } : null);
          return next !== undefined;
        },
      };
    },
  };
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
      {SECTIONS.map((status) => {
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
  openAgent?: OpenAgent;
}) {
  const { theme, compact, workspaceId, agentId, openAgent } = props;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const asks = useAsks(workspaceId);
  // This agent's asks first, the one it discusses included.
  const ordered = useMemo(() => {
    const own = (ask: Ask) => (ask.ownerAgentId === agentId || ask.discussionAgentId === agentId ? 0 : 1);
    return [...(asks.data?.asks ?? [])].sort((a, b) => own(a) - own(b));
  }, [asks.data, agentId]);
  const rows = useMemo(() => statusOrder(ordered), [ordered]);
  const open = useOpenAsk(rows);
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
  return (
    <View style={styles.popover}>
      {ordered.length === 0 && <Text style={styles.muted}>No open asks in this workspace.</Text>}
      <StatusSections
        asks={ordered}
        styles={styles}
        renderRow={(ask) => (
          <AskRow
            key={askKey(ask)}
            ask={ask}
            styles={styles}
            theme={theme}
            {...open.rowProps(ask)}
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

/**
 * An ask shown in the agent chat where the agent created, updated or resolved it.
 * The card of the agent's latest call on the ask is live: open asks start expanded, with their buttons first (the chat
 * around it already explains the ask), then the body, folded if the setting says so. Older cards show the ask as their
 * call left it, read-only and folded, so scrolling back reads as history.
 */
export function AskCard(
  props: {
    theme: PluginTheme;
    compact: boolean;
    agentId: string;
    openAgent?: OpenAgent;
  } & AskCardData,
) {
  const { theme, compact, agentId, askId, verb, call, openAgent } = props;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  // Every card in a chat shares this one query, so a long chat still polls once.
  const asks = useAsks(workspaceId ?? undefined, true);
  // An explainer's calls on the ask it discusses name that ask, which lives in another workspace (see service.find).
  const ask =
    (verb !== "create"
      ? asks.data?.asks.find((candidate) => candidate.discussionAgentId === agentId && candidate.id === askId)
      : undefined) ??
    asks.data?.asks.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === askId);
  // Asks from before lastCall existed have none: every card on them stays live, as they always were.
  // Closed asks need nothing more from the human, so their latest card reads as history too.
  const live = ask && (!ask.lastCall || ask.lastCall === call) && (ask.status === "open" || ask.status === "in_progress");
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? (live ? ask.status === "open" : false);
  const settings = useSettings(displaySettings);

  const loaded = workspaceId && !asks.isPending;
  return (
    <View style={styles.inline}>
      {live ? (
        <AskRow
          ask={ask}
          styles={styles}
          theme={theme}
          expanded={expanded}
          onToggle={() => setToggled(!expanded)}
          onAnswered={() => setToggled(false)}
          openAgent={openAgent}
          viewingAgentId={agentId}
          foldBody={settings.status === "ready" && settings.values.foldChatBodies}
          quiet={ask.status !== "open"}
        />
      ) : loaded ? (
        <EventRow
          {...props}
          current={ask}
          deleted={asks.isSuccess && !ask}
          styles={styles}
          expanded={expanded}
          onToggle={() => setToggled(!expanded)}
        />
      ) : (
        <Text style={styles.muted}>{askId} (loading…)</Text>
      )}
    </View>
  );
}

/** What the update set: "options, status → in progress". */
function changeSummary(card: AskCardData): string {
  return card.changed
    .map((field) => (field === "status" && card.snapshot.status ? `status → ${card.snapshot.status.replace("_", " ")}` : field))
    .join(", ");
}

/** What one agent call did to the ask: "Asked", "Updated options, status → in progress", "Marked done · chose “Merge”". */
function eventSummary(card: AskCardData): string {
  const { verb, snapshot } = card;
  if (verb === "create") return "Asked";
  if (verb === "update") {
    const changes = changeSummary(card);
    return changes ? `Updated ${changes}` : "Updated";
  }
  const closed = snapshot.status === "dropped" ? "Dropped" : snapshot.status === "done" ? "Marked done" : "Resolved";
  return snapshot.choice ? `${closed} · chose “${snapshot.choice}”` : closed;
}

/**
 * One past agent call on an ask, as history: what the call did, then the ask's title. Expanded, it shows what the call
 * set (a create's body and options, an update's new values, a resolve's note), read-only.
 */
function EventRow(
  props: AskCardData & {
    theme: PluginTheme;
    current: Ask | undefined;
    /** The ask no longer exists; the row is all that is left of it. */
    deleted: boolean;
    styles: Styles;
    expanded: boolean;
    onToggle(): void;
  },
) {
  const { askId, snapshot, current, deleted, styles, theme, expanded } = props;
  const kind = snapshot.kind ?? current?.kind;
  const title = snapshot.title ?? current?.title ?? askId;
  const event = eventSummary(props);
  const hasDetail = Boolean(snapshot.note || snapshot.body?.trim() || snapshot.actions?.length || snapshot.links?.length);
  return (
    <View style={[styles.card, styles.quiet]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${askId}: ${event}: ${title}${deleted ? ", since deleted" : ""}`}
        accessibilityState={{ expanded }}
        disabled={!hasDetail}
        onPress={props.onToggle}
        style={styles.row}
      >
        {kind && <Icon name={KIND_ICONS[kind]} size={16} color={theme.colors.foregroundMuted} />}
        <Text style={styles.id}>{askId}</Text>
        <Text style={styles.title} numberOfLines={expanded ? undefined : 1}>
          {event}
          <Text style={styles.muted}> — {title}</Text>
        </Text>
        {deleted && <Text style={[styles.badge, styles.muted]}>deleted</Text>}
      </Pressable>
      {expanded && hasDetail && (
        <View style={styles.detail}>
          {snapshot.note ? <Text style={styles.muted}>{snapshot.note}</Text> : null}
          {snapshot.body?.trim() ? <Markdown>{snapshot.body}</Markdown> : null}
          {snapshot.actions?.length ? (
            <View style={styles.chips}>
              {snapshot.actions.map((action, index) => (
                <Text key={index} style={[styles.badge, styles.muted]}>
                  {action.label}
                  {action.recommended ? " ★" : ""}
                </Text>
              ))}
            </View>
          ) : null}
          {snapshot.links?.map((link) => (
            <Pressable key={link.url} accessibilityRole="link" onPress={() => openLink(link.url)}>
              <Text style={styles.link}>{link.label} ↗</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * One waiting ask in the host's Overview, the same row the Asks panel shows, so it can be answered there.
 * Every entry shares the workspace's asks query, so a list of them polls once.
 */
export function WorkspaceAskEntry(props: {
  theme: PluginTheme;
  compact: boolean;
  workspaceId: string;
  askId: string;
  defaultExpanded: boolean;
  /** Host-owned open state, when the host keeps one entry open at a time. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  openAgent?: OpenAgent;
  /** Set by the host for an ask in progress that nothing moves; its facts line turns to the warning tone. */
  nothingMoving?: boolean;
}) {
  const { theme, compact, workspaceId, askId, defaultExpanded, onExpandedChange, openAgent } = props;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const asks = useAsks(workspaceId);
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const expanded = props.expanded ?? localExpanded;
  const setExpanded = props.expanded === undefined ? setLocalExpanded : onExpandedChange;
  // The workspace's own ask first; else the one it explains.
  const ask =
    asks.data?.asks.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === askId) ??
    asks.data?.asks.find((candidate) => candidate.id === askId);
  if (!ask) return null;
  if (ask.status === "in_progress")
    return (
      <InProgressAskRow
        ask={ask}
        styles={styles}
        theme={theme}
        expanded={expanded}
        nothingMoving={props.nothingMoving ?? false}
        onToggle={() => setExpanded?.(!expanded)}
        onTakenBack={() => setExpanded?.(false)}
        openAgent={openAgent}
      />
    );
  return (
    <AskRow
      ask={ask}
      styles={styles}
      theme={theme}
      expanded={expanded}
      onToggle={() => setExpanded?.(!expanded)}
      onAnswered={() => setExpanded?.(false)}
      openAgent={openAgent}
    />
  );
}

/** About three lines of body before "More". */
const BODY_PREVIEW_HEIGHT = 64;

/**
 * An ask its agent holds, in the Overview's In progress: what it waits on and how long it sat. Open, it shows the
 * start of the body, a facts line, the links, and the human's ways in: take it over, remind the agent, show the chat.
 */
function InProgressAskRow(props: {
  ask: Ask;
  styles: Styles;
  theme: PluginTheme;
  expanded: boolean;
  nothingMoving: boolean;
  onToggle(): void;
  onTakenBack(): void;
  openAgent?: OpenAgent;
}) {
  const { ask, styles, theme, expanded, nothingMoving } = props;
  const waiting = waitingOnOf(ask);
  const toneColor = (tone: WaitTone) =>
    ({ success: theme.colors.statusSuccess, warning: theme.colors.statusWarning, danger: theme.colors.statusDanger, muted: theme.colors.foregroundMuted })[tone];
  const word = nothingMoving ? { text: "nothing moving", tone: "warning" as const } : waiting;
  return (
    <View style={[styles.card, expanded && styles.cardExpanded]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ask.id}: ${ask.title}`}
        accessibilityState={{ expanded }}
        onPress={props.onToggle}
        style={styles.row}
      >
        <Icon name="MessageCircleQuestionMark" size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.title} numberOfLines={expanded ? undefined : 1}>
          {ask.title}
        </Text>
        <Text style={styles.age} numberOfLines={1}>
          {word && <Text style={{ color: toneColor(word.tone) }}>{word.text} · </Text>}
          {age(ask.updatedAt)}
        </Text>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      {expanded && <InProgressDetail {...props} waiting={waiting} warn={nothingMoving || Boolean(ask.orphaned)} />}
    </View>
  );
}

function InProgressDetail({
  ask,
  styles,
  theme,
  nothingMoving,
  waiting,
  warn,
  onTakenBack,
  openAgent,
}: {
  ask: Ask;
  styles: Styles;
  theme: PluginTheme;
  nothingMoving: boolean;
  waiting: WaitingOn | undefined;
  warn: boolean;
  onTakenBack(): void;
  openAgent?: OpenAgent;
}) {
  const act = useRpc(actOnAsk);
  const locate = useRpc(locateAsk);
  const openPr = useContext(OpenPrContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [bodyOpened, setBodyOpened] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(0);
  const mutation = useMutation({
    mutationFn: (verb: "reopen" | "remind") => act({ workspaceId: ask.workspaceId, id: ask.id, verb }),
    onSuccess: (_, verb) => {
      if (verb === "reopen") onTakenBack();
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      asksChanged();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  // Reminded until the owner changes the ask: a remind does not touch `updatedAt`, the owner's next update does.
  const reminded = ask.remindedAt && ask.remindedAt >= ask.updatedAt ? ask.remindedAt : undefined;
  const facts = [
    ask.orphaned ? "Agent archived" : "",
    waiting?.line ?? "",
    nothingMoving ? "nothing moving" : "",
    ask.takenAt ? `taken ${ago(ask.takenAt)}` : "",
    `last moved ${ago(ask.updatedAt)}`,
  ].filter(Boolean);
  const factsLine = facts.join(" · ");
  const body = ask.body?.trim();
  const clipped = !bodyOpened && bodyHeight > BODY_PREVIEW_HEIGHT;
  return (
    <View style={styles.detail}>
      {body ? (
        <View>
          <View style={bodyOpened ? undefined : { maxHeight: BODY_PREVIEW_HEIGHT, overflow: "hidden" }}>
            <View onLayout={(event) => setBodyHeight(event.nativeEvent.layout.height)}>
              <Markdown>{body}</Markdown>
            </View>
          </View>
          {(clipped || bodyOpened) && (
            <Pressable accessibilityRole="button" onPress={() => setBodyOpened(!bodyOpened)} style={{ alignSelf: "flex-start" }}>
              <Text style={styles.link}>{bodyOpened ? "Less" : "More"}</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      <Text style={[styles.prDetail, warn && { color: theme.colors.statusWarning }]}>
        {factsLine.charAt(0).toUpperCase() + factsLine.slice(1)}
      </Text>
      {ask.links.length > 0 && (
        <View style={styles.chips}>
          {ask.links.map((link) => {
            const pr = openPr && prPreviewOf(link.url);
            return (
              <Pressable
                key={link.url}
                accessibilityRole="link"
                accessibilityHint={pr ? "Opens in Inbox" : undefined}
                onPress={() => (pr ? openPr(pr) : openLink(link.url))}
                style={[styles.chip, styles.linkChip]}
              >
                <Icon name={prLinkOf(link.url) ? "GitPullRequest" : "Link"} size={12} color={theme.colors.foregroundMuted} />
                <Text style={[styles.chipText, { color: theme.colors.foreground }]} numberOfLines={1}>
                  {link.label}
                  {pr ? "" : " ↗"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <View style={styles.buttons}>
        <Button styles={styles} label="Take over" disabled={mutation.isPending} onPress={() => mutation.mutate("reopen")} />
        {ask.orphaned ? null : reminded ? (
          <View style={styles.reminded}>
            <Icon name="Check" size={14} color={theme.colors.foregroundMuted} />
            <Text style={styles.muted}>Reminded {ago(reminded)}</Text>
          </View>
        ) : (
          <Button styles={styles} label="Remind agent" disabled={mutation.isPending} onPress={() => mutation.mutate("remind")} />
        )}
        {openAgent && (
          <Button
            styles={styles}
            label="Show in chat"
            onPress={() =>
              void locate({ workspaceId: ask.workspaceId, id: ask.id }).then(
                ({ agentId, position }) => openAgent(agentId, position),
                () => openAgent(ask.ownerAgentId),
              )
            }
          />
        )}
      </View>
    </View>
  );
}

/**
 * Folds an answered card and scrolls back to it: folding a long card leaves the sheet's scroll offset past
 * it, below the next ask. The card still sits in its slot when the scroll lands; the refetch then moves it to
 * In progress and the next waiting ask takes that slot. When the list opened another ask instead (`fold` returns
 * true), that ask scrolls to itself: a card scrolls to itself whenever its non-zero `revealPass` changes.
 */
function useFoldInPlace(fold?: () => boolean | void, revealPass = 0) {
  const ref = useRef<View>(null);
  const reveal = useRevealInScroll();
  useEffect(() => {
    if (revealPass) reveal(ref.current);
  }, [revealPass, reveal]);
  return {
    ref,
    fold: () => {
      if (fold?.() !== true) reveal(ref.current);
    },
  };
}

function AskRow(props: {
  ask: Ask;
  styles: Styles;
  theme: PluginTheme;
  expanded: boolean;
  /** Non-zero scrolls to the card, and each new value scrolls again: the list opened it after you answered another. */
  reveal?: number;
  onToggle(): void;
  /** Returns true when the list opened another ask, which then scrolls to itself. */
  onAnswered?(): boolean | void;
  openAgent?: OpenAgent;
  /** The agent whose chat this is shown in, so "Show in chat" does not point at itself. */
  viewingAgentId?: string;
  foldBody?: boolean;
  /** In the chat, for an ask that is not waiting on the human: drawn flat so it does not compete with ones that are. */
  quiet?: boolean;
}) {
  const { ask, styles, theme, expanded } = props;
  const onAnswered = useFoldInPlace(props.onAnswered, props.reveal);
  return (
    <View ref={onAnswered.ref} style={[styles.card, props.quiet ? styles.quiet : expanded && styles.cardExpanded]}>
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
      {expanded && <AskDetail {...props} onAnswered={onAnswered.fold} />}
    </View>
  );
}

function AskDetail({
  ask,
  styles,
  theme,
  openAgent,
  viewingAgentId,
  foldBody = false,
  onAnswered,
}: {
  ask: Ask;
  styles: Styles;
  theme: PluginTheme;
  openAgent?: OpenAgent;
  viewingAgentId?: string;
  /** Keep the body behind a "Details" link. */
  foldBody?: boolean;
  /** Called once an answer lands, so the list can fold the card and you move on to the next ask. */
  onAnswered?(): void;
}) {
  const act = useRpc(actOnAsk);
  const openPr = useContext(OpenPrContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useDraft(ask.workspaceId, ask.id);
  const [bodyOpened, setBodyOpened] = useState(false);
  const bodyShown = !foldBody || bodyOpened;
  // One line when empty, then the field follows its text up to about six lines and scrolls.
  // The height comes from a hidden copy of the text at the field's width. The field's own
  // content size can't be used: on web it is the textarea's scroll height, which never drops
  // below the field's current height, so the field grew on every keystroke and never shrank.
  const [textHeight, setTextHeight] = useState(0);
  const inputHeight = Math.min(132, Math.max(36, Math.ceil(textHeight)));
  // Scroll (the field's default) only past the cap: a classic scrollbar narrows the field, so its text wraps
  // onto more lines than the measuring copy and the last line gets cut off.
  const inputOverflow = textHeight > 132 ? undefined : "hidden";
  const mutation = useMutation({
    mutationFn: (input: { verb: "action" | "done" | "drop" | "reply"; actionId?: string }) =>
      act({ workspaceId: ask.workspaceId, id: ask.id, note, ...input }),
    onSuccess: ({ notified }) => {
      setNote("");
      if (!notified)
        toast.show(`${ask.id} closed; its agent is gone, so nobody was told.`, {
          variant: "warning",
        });
      onAnswered?.();
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      asksChanged();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const startDiscussion = useRpc(discussAsk);
  const discussion = useMutation({
    mutationFn: () => startDiscussion({ workspaceId: ask.workspaceId, id: ask.id, note }),
    onSuccess: ({ agentId }) => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      asksChanged();
      openAgent?.(agentId);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const locate = useRpc(locateAsk);
  // The chat opens scrolled to where the agent raised the ask; at its end when that can't be found.
  const showInChat = (open: OpenAgent) =>
    void locate({ workspaceId: ask.workspaceId, id: ask.id }).then(
      ({ agentId, position }) => open(agentId, position),
      () => open(ask.ownerAgentId),
    );
  const busy = mutation.isPending || discussion.isPending;
  const press = (action: Action) => {
    if (action.kind === "open" && action.url) return openLink(action.url);
    mutation.mutate({ verb: "action", actionId: action.id });
  };
  const reply = () => {
    if (!busy && note.trim()) mutation.mutate({ verb: "reply" });
  };

  const closed = ask.status === "done" || ask.status === "dropped";
  const menuItems: MenuEntry[] = [
    ...(closed
      ? []
      : [{ id: "done", label: "Mark done", icon: "CircleCheck", onSelect: () => mutation.mutate({ verb: "done" }) }]),
    // An ask you already answered has nothing left to settle: only its live discussion reopens.
    ...(ask.orphaned || !(ask.status === "open" || ask.discussionAgentId)
      ? []
      : [
          {
            id: "discuss",
            label: ask.discussionAgentId ? "Open discussion" : "Discuss",
            icon: "MessagesSquare",
            onSelect: () => discussion.mutate(),
          },
        ]),
    ...(openAgent && ask.ownerAgentId !== viewingAgentId
      ? [{ id: "chat", label: "Show in chat", icon: "MessageSquare", onSelect: () => showInChat(openAgent) }]
      : []),
    ...(closed
      ? []
      : [
          { id: "sep", separator: true as const },
          {
            id: "drop",
            label: "Drop ask",
            icon: "CircleX",
            destructive: true,
            onSelect: () => mutation.mutate({ verb: "drop" }),
          },
        ]),
  ];
  const menu = menuItems.length > 0 && <MoreMenu items={menuItems} disabled={busy} styles={styles} />;
  const actions = ask.status === "open" ? ask.actions : [];

  return (
    <View style={styles.detail}>
      {ask.status !== "open" && ask.outcome && <OutcomeLine ask={ask} styles={styles} />}
      {ask.orphaned && (
        <Text style={styles.orphaned}>
          The agent that raised this is archived. Closing it here notifies nobody.
        </Text>
      )}
      {foldBody && ask.body?.trim() ? (
        <Pressable accessibilityRole="button" onPress={() => setBodyOpened(!bodyOpened)}>
          <Text style={styles.link}>{bodyOpened ? "Hide details" : "Details"}</Text>
        </Pressable>
      ) : null}
      {bodyShown && ask.body?.trim() ? <Markdown>{ask.body}</Markdown> : null}
      {ask.links.map((link) => {
        const pr = openPr && prPreviewOf(link.url);
        return pr ? (
          <InboxLink key={link.url} onPress={() => openPr(pr)}>
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
          <InboxLink onPress={() => openPr(ask.pr!.url)}>
            <PrDetail pr={ask.pr} styles={styles} />
          </InboxLink>
        ) : (
          <PrDetail pr={ask.pr} styles={styles} />
        ))}
      {ask.pr?.deployments?.length ? <Deployments deployments={ask.pr.deployments} styles={styles} /> : null}
      {ask.discussionWorkspaceId &&
        ask.discussionAgentId &&
        ask.discussionAgentId !== viewingAgentId &&
        ask.status !== "done" &&
        ask.status !== "dropped" && (
        <DiscussedIn ask={ask} styles={styles} open={openAgent} />
      )}
      {actions.length > 0 && (
        <View style={styles.actionRow}>
          <View style={styles.buttons}>
            {actions.map((action) => (
              <Button
                key={action.id}
                styles={styles}
                primary={action.recommended}
                disabled={busy}
                label={`${action.label}${action.kind === "open" ? " ↗" : ""}`}
                onPress={() => press(action)}
              />
            ))}
          </View>
          {menu}
        </View>
      )}
      <View style={styles.replyRow}>
        <View style={styles.replyField}>
          <Text
            accessible={false}
            aria-hidden
            pointerEvents="none"
            style={[styles.input, styles.inputMeasure]}
            onLayout={(event) => setTextHeight(event.nativeEvent.layout.height)}
          >
            {`${note}\u200b`}
          </Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Reply to the agent…"
            placeholderTextColor={styles.placeholder.color}
            style={[styles.input, { height: inputHeight, overflow: inputOverflow }]}
            multiline
            numberOfLines={1}
            onKeyPress={(event) => {
              // Desktop/web: Enter sends the reply, Shift+Enter adds a line. Native keeps Return as newline.
              const e = event.nativeEvent as typeof event.nativeEvent & {
                shiftKey?: boolean;
                isComposing?: boolean;
              };
              if (Platform.OS !== "web" || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
              event.preventDefault();
              reply();
            }}
          />
          {note.trim() ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send reply"
              disabled={busy}
              onPress={reply}
              style={styles.send}
            >
              <Icon name="SendHorizontal" size={16} color={theme.colors.accentForeground} />
            </Pressable>
          ) : null}
        </View>
        {actions.length === 0 && menu}
      </View>
    </View>
  );
}

/** Where the ask is being explained; opens the explainer's chat, in its own workspace. */
function DiscussedIn({ ask, styles, open }: { ask: Ask; styles: Styles; open?: (agentId: string) => void }) {
  const label = `Being discussed in ${discussionTitle(ask)}`;
  if (!open) return <Text style={styles.prDetail}>{label}</Text>;
  return (
    <Pressable accessibilityRole="link" onPress={() => open(ask.discussionAgentId!)}>
      <Text style={styles.link}>{label} →</Text>
    </Pressable>
  );
}

/** What happened to an ask that no longer waits on you: "You chose QA-approve + merge · 2m ago". */
function OutcomeLine({ ask, styles }: { ask: Ask; styles: Styles }) {
  const { outcome } = ask;
  if (!outcome) return null;
  const who = outcome.by === "human" ? "You" : "The agent";
  const what = outcome.label
    ? `${who} chose “${outcome.label}”`
    : ask.status === "dropped"
      ? `Dropped by ${who === "You" ? "you" : "the agent"}`
      : ask.status === "done"
        ? `Marked done by ${who === "You" ? "you" : "the agent"}`
        : `${who} answered`;
  return (
    <Text style={styles.muted}>
      {what}
      {outcome.note ? `: ${outcome.note}` : ""} · {age(outcome.at)} ago
    </Text>
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

const DEPLOYMENT: Record<Deployment["state"], { mark: string; verb: string; tone: "good" | "muted" | "bad" }> = {
  ready: { mark: "●", verb: "", tone: "good" },
  deploying: { mark: "◌", verb: "deploying ", tone: "muted" },
  failed: { mark: "✕", verb: "failed ", tone: "bad" },
};

/** Preview deployments of the PR's head commit: ready ones open the preview, the rest their logs. */
function Deployments({ deployments, styles }: { deployments: Deployment[]; styles: Styles }) {
  return (
    <View style={styles.chips}>
      {deployments.map((deployment) => {
        const { mark, verb, tone } = DEPLOYMENT[deployment.state];
        // The URL-less entry's label already says "Deploying".
        const text = `${mark} ${deployment.url ? verb : ""}${deployment.label}`;
        const link = deployment.link;
        return (
          <Pressable
            key={`${deployment.url ?? ""}:${deployment.label}`}
            accessibilityRole="link"
            accessibilityLabel={text.slice(2)}
            disabled={!link}
            onPress={() => link && openLink(link)}
            style={styles.chip}
          >
            <Text style={[styles.chipText, styles[tone]]} numberOfLines={1}>
              {text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A PR link that opens the PR's review screen in paseo-inbox. */
function InboxLink({ onPress, children }: { onPress(): void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="link" accessibilityHint="Opens in Inbox" onPress={onPress} style={{ alignSelf: "flex-start" }}>
      {children}
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

/** "just now" under a minute, else "5m ago". */
function ago(iso: string): string {
  const time = age(iso);
  return time === "0m" ? "just now" : `${time} ago`;
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
    quiet: { backgroundColor: colors.surface0 },
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
      lineHeight: 18,
    },
    inputMeasure: {
      position: "absolute" as const,
      top: 0,
      left: 0,
      right: 0,
      // One pixel past the field's cap, so overflow shows as a height above 132 without the copy
      // spilling far out of the row. (`undefined` doesn't lift the cap on web.)
      maxHeight: 133,
      opacity: 0,
      borderColor: "transparent",
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
    linkChip: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    reminded: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, paddingHorizontal: 4 },
    muted: { color: colors.foregroundMuted },
    danger: { color: colors.statusDanger },
  };
}
