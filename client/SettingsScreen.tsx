import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { displaySettings } from "../shared/settings";

export function SettingsScreen(_props: PluginSurfaceProps) {
  const settings = useSettings(displaySettings);
  return (
    <SettingsSection title="Display">
      <SettingsCard>
        <SettingsSwitch
          label="Fold ask details in chat"
          hint="Keep an ask's text behind a Details link in chat cards. The Asks panel always shows it."
          value={settings.status === "ready" && settings.values.foldChatBodies}
          disabled={settings.status !== "ready" || settings.saving}
          error={settings.saveError ?? undefined}
          onValueChange={(foldChatBodies) => {
            if (settings.status === "ready") void settings.save({ foldChatBodies }, settings.revision);
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
