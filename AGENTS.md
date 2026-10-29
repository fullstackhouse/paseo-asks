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
- Nudge classifier = child agent via `agents.create` (owner's provider, cheapest model, `outputSchema`, `autoArchive`). Plan mode makes it explore and call AskUserQuestion; Claude fences the JSON in prose, so parse loosely.
- Plugin subprocess runs under Paseo's Electron helper: the bridge runs with `ELECTRON_RUN_AS_NODE=1`.

## Commands

- `npm run typecheck` (client and server tsconfigs), `npm test` (vitest).
- `npm run e2e`: real Paseo daemon (`e2e/` pins `@getpaseo/cli` and Claude Code) in a temp `--home` and `HOME`, plugin installed, Haiku agents answered from `e2e/cassettes/` by a local proxy (`ANTHROPIC_BASE_URL`). No network, runs in CI. After changing a scenario, a prompt, or anything the model sees (nudge text, tool output), re-record: `npm run e2e:record` with `OPENROUTER_API_KEY` in the env or `e2e/.env` (the proxy adds it; agents only see a dummy key), then commit the cassette. A replay miss fails the run and lists the unmatched request.
- Verify every change in a separate Paseo, never the main daemon (a reload swaps the plugin under running agents; never restart it). Setup is in the Paseo fork (`~/src/fsh/paseo`): `docs/development.md` "Test a change next to your main Paseo", `docs/plugins.md` "Test a plugin change". In short: from a Paseo checkout, `npm run dev:seed-home`, point `plugins.paseo-asks.path` in `.dev/paseo-home/config.json` at this worktree (link `node_modules` in), start `scripts/dev-daemon.sh` and `scripts/dev-app.sh` with a free `PASEO_LISTEN`/`EXPO_PORT`, `paseo run --home .dev/paseo-home --provider claude/claude-haiku-5-5 ...` to raise asks, then drive the web app with Playwright. Reload with `paseo plugin reload paseo-asks --home .dev/paseo-home` (`plugin ls` must say `running`).
- Act on an ask from a terminal: POST `/act` on the port in `~/.paseo/plugin-data/asks/server.json` with its bearer token.
