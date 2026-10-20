Asks lifts what your agents need from you out of their chats and into one list. When an agent needs a PR reviewed, a decision made, a follow-up approved or a manual step done, it records an ask instead of burying the question in its transcript. Each ask has the buttons that answer it, such as the options of a decision or "merge" for a PR.

## How it works

Every agent created after the plugin is installed gets an `asks` MCP server with four tools: `ask_create`, `ask_update`, `ask_resolve` and `ask_list`. The server's instructions tell the agent when to use them. If an agent ends a turn on a question without recording an ask, it gets one reminder. Pressing a button sends the agent a message that starts with `[asks]`. If the agent is in the middle of a turn, the message waits until the turn ends, so it never interrupts. Messages are written to disk before they are sent, so a plugin restart does not lose them.

## Where you see asks

- **Asks** panel in each workspace.
- **Asks** screen in the sidebar, with every workspace's asks and a count of what is waiting.
- **Asks** pill in every agent's composer, showing its open count or "No asks". Pressing it lists that agent's asks and offers **Refresh asks**, which tells the agent to bring them up to date.

From an ask you can pick one of its actions, reply with a note, mark it done or drop it, or open a side chat to talk it through. The side chat starts read-only and already has the ask in context. When you settle it there, the main agent gets the outcome as one message. PR asks show live status from `gh` when `gh` is installed. An agent can subscribe to be told when its PR merges, closes, or its checks change.

## Limits

- Agents created before the plugin was installed do not have the tools.
- Asks are stored as JSON under `~/.paseo/plugin-data/asks/` on the daemon machine. Nothing leaves it.
- Lists refresh every few seconds rather than instantly.
