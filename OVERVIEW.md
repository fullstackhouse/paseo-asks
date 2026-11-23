Asks lifts what your agents need from you out of their chats and into one list. When an agent needs a decision, an answer, a follow-up approved, a manual step done or the next move on a PR, it asks with its own question tool (Claude Code's AskUserQuestion, Codex's request_user_input), and Asks lists the question with every other chat's. You answer it there or in the chat, or press **Answer later**: the agent carries on without it, and your answer reaches it as a message when you send it. Agents without a question tool record an ask instead, with the buttons that answer it.

## How it works

Every agent created after the plugin is installed gets an `asks` MCP server. Its instructions tell the agent to ask with its own question tool and to write each question for someone who hasn't seen the work. Its four tools (`ask_create`, `ask_update`, `ask_resolve` and `ask_list`) keep older asks up to date and serve agents without a question tool. If an agent ends a turn waiting on the human without asking, it gets one reminder. Pressing a button sends the agent a message that starts with `[asks]`. If the agent is in the middle of a turn, the message joins that turn when its provider allows it, and otherwise waits until the turn ends, so it never interrupts. Messages are written to disk before they are sent, so a plugin restart does not lose them.

A scheduled run whose agent leaves asks waiting on you is marked **Needs you** on Paseo's Schedules screen, and you get a notification. Paseo keeps that run's workspace instead of archiving it, so the asks and their buttons stay live. Needs a Paseo host with fullstackhouse/paseo#106.

## Where you see asks

- **Asks** panel in each workspace.
- **Asks** screen in the sidebar, with every workspace's questions and asks and a count of what is waiting. Questions you put off wait under **Later**, out of the count. Snoozed workspaces stay out of the count.
- Inline in the agent's chat: each ask appears where the agent created, updated or resolved it. The latest of those is kept up to date, with open asks expanded and their buttons ready; earlier ones show the ask as it was then. Agents create the ask at the end of their reply, so the buttons sit right below the explanation, with the ask's full text under them.
- **Asks** pill in an agent's composer, showing a question-bubble icon and its open count, hidden when there are none. Pressing it lists that agent's asks and offers **Refresh asks**, which tells the agent to bring them up to date.

From an ask you can pick one of its actions, reply with a note, mark it done or drop it, or open a side chat to talk it through. The side chat starts read-only and already has the ask in context. When you settle it there, the main agent gets the outcome as one message. PR asks show live status from `gh` when `gh` is installed, including preview deployment links. An agent can subscribe to be told when its PR merges, closes, its checks change or its review decision changes. A setting holds requested changes back as an ask with an Address button, so the agent starts on a review only when you say so.

## Limits

- Agents created before the plugin was installed do not have the tools.
- Asks are stored as JSON under `~/.paseo/plugin-data/asks/` on the daemon machine. Nothing leaves it.
- Lists refresh every few seconds rather than instantly.
- Codex has a question tool outside Plan mode only with its `default_mode_request_user_input` feature on; without it, Codex agents record asks.
