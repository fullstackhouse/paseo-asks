import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { FREQUENCY_OPTIONS } from "../shared/instructions";
import { agentSettings } from "../shared/settings";

/** How often agents ask. Read when an agent starts, so a change reaches new agents only. */
export function AgentRulesSettings() {
  const settings = useSettings(agentSettings);
  if (settings.status !== "ready") return null;
  const { values, revision } = settings;
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSelect
          label="How often agents ask"
          hint="Fewer: agents decide reversible choices themselves and mention optional work in their reply. More: they also ask about small choices."
          value={values.frequency}
          options={FREQUENCY_OPTIONS}
          disabled={settings.saving}
          error={settings.saveError ?? undefined}
          onValueChange={(frequency) => void settings.save({ ...values, frequency }, revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
