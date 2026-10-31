import type {
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
import { AgentAsks, AskCard, AsksView, POLL_MS, useAsks } from "./client/AsksView";
import { SettingsScreen } from "./client/SettingsScreen";
import { listAsks, pillLabel } from "./shared/asks";
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

function SidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const asks = useAsks();
  const waiting = asks.data?.asks.filter((ask) => ask.status === "open").length ?? 0;
  return (
    <SidebarRow
      icon="Inbox"
      active={currentScreen?.screenId === "asks"}
      onPress={() => openScreen({ screenId: "asks" })}
      trailing={waiting > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{waiting}</Text> : undefined}
    />
  );
}

function TimelineCard(props: PluginTimelineItemProps<AskCardData>) {
  const { theme, layout, agentId, item } = props;
  return <AskCard theme={theme} compact={layout.compact} agentId={agentId} openAgent={agentOpener(props)} {...item.data} />;
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

/** A composer pill per agent with its open asks; pressing it shows them and a Refresh. */
function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const { id: agentId, workspaceId } = agent;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "asks",
        workspaceId,
        agentId,
        button: { title: "Asks", icon: "Inbox", label: pillLabel({ open: 0, inProgress: 0 }), behavior: { kind: "popover", Content: PillPopover } },
      }),
    );
  };
  const drop = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const refreshCounts = async () => {
    const { asks } = await client.rpc(listAsks, {});
    const counts = new Map<string, { open: number; inProgress: number }>();
    for (const ask of asks) {
      const count = counts.get(ask.ownerAgentId) ?? { open: 0, inProgress: 0 };
      if (ask.status === "open") count.open++;
      if (ask.status === "in_progress") count.inProgress++;
      counts.set(ask.ownerAgentId, count);
    }
    for (const [agentId, pill] of pills) {
      pill.update({ label: pillLabel(counts.get(agentId) ?? { open: 0, inProgress: 0 }) });
    }
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
  };
}

export default function contribute(client: PluginClientContext) {
  openAgentViaScreen = (agentId) => client.openScreen({ screenId: "asks", params: { open: agentId } });
  client.addWorkspacePanel({ id: "asks", title: "Asks", icon: "Inbox", context: "workspace", Component: WorkspacePanel });
  client.addScreen({ id: "asks", title: "Asks", Component: GlobalScreen });
  client.addSettingsScreen({ id: "asks", title: "Asks", icon: "Inbox", Component: SettingsScreen });
  client.addSidebarHeaderItem({ id: "asks", title: "Asks", Component: SidebarItem });
  client.addCommandCenterItem({
    id: "open-asks",
    title: "Open asks for this workspace",
    icon: "Inbox",
    context: "workspace",
    keywords: ["asks", "decisions", "inbox"],
    onSelect: ({ openPanel }) => openPanel("asks"),
  });
  client.addCommandCenterItem({
    id: "open-all-asks",
    title: "Open asks across workspaces",
    icon: "Inbox",
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
  return contributePills(client);
}
