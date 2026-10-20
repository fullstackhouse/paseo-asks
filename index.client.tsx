import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { AgentAsks, AsksView, POLL_MS, useAsks } from "./client/AsksView";
import { listAsks } from "./shared/asks";

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

function GlobalScreen({ theme, layout, navigation }: PluginScreenProps) {
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

function PillPopover({ theme, layout, workspaceId, ...context }: PluginButtonContentProps) {
  if (context.context !== "agent") return null;
  return <AgentAsks theme={theme} compact={layout.compact} workspaceId={workspaceId} agentId={context.agentId} />;
}

/** The pill's face: how many asks wait on you, or "No asks" so a missing one is noticed. */
function pillLabel(count: number): string {
  return count > 0 ? `Asks · ${count}` : "No asks";
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
        button: { title: "Asks", icon: "Inbox", label: pillLabel(0), behavior: { kind: "popover", Content: PillPopover } },
      }),
    );
  };
  const drop = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const refreshCounts = async () => {
    const { asks } = await client.rpc(listAsks, {});
    const counts = new Map<string, number>();
    for (const ask of asks) if (ask.status === "open") counts.set(ask.ownerAgentId, (counts.get(ask.ownerAgentId) ?? 0) + 1);
    for (const [agentId, pill] of pills) {
      pill.update({ label: pillLabel(counts.get(agentId) ?? 0) });
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
  client.addWorkspacePanel({ id: "asks", title: "Asks", icon: "Inbox", context: "workspace", Component: WorkspacePanel });
  client.addScreen({ id: "asks", title: "Asks", Component: GlobalScreen });
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
  return contributePills(client);
}
