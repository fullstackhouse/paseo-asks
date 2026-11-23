import { useState } from "react";
import { Pressable, Text, View } from "react-native";

export function SidebarRow() {
  return null;
}

// The standalone preview has no Paseo renderer. Verify rich text in the running host.
export function Markdown({ children }: { children?: string }) {
  return (
    <View>
      <Text>Markdown source — rendering requires Paseo</Text>
      <Text>{children}</Text>
    </View>
  );
}

// Stands in for the FSH host's menu engine: a ⋯ button that opens its items in a popover.
export function Menu(props: {
  items: readonly ({ id: string; separator: true } | { id: string; label: string; destructive?: boolean; onSelect(): void })[];
  trigger: { accessibilityLabel: string };
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ position: "relative" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.trigger.accessibilityLabel}
        disabled={props.disabled}
        onPress={() => setOpen(!open)}
        style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}
      >
        <Text style={{ color: "#8b9099", fontSize: 16 }}>⋯</Text>
      </Pressable>
      {open && (
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 36,
            minWidth: 200,
            padding: 4,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#2e3238",
            backgroundColor: "#24272c",
            zIndex: 10,
          }}
        >
          {props.items.map((item) =>
            "separator" in item ? (
              <View key={item.id} style={{ height: 1, backgroundColor: "#2e3238", marginVertical: 4 }} />
            ) : (
              <Pressable
                key={item.id}
                onPress={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                style={{ paddingHorizontal: 10, paddingVertical: 8 }}
              >
                <Text style={{ color: item.destructive ? "#ef6a6a" : "#e8e9eb", fontSize: 13 }}>{item.label}</Text>
              </Pressable>
            ),
          )}
        </View>
      )}
    </View>
  );
}
