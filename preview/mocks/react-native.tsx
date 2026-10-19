import { icons } from "lucide-react";
export { ScrollView, TextInput } from "react-native";

export function Icon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  const Lucide = icons[name as keyof typeof icons];
  if (!Lucide) throw new Error(`Unknown Lucide icon ${name}`);
  return <Lucide size={size} color={color} />;
}

export function useToast() {
  return { show: (message: string) => console.log(message), error: (message: string) => console.error(message) };
}
