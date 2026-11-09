import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { displaySettings, reviewSettings } from "../shared/settings";

export function SettingsScreen(_props: PluginSurfaceProps) {
  const settings = useSettings(displaySettings);
  const reviews = useSettings(reviewSettings);
  return (
    <>
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
      <SettingsSection title="Pull requests">
        <SettingsCard>
          <SettingsSwitch
            label="Tell agents about requested changes"
            hint="When a reviewer requests changes on a PR an agent follows, the agent hears about it and starts on them. Off: you get an ask with an Address button instead."
            value={reviews.status === "ready" && reviews.values.actOnReviewChanges}
            disabled={reviews.status !== "ready" || reviews.saving}
            error={reviews.saveError ?? undefined}
            onValueChange={(actOnReviewChanges) => {
              if (reviews.status === "ready") void reviews.save({ actOnReviewChanges }, reviews.revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
