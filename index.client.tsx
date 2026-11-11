import type {
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginTimelineItemProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { Text } from "react-native";
import { AsksMessage } from "./client/AsksMessage";
import { AgentAsks, AskCard, AsksView, POLL_MS, useAsks } from "./client/AsksView";
import { SettingsScreen } from "./client/SettingsScreen";
import { observeSnoozedWorkspaces, useSnoozedWorkspaceIds } from "./client/snoozed";
import { listAsks, waitingByWorkspace, waitingCount } from "./shared/asks";
import { createWorkspaceSummaries } from "./client/summary";
import { ASKS_MESSAGE, AsksMessageSchema, parseAsksMessage, type AsksMessage as AsksMessageData } from "./shared/messages";
import { ASK_CARD, AskCardSchema, askCardFor, type AskCard as AskCardData } from "./shared/timeline";

function WorkspacePanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  return (
    <AsksView
      theme={theme}
      compact={layout.compact}
      workspaceId={workspaceId}
      openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
    />
  );
}

/**
 * Older hosts give chat cards and pill popovers no `navigation`, so there they open an agent by visiting
 * the Asks screen with `open`, which has navigation and hands off at once. Set in `contribute`.
 */
let openAgentViaScreen: ((agentId: string) => void) | undefined;

type Navigation = PluginScreenProps["navigation"];

/** Opens agents through the host's navigation when it passes one (FSH fork), else via the Asks screen. */
function agentOpener(props: object): ((agentId: string) => void) | undefined {
  const navigation = (props as { navigation?: Navigation }).navigation;
  return navigation ? (agentId) => navigation.openAgent({ agentId }) : openAgentViaScreen;
}

function GlobalScreen({ theme, layout, navigation, params }: PluginScreenProps) {
  const open = params.open;
  useEffect(() => {
    if (open && navigation) navigation.openAgent({ agentId: open });
  }, [open, navigation]);
  return (
    <AsksView
      theme={theme}
      compact={layout.compact}
      openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
    />
  );
}

/** The FSH host's needs-input orange; older hosts only have the status warning. */
function attentionColor(theme: PluginSidebarItemProps["theme"]): string {
  return (theme.colors as { attention?: string }).attention ?? theme.colors.statusWarning;
}

function SidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const asks = useAsks();
  const snoozed = useSnoozedWorkspaceIds();
  const waiting = waitingCount(asks.data?.asks ?? [], snoozed);
  return (
    <SidebarRow
      icon="MessageCircleQuestionMark"
      active={currentScreen?.screenId === "asks"}
      onPress={() => openScreen({ screenId: "asks" })}
      trailing={waiting > 0 ? <Text style={{ color: attentionColor(theme), fontSize: 12, fontWeight: "600" }}>{waiting}</Text> : undefined}
    />
  );
}

function TimelineCard(props: PluginTimelineItemProps<AskCardData>) {
  const { theme, layout, agentId, item } = props;
  return <AskCard theme={theme} compact={layout.compact} agentId={agentId} openAgent={agentOpener(props)} {...item.data} />;
}

function TimelineMessage({ theme, item }: PluginTimelineItemProps<AsksMessageData>) {
  return <AsksMessage theme={theme} {...item.data} />;
}

function PillPopover(props: PluginButtonContentProps) {
  const { theme, layout, workspaceId, close, ...context } = props;
  if (context.context !== "agent") return null;
  const open = agentOpener(props);
  const openAgent = open
    ? (agentId: string) => {
        close();
        open(agentId);
      }
    : undefined;
  return (
    <AgentAsks theme={theme} compact={layout.compact} workspaceId={workspaceId} agentId={context.agentId} openAgent={openAgent} />
  );
}

// Older hosts ignore the presentation hint and keep their existing popover.
const asksPopover: Extract<PluginButtonBehavior, { kind: "popover" }> & { presentation: "side-panel" } = {
  kind: "popover",
  presentation: "side-panel",
  Content: PillPopover,
};

/** The pill's face beside its question icon: how many asks in its workspace wait on you, 0 so a missing one is noticed. */
function pillLabel(count: number): string {
  return String(count);
}

/** A composer pill per agent with its open asks; pressing it shows them and a Refresh. */
function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, { workspaceId: string; pill: PluginButtonRegistration }>();
  const summaries = createWorkspaceSummaries(client);
  const lifetime = new AbortController();

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const { id: agentId, workspaceId } = agent;
    pills.set(agentId, {
      workspaceId,
      pill: client.addComposerPill({
        id: "asks",
        workspaceId,
        agentId,
        button: { title: "Asks", icon: "MessageCircleQuestionMark", label: pillLabel(0), behavior: asksPopover },
      }),
    });
  };
  const drop = (agentId: string) => {
    pills.get(agentId)?.pill.remove();
    pills.delete(agentId);
  };

  const refreshCounts = async () => {
    const { asks } = await client.rpc(listAsks, {});
    const waiting = waitingByWorkspace(asks);
    for (const { workspaceId, pill } of pills.values()) {
      pill.update({ label: pillLabel(waiting.get(workspaceId)?.count ?? 0) });
    }
    // Every workspace with waiting asks, even one whose agents are gone, plus ones already reported, so a count drops to 0.
    const workspaceIds = new Set([...waiting.keys(), ...summaries.workspaceIds()]);
    for (const workspaceId of workspaceIds) summaries.set(workspaceId, waiting.get(workspaceId));
  };
  const timer = setInterval(() => void refreshCounts().catch(() => undefined), POLL_MS * 2);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of [...pills.keys()]) drop(agentId);
          for (const { agent } of entries) register(agent);
          void refreshCounts().catch(() => undefined);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          drop(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[asks] agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    clearInterval(timer);
    for (const agentId of [...pills.keys()]) drop(agentId);
    summaries.clear();
  };
}

export default function contribute(client: PluginClientContext) {
  openAgentViaScreen = (agentId) => client.openScreen({ screenId: "asks", params: { open: agentId } });
  client.addWorkspacePanel({
    id: "asks",
    title: "Asks",
    icon: "MessageCircleQuestionMark",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspacePanel,
  });
  client.addScreen({ id: "asks", title: "Asks", Component: GlobalScreen });
  client.addSettingsScreen({ id: "asks", title: "Asks", icon: "MessageCircleQuestionMark", Component: SettingsScreen });
  client.addSidebarHeaderItem({ id: "asks", title: "Asks", Component: SidebarItem });
  client.addCommandCenterItem({
    id: "open-asks",
    title: "Open asks for this workspace",
    icon: "MessageCircleQuestionMark",
    context: "workspace",
    keywords: ["asks", "decisions", "inbox"],
    onSelect: ({ openPanel }) => openPanel("asks"),
  });
  client.addCommandCenterItem({
    id: "open-all-asks",
    title: "Open asks across workspaces",
    icon: "MessageCircleQuestionMark",
    context: "global",
    keywords: ["asks", "decisions", "inbox"],
    onSelect: ({ openScreen }) => openScreen({ screenId: "asks" }),
  });
  // An asks tool call in the chat becomes the ask itself, so it can be read and answered in place.
  client.addTimelineTransformer({
    id: "ask-cards",
    query: { itemType: "tool_call" },
    transform: ({ item }) => {
      const data = askCardFor(item);
      return data && { items: [{ type: "plugin", ...ASK_CARD, data }] };
    },
  });
  client.addTimelineRenderer({ ...ASK_CARD, schema: AskCardSchema, Component: TimelineCard });
  // An [asks] message reads as what the human did; the agent still gets the instructions in its text.
  client.addTimelineTransformer({
    id: "asks-messages",
    query: { itemType: "user_message" },
    transform: ({ item }) => {
      const data = parseAsksMessage(item.text);
      return data && { items: [{ type: "plugin", ...ASKS_MESSAGE, data }] };
    },
  });
  client.addTimelineRenderer({ ...ASKS_MESSAGE, schema: AsksMessageSchema, Component: TimelineMessage });
  const stopPills = contributePills(client);
  const stopSnoozed = observeSnoozedWorkspaces(client, "asks");
  return () => {
    stopPills();
    stopSnoozed();
  };
}
