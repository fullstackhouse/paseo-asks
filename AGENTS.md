# paseo-asks

Paseo plugin: agents record what they need from the human (asks) via MCP; Paseo lists them with action buttons; answers go back to the agent.

## Layout

- `index.server.ts` wires everything. `server/`: `store` (one JSON per workspace), `outbox` (disk-backed, holds messages until the agent's turn ends), `service` (MCP tools + human actions + agent instructions), `bridge` (stdio MCP script, written to the data dir at start), `listener` (localhost HTTP the bridge calls), `agents` (agentId → workspaceId), `discuss` (read-only side chat, child of the owner), `github` + `watcher` (live PR state via `gh`, subscriptions), `last-output` (each agent's latest reply, seeds side chats).
- `client/` + `index.client.tsx`: React Native only (runs on mobile). Colors from `theme.colors`. Open URLs with `openExternalUrl` (default browser); `window.open` opens an unauthenticated in-app Paseo window. Client code can import only host modules, hence the in-house `shared/markdown.ts`.
- `shared/asks.ts`: Zod schemas and RPC contracts.
- `preview/`: own package.json; renders `client/` with react-native-web and mocked host modules for screenshots (`docs/*.png`). Not shipped.

## Load-bearing facts (Paseo 0.12)

- The stdio bridge inherits `PASEO_AGENT_ID` from the agent process; that is how a tool call knows its caller. The HTTP MCP option cannot do this.
- `agents.ref(id).send()` interrupts a running turn unless `activeTurnBehavior: "steer"`. The outbox also waits for idle.
- `useWorkspace`/`useAgent` throw outside a workspace panel (e.g. the global Asks screen); resolve names on the server instead.
- Plugin server code cannot write settings, so clients poll (`POLL_MS`).
- Claude plan mode prompts even for `toolPolicy.preapproved` MCP tools; the server auto-allows `mcp__asks__*` via `agent.permission_requested`.
- Plugin subprocess runs under Paseo's Electron helper: the bridge runs with `ELECTRON_RUN_AS_NODE=1`.

## Commands

- `npm run typecheck` (client and server tsconfigs), `npm test` (vitest).
- After edits: `paseo plugin reload paseo-asks`, then `paseo plugin ls` must say `running`; logs via `paseo plugin logs paseo-asks`. Never restart the daemon.
- Act on an ask from a terminal: POST `/act` on the port in `~/.paseo/plugin-data/asks/server.json` with its bearer token.
