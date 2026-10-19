import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Renders the plugin's real client components in a browser, with the Paseo host modules mocked.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: here("./node_modules/react-native-web") },
      { find: /^@getpaseo\/plugin\/client\/react-native$/, replacement: here("./mocks/react-native.tsx") },
      { find: /^@getpaseo\/plugin\/client\/ui$/, replacement: here("./mocks/ui.tsx") },
      { find: /^@getpaseo\/plugin\/client$/, replacement: here("./mocks/client.tsx") },
      { find: /^@getpaseo\/plugin$/, replacement: here("./mocks/plugin.ts") },
    ],
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  server: { fs: { allow: [here("..")] } },
});
