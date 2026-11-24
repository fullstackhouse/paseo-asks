import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { INSTRUCTIONS_LIMIT } from "../shared/instructions";

/**
 * One settings row that opens an editor for the rules agents get, after Paseo's own "Append system prompt" setting.
 * Copied in paseo-status: fix a bug in one, fix it in both.
 */
export function InstructionsSetting({
  theme,
  builtIn,
  saved,
  disabled,
  save,
}: {
  theme: PluginTheme;
  /** The rules agents get when nothing is saved. */
  builtIn: string;
  /** The saved custom text; blank means the built-in rules. */
  saved: string;
  disabled?: boolean;
  /** Stores the custom text ("" for the built-in rules); resolves false when the save failed. */
  save(customInstructions: string): Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const custom = saved.trim() !== "";
  const initial = custom ? saved : builtIn;
  const colors = theme.colors;
  const over = draft.length > INSTRUCTIONS_LIMIT;

  const commit = async (text: string) => {
    setSaving(true);
    // Saving the built-in text unchanged keeps the human on the built-in rules, so later updates reach them.
    const ok = await save(text.trim() === builtIn.trim() ? "" : text).finally(() => setSaving(false));
    if (ok) setOpen(false);
  };

  return (
    <>
      <SettingsAction
        label="Instructions for agents"
        hint={custom ? `Custom · ${saved.length.toLocaleString()} characters` : "Built-in rules"}
        actionLabel="Edit"
        disabled={disabled}
        onPress={() => {
          setDraft(initial);
          setOpen(true);
        }}
      />
      <Modal title="Instructions for agents" open={open} onOpenChange={(next: boolean) => !saving && setOpen(next)}>
        <Modal.Content>
          <TextInput
            testID="instructions-input"
            accessibilityLabel="Instructions for agents"
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            editable={!saving}
            style={{
              color: colors.foreground,
              backgroundColor: colors.surface1,
              borderWidth: 1,
              borderColor: over ? colors.statusWarning : colors.border,
              borderRadius: 8,
              padding: 12,
              minHeight: 360,
              fontFamily: "monospace",
              fontSize: 12,
              lineHeight: 18,
              textAlignVertical: "top",
            }}
          />
          <Text style={{ fontSize: 12, color: over ? colors.statusWarning : colors.foregroundMuted }}>
            {over
              ? `${draft.length.toLocaleString()} characters. Claude Code keeps the first ${INSTRUCTIONS_LIMIT.toLocaleString()}.`
              : `${draft.length.toLocaleString()} / ${INSTRUCTIONS_LIMIT.toLocaleString()} characters. Agents started after you save get these.`}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {custom ? (
              <ModalButton theme={theme} label="Use built-in rules" disabled={saving} onPress={() => void commit("")} />
            ) : null}
            <View style={{ flex: 1 }} />
            <ModalButton
              theme={theme}
              label="Save"
              primary
              disabled={saving || draft === initial}
              onPress={() => void commit(draft)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}

function ModalButton({
  theme,
  label,
  primary,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const colors = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 6,
        backgroundColor: primary ? colors.accent : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}
