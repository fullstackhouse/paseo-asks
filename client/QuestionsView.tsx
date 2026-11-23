import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MoreMenu, type MenuEntry } from "./menu";
import {
  answerQuestion,
  dropQuestion,
  listQuestions,
  postponeQuestion,
  questionKey,
  questionTitle,
  type NativeQuestion,
  type PendingQuestion,
} from "../shared/questions";
import { age, Button, type Styles } from "./ui";

const POLL_MS = 4000;

export function useQuestions(workspaceId?: string) {
  const list = useRpc(listQuestions);
  return useQuery({
    queryKey: ["asks-questions", workspaceId ?? "*"],
    queryFn: () => list({ workspaceId }),
    refetchInterval: POLL_MS,
  });
}

/** Pending questions first, then postponed ones, both oldest first. */
export function QuestionSections(props: {
  questions: PendingQuestion[];
  styles: Styles;
  theme: PluginTheme;
  openAgent?: (agentId: string) => void;
  viewingAgentId?: string;
  workspaceNames?: Record<string, string>;
}) {
  const { questions } = props;
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <>
      {(["pending", "postponed"] as const).map((state) => {
        const rows = questions.filter((question) => question.state === state);
        if (rows.length === 0) return null;
        return (
          <View key={state} style={props.styles.section}>
            <Text style={props.styles.sectionTitle}>{state === "pending" ? "QUESTIONS" : "ANSWER LATER"}</Text>
            {rows.map((question) => {
              const key = questionKey(question);
              return (
                <QuestionRow
                  key={key}
                  {...props}
                  question={question}
                  workspaceName={props.workspaceNames?.[question.workspaceId]}
                  expanded={expanded === key}
                  onToggle={() => setExpanded(expanded === key ? null : key)}
                />
              );
            })}
          </View>
        );
      })}
    </>
  );
}

export function QuestionRow(props: {
  question: PendingQuestion;
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
  const { question, styles, theme, expanded } = props;
  const title = questionTitle(question);
  if (props.queue) return <QueueQuestionRow {...props} title={title} />;
  return (
    <View style={[styles.card, expanded && styles.cardExpanded]}>
      <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={props.onToggle} style={styles.row}>
        <Icon name="MessageCircleQuestionMark" size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.title} numberOfLines={expanded ? undefined : 1}>
          {title}
        </Text>
        {props.workspaceName ? (
          <Text style={styles.age} numberOfLines={1}>
            {props.workspaceName}
          </Text>
        ) : null}
        <Text style={styles.age}>{age(question.postponedAt ?? question.askedAt)}</Text>
      </Pressable>
      {expanded && <QuestionForm {...props} />}
    </View>
  );
}

function QueueQuestionRow(props: Parameters<typeof QuestionRow>[0] & { title: string }) {
  const { question, styles, theme, expanded, title } = props;
  const [hovered, setHovered] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${props.workspaceName ?? ""}`}
        accessibilityHint="Show the question and its answers"
        accessibilityState={{ expanded }}
        onPress={props.onToggle}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => [styles.queueRow, (hovered || pressed || expanded) && styles.queuePressed]}
      >
        <View style={styles.queueIcon}>
          <Icon name="MessageCircleQuestionMark" size={16} color={theme.colors.foregroundMuted} />
        </View>
        <View style={styles.queueText}>
          <Text style={styles.queueTitle}>{title}</Text>
          <View style={styles.queueMeta}>
            <Text style={styles.queueWorkspace} numberOfLines={1}>
              {props.workspaceName}
            </Text>
            <Text style={styles.id}>{question.state === "postponed" ? "Put off" : "Question"}</Text>
            <Text style={styles.age}>{age(question.postponedAt ?? question.askedAt)}</Text>
          </View>
        </View>
        <View style={styles.queueIcon}>
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={16} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.queueDetail}>
          <QuestionForm {...props} />
        </View>
      )}
    </>
  );
}

/** Each question with its options and a field for an answer of your own, then Send, Answer later and the ⋯ menu. */
export function QuestionForm({
  question,
  styles,
  theme,
  openAgent,
  viewingAgentId,
}: {
  question: PendingQuestion;
  styles: Styles;
  theme: PluginTheme;
  openAgent?: (agentId: string) => void;
  viewingAgentId?: string;
}) {
  const answer = useRpc(answerQuestion);
  const later = useRpc(postponeQuestion);
  const drop = useRpc(dropQuestion);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const ids = { agentId: question.agentId, requestId: question.requestId };
  const done = () => void queryClient.invalidateQueries({ queryKey: ["asks-questions"] });
  const onError = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));
  const send = useMutation({
    mutationFn: (answers: Record<string, string>) => answer({ ...ids, answers }),
    onSuccess: ({ delivered }) => {
      if (delivered === "message") toast.show("Sent. The agent gets it as a message.");
      done();
    },
    onError,
  });
  const postpone = useMutation({
    mutationFn: () => later(ids),
    onSuccess: () => {
      toast.show("The agent carries on without it. Answer it here when you're ready.");
      done();
    },
    onError,
  });
  const dismiss = useMutation({ mutationFn: () => drop(ids), onSuccess: done, onError });
  const busy = send.isPending || postpone.isPending || dismiss.isPending;

  const answerOf = (item: NativeQuestion) =>
    other[item.header]?.trim() || (picked[item.header] ?? []).join(", ");
  const complete = question.questions.every((item) => answerOf(item));
  const submit = (answers = Object.fromEntries(question.questions.map((item) => [item.header, answerOf(item)]))) => {
    if (!busy) send.mutate(answers);
  };
  // One single-choice question: an option answers it, like an ask's buttons.
  const oneTap = question.questions.length === 1 && !question.questions[0]!.multiSelect;
  const pick = (item: NativeQuestion, label: string) => {
    if (oneTap) return submit({ [item.header]: label });
    setOther((current) => ({ ...current, [item.header]: "" }));
    setPicked((current) => {
      const now = current[item.header] ?? [];
      if (!item.multiSelect) return { ...current, [item.header]: [label] };
      return { ...current, [item.header]: now.includes(label) ? now.filter((entry) => entry !== label) : [...now, label] };
    });
  };

  const menu: MenuEntry[] = [
    ...(openAgent && question.agentId !== viewingAgentId
      ? [{ id: "chat", label: "Open chat", icon: "MessageSquare", onSelect: () => openAgent(question.agentId) }]
      : []),
    { id: "sep", separator: true as const },
    { id: "drop", label: "Dismiss question", icon: "CircleX", destructive: true, onSelect: () => dismiss.mutate() },
  ];

  return (
    <View style={styles.detail}>
      {question.state === "postponed" && (
        <Text style={styles.muted}>
          {question.blocking
            ? "You put this off; the agent carried on without it. Your answer reaches it as a message."
            : "You put this off. The agent keeps working; your answer reaches it when you send it."}
        </Text>
      )}
      {question.questions.map((item) => (
        <View key={item.header} style={styles.section}>
          {question.questions.length > 1 && <Text style={styles.sectionTitle}>{item.header.toUpperCase()}</Text>}
          <Markdown>{item.question}</Markdown>
          <View style={styles.section}>
            {item.options.map((option) => {
              const selected = (picked[item.header] ?? []).includes(option.label) && !other[item.header]?.trim();
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={item.multiSelect ? "checkbox" : oneTap ? "button" : "radio"}
                  accessibilityState={{ checked: selected, disabled: busy }}
                  disabled={busy}
                  onPress={() => pick(item, option.label)}
                  style={({ pressed }) => [
                    styles.option,
                    selected && styles.optionSelected,
                    pressed && styles.queuePressed,
                  ]}
                >
                  <View style={styles.optionText}>
                    <Text style={styles.optionLabel}>{option.label}</Text>
                    {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                    {option.preview ? <Text style={styles.optionPreview}>{option.preview}</Text> : null}
                  </View>
                  {selected && <Icon name="Check" size={16} color={theme.colors.accent} />}
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={other[item.header] ?? ""}
            onChangeText={(text) => setOther((current) => ({ ...current, [item.header]: text }))}
            placeholder={item.options.length ? "Or type your own answer…" : "Your answer…"}
            placeholderTextColor={styles.placeholder.color}
            style={[styles.input, { paddingRight: 8 }]}
            multiline
            onSubmitEditing={oneTap ? () => complete && submit() : undefined}
          />
        </View>
      ))}
      <View style={styles.actionRow}>
        <View style={styles.buttons}>
          {(!oneTap || Object.values(other).some((text) => text.trim())) && (
            <Button styles={styles} primary label={send.isPending ? "Sending…" : "Send"} disabled={busy || !complete} onPress={() => submit()} />
          )}
          {question.state === "pending" && (
            <Button styles={styles} label={postpone.isPending ? "Putting off…" : "Answer later"} disabled={busy} onPress={() => postpone.mutate()} />
          )}
        </View>
        <MoreMenu items={menu} disabled={busy} styles={styles} />
      </View>
    </View>
  );
}
