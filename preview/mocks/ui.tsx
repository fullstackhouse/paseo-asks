import { Text, View } from "react-native";

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
