import { useEffect, useState } from "react";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { FREQUENCY_OPTIONS, INSTRUCTIONS_LIMIT, instructions } from "../shared/instructions";
import { agentSettings, reviewSettings } from "../shared/settings";

/** How often agents ask, and the rules they get. Read when an agent starts, so changes reach new agents only. */
export function AgentRulesSettings({ theme }: { theme: PluginTheme }) {
  const settings = useSettings(agentSettings);
  const reviews = useSettings(reviewSettings);
  const saved = settings.status === "ready" ? settings.values.customInstructions : "";
  const [draft, setDraft] = useState(saved);
  const [edited, setEdited] = useState(false);
  // Follow saves from elsewhere (another window, a reset) until the human starts typing.
  useEffect(() => {
    if (!edited) setDraft(saved);
  }, [saved, edited]);

  if (settings.status !== "ready") return null;
  const { values, revision } = settings;
  const busy = settings.saving;
  const custom = saved.trim() !== "";
  const dirty = draft !== saved;
  const over = draft.length > INSTRUCTIONS_LIMIT;
  const save = async (customInstructions: string) => {
    if (await settings.save({ ...values, customInstructions }, revision)) {
      setDraft(customInstructions);
      setEdited(false);
    }
  };
  const builtIn = () =>
    instructions({
      frequency: values.frequency,
      actOnReviewChanges: reviews.status !== "ready" || reviews.values.actOnReviewChanges,
    });
  const colors = theme.colors;

  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSelect
          label="How often agents ask"
          hint={
            custom
              ? "Not used while custom instructions are set."
              : "Fewer: agents decide reversible choices themselves and mention optional work in their reply. More: agents also ask about small choices. Applies to agents started after the change."
          }
          value={values.frequency}
          options={FREQUENCY_OPTIONS}
          disabled={busy || custom}
          error={settings.saveError ?? undefined}
          onValueChange={(frequency) => void settings.save({ ...values, frequency }, revision)}
        />
        <SettingsRow
          label="Custom instructions"
          hint="Replace the built-in rules agents get for asks. Leave empty to use the built-in ones. Applies to agents started after you save."
        >
          <View style={{ gap: 4, alignSelf: "stretch" }}>
            <TextInput
              testID="asks-custom-instructions"
              value={draft}
              onChangeText={(text) => {
                setDraft(text);
                setEdited(true);
              }}
              placeholder="Built-in rules"
              placeholderTextColor={colors.foregroundMuted}
              multiline
              editable={!busy}
              style={{
                color: colors.foreground,
                borderWidth: 1,
                borderColor: over ? colors.statusWarning : colors.border,
                borderRadius: 6,
                padding: 8,
                minHeight: 160,
                maxHeight: 360,
                fontFamily: "monospace",
                fontSize: 12,
                textAlignVertical: "top",
              }}
            />
            <Text style={{ fontSize: 12, color: over ? colors.statusWarning : colors.foregroundMuted }}>
              {draft.length} / {INSTRUCTIONS_LIMIT}
              {over ? ` · Claude Code cuts everything past ${INSTRUCTIONS_LIMIT} characters.` : ""}
            </Text>
          </View>
        </SettingsRow>
        <SettingsAction
          label="Start from the built-in rules"
          hint="Fills the box with the current built-in rules to edit."
          actionLabel="Fill"
          disabled={busy || draft.trim() !== ""}
          onPress={() => {
            setDraft(builtIn());
            setEdited(true);
          }}
        />
        <SettingsAction
          label="Save custom instructions"
          actionLabel="Save"
          disabled={busy || !dirty}
          onPress={() => void save(draft)}
        />
        <SettingsAction
          label="Use the built-in rules"
          hint="Clears your custom instructions."
          actionLabel="Reset"
          disabled={busy || (!custom && draft === "")}
          onPress={() => void save("")}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
