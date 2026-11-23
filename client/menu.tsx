import * as hostUi from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import { Pressable, Text, View } from "react-native";

export type MenuEntry =
  | { id: string; label: string; icon?: string; destructive?: boolean; disabled?: boolean; onSelect(): void }
  | { id: string; separator: true };

interface MenuProps {
  items: readonly MenuEntry[];
  trigger: { icon: string; accessibilityLabel: string; label?: string };
  compactMode?: "sheet" | "popover";
  disabled?: boolean;
  testID?: string;
}

// COMPAT(hostMenu): FSH hosts from fullstackhouse/paseo `feat/plugin-ui-menu` export `Menu` (the host's
// popover / bottom-sheet engine); typed locally until the npm SDK has it. Older hosts get the items as
// quiet text buttons, so every answer stays reachable. Remove the fallback after 2027-03-01.
const HostMenu = (hostUi as { Menu?: ComponentType<MenuProps> }).Menu;

export interface MoreMenuStyles {
  fallback: object;
  fallbackItem: object;
  fallbackText: object;
  fallbackDestructive: object;
}

/** The card's ⋯ menu: the host menu, or its items inline on hosts without one. */
export function MoreMenu({
  items,
  disabled,
  styles,
}: {
  items: readonly MenuEntry[];
  disabled?: boolean;
  styles: MoreMenuStyles;
}) {
  if (HostMenu) {
    return (
      <HostMenu
        items={items}
        disabled={disabled}
        compactMode="sheet"
        trigger={{ icon: "Ellipsis", accessibilityLabel: "More actions" }}
      />
    );
  }
  return (
    <View style={styles.fallback}>
      {items.map((item) =>
        "separator" in item ? null : (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            disabled={disabled || item.disabled}
            onPress={item.onSelect}
            style={styles.fallbackItem}
          >
            <Text style={[styles.fallbackText, item.destructive && styles.fallbackDestructive]}>{item.label}</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}
