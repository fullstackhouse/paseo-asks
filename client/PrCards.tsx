import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { actOnPr, listPrs, type PrButtonId, type PrCard } from "../shared/prs";
import { OpenPrContext } from "./inbox";
import { MoreMenu, type MenuEntry } from "./menu";
import { openLink } from "./open-link";
import { Deployments, InboxLink, PrBadge, PrDetail } from "./pr-status";
import { age, Button, type Styles } from "./ui";

const POLL_MS = 4000;

export function usePrs(workspaceId?: string) {
  const list = useRpc(listPrs);
  return useQuery({
    queryKey: ["asks-prs", workspaceId ?? "*"],
    queryFn: () => list({ workspaceId }),
    refetchInterval: POLL_MS,
  });
}

const SECTIONS: { phase: PrCard["phase"]; title: string }[] = [
  { phase: "waiting", title: "PULL REQUESTS · NEEDS YOU" },
  { phase: "working", title: "PULL REQUESTS" },
  { phase: "done", title: "MERGED OR CLOSED" },
];

/** A workspace's PR cards: what waits on you first, then the agent's, then the ones merged or closed today. */
export function PrSections(props: {
  prs: PrCard[];
  styles: Styles;
  theme: PluginTheme;
  openAgent?: (agentId: string) => void;
  viewingAgentId?: string;
  workspaceNames?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <>
      {SECTIONS.map(({ phase, title }) => {
        const rows = props.prs.filter((card) => card.phase === phase);
        if (rows.length === 0) return null;
        return (
          <View key={phase} style={props.styles.section}>
            <Text style={props.styles.sectionTitle}>{title}</Text>
            {rows.map((card) => (
              <PrRow
                key={card.url}
                {...props}
                card={card}
                workspaceName={props.workspaceNames?.[card.workspaceId]}
                expanded={expanded === card.url}
                onToggle={() => setExpanded(expanded === card.url ? null : card.url)}
              />
            ))}
          </View>
        );
      })}
    </>
  );
}

export function PrRow(props: {
  card: PrCard;
  styles: Styles;
  theme: PluginTheme;
  expanded: boolean;
  onToggle(): void;
  workspaceName?: string;
  openAgent?: (agentId: string) => void;
  viewingAgentId?: string;
  /** The main screen's queue row instead of a card. */
  queue?: boolean;
}) {
  const { card, styles, theme, expanded } = props;
  const title = `#${card.number} ${card.title}`;
  if (props.queue) return <QueuePrRow {...props} title={title} />;
  return (
    <View style={[styles.card, expanded && styles.cardExpanded]}>
      <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={props.onToggle} style={styles.row}>
        <Icon name="GitPullRequest" size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.title} numberOfLines={expanded ? undefined : 1}>
          {title}
        </Text>
        <PrBadge pr={card.pr} styles={styles} />
        {props.workspaceName ? (
          <Text style={styles.age} numberOfLines={1}>
            {props.workspaceName}
          </Text>
        ) : null}
        <Text style={styles.age}>{age(card.updatedAt)}</Text>
      </Pressable>
      {expanded && <PrCardDetail {...props} />}
    </View>
  );
}

function QueuePrRow(props: Parameters<typeof PrRow>[0] & { title: string }) {
  const { card, styles, theme, expanded, title } = props;
  const [hovered, setHovered] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${props.workspaceName ?? ""}`}
        accessibilityHint="Show the pull request and its buttons"
        accessibilityState={{ expanded }}
        onPress={props.onToggle}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => [styles.queueRow, (hovered || pressed || expanded) && styles.queuePressed]}
      >
        <View style={styles.queueIcon}>
          <Icon name="GitPullRequest" size={16} color={theme.colors.foregroundMuted} />
        </View>
        <View style={styles.queueText}>
          <Text style={styles.queueTitle}>{title}</Text>
          <View style={styles.queueMeta}>
            <Text style={styles.queueWorkspace} numberOfLines={1}>
              {props.workspaceName}
            </Text>
            <Text style={styles.id}>{card.reason}</Text>
            <PrBadge pr={card.pr} styles={styles} />
            <Text style={styles.age}>{age(card.updatedAt)}</Text>
          </View>
        </View>
        <View style={styles.queueIcon}>
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={16} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.queueDetail}>
          <PrCardDetail {...props} />
        </View>
      )}
    </>
  );
}

/** The PR's status, previews and the buttons for its next move. A note in the field goes along with any button. */
function PrCardDetail({
  card,
  styles,
  openAgent,
  viewingAgentId,
}: {
  card: PrCard;
  styles: Styles;
  theme: PluginTheme;
  openAgent?: (agentId: string) => void;
  viewingAgentId?: string;
}) {
  const act = useRpc(actOnPr);
  const openPr = useContext(OpenPrContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: (button: PrButtonId) => act({ url: card.url, button, note: note.trim() || undefined }),
    onSuccess: ({ sent }) => {
      setNote("");
      if (!sent) toast.show("The agent gets it when its turn ends.");
      void queryClient.invalidateQueries({ queryKey: ["asks-prs"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const menuItems: MenuEntry[] = [
    ...(openAgent && card.agentId && card.agentId !== viewingAgentId
      ? [{ id: "chat", label: "Open chat", icon: "MessageSquare", onSelect: () => openAgent(card.agentId!) }]
      : []),
    { id: "github", label: "Open on GitHub", icon: "ExternalLink", onSelect: () => openLink(card.url) },
  ];
  const status = <PrDetail pr={card.pr} styles={styles} />;
  // The press holds the card until the PR changes; its reason then reads "You chose …".
  const held = card.pressed !== undefined && card.reason === `You chose ${card.pressed.label}`;
  return (
    <View style={styles.detail}>
      {openPr ? <InboxLink onPress={() => openPr(card.url)}>{status}</InboxLink> : status}
      {card.pr.deployments?.length ? <Deployments deployments={card.pr.deployments} styles={styles} /> : null}
      <Text style={styles.muted}>
        {card.reason}
        {held ? ` ${age(card.pressed!.at)} ago${card.pressed!.note ? `: ${card.pressed!.note}` : ""}` : ""}
      </Text>
      <View style={styles.actionRow}>
        <View style={styles.buttons}>
          {card.buttons.map((button) => (
            <Button
              key={button.id}
              styles={styles}
              primary={button.primary && card.phase === "waiting"}
              disabled={mutation.isPending}
              label={button.label}
              onPress={() => mutation.mutate(button.id)}
            />
          ))}
        </View>
        <MoreMenu items={menuItems} disabled={mutation.isPending} styles={styles} />
      </View>
      {card.buttons.length > 0 && (
        <View style={styles.replyRow}>
          <View style={styles.replyField}>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Note for the agent, sent with a button…"
              placeholderTextColor={styles.placeholder.color}
              style={[styles.input, { height: 36 }]}
            />
          </View>
        </View>
      )}
      {card.agentState === "gone" && (
        <Text style={styles.orphaned}>No agent is left in this workspace, so the buttons have nobody to reach.</Text>
      )}
    </View>
  );
}
