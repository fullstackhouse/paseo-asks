import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { FREQUENCY_OPTIONS, instructions } from "../shared/instructions";
import { agentSettings, reviewSettings } from "../shared/settings";
import { InstructionsSetting } from "./InstructionsSetting";

/** How often agents ask, and the rules they get. Read when an agent starts, so changes reach new agents only. */
export function AgentRulesSettings({ theme }: { theme: PluginTheme }) {
  const settings = useSettings(agentSettings);
  const reviews = useSettings(reviewSettings);
  if (settings.status !== "ready") return null;
  const { values, revision } = settings;
  const custom = values.customInstructions.trim() !== "";
  const builtIn = instructions({
    frequency: values.frequency,
    actOnReviewChanges: reviews.status !== "ready" || reviews.values.actOnReviewChanges,
  });

  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSelect
          label="How often agents ask"
          hint={
            custom
              ? "Not used while your own instructions are saved."
              : "Fewer: agents decide reversible choices themselves and mention optional work in their reply. More: they also ask about small choices."
          }
          value={values.frequency}
          options={FREQUENCY_OPTIONS}
          disabled={settings.saving || custom}
          error={settings.saveError ?? undefined}
          onValueChange={(frequency) => void settings.save({ ...values, frequency }, revision)}
        />
        <InstructionsSetting
          theme={theme}
          builtIn={builtIn}
          saved={values.customInstructions}
          disabled={settings.saving}
          save={(customInstructions) => settings.save({ ...values, customInstructions }, revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
