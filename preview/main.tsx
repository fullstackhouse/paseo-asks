import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Text, View } from "react-native";
import { AsksView } from "../client/AsksView";

const theme = {
  colors: {
    surface0: "#121316",
    surface1: "#1a1c20",
    surface2: "#24272c",
    border: "#2e3238",
    foreground: "#e8e9eb",
    foregroundMuted: "#8b9099",
    accent: "#7c8cff",
    accentForeground: "#0d0f1a",
    statusSuccess: "#4cc38a",
    statusWarning: "#e5a54b",
    statusDanger: "#ef6a6a",
  },
};

function Frame(props: { id: string; title: string; width: number; height: number; children: React.ReactNode }) {
  return (
    <View testID={props.id} style={{ width: props.width, height: props.height, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: theme.colors.border }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{props.title}</Text>
      </View>
      <View style={{ flex: 1 }}>{props.children}</View>
    </View>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Frame id="panel" title="Asks · shop-api" width={620} height={620}>
      <AsksView theme={theme} compact={false} workspaceId="api" openAgent={() => {}} />
    </Frame>
    <Frame id="phone" title="Asks" width={390} height={720}>
      <AsksView theme={theme} compact openAgent={() => {}} />
    </Frame>
  </QueryClientProvider>,
);
