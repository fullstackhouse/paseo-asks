# Simplify the ask card — area E, where the card sits

Map: [simplify-ask-card-ui-map.md](./simplify-ask-card-ui-map.md). Cards only, no mockups (map decision 1). Each surface hosts the area A card unchanged; these cards note only what the surface adds.

## Area-wide

- **Rule.** No surface adds its own answer buttons. Everything you can do to an ask is on the card (A1) or its ⋯ menu (A2).

## E1 Chat card (P1)

- **Short.** The ask, inline in the agent's chat where it called `ask_create`, `ask_update` or `ask_resolve`.
- **Extended.** The agent's latest call on an ask shows it live (A1–A4), with the answer bar below the content like every other surface; today's actions-above-the-body order goes. Earlier calls show a folded, read-only row "as that call left it". This change leaves those rows alone apart from the ★, which they keep because their chips have no primary style. *Open chat* is never offered here for the agent you are in.
- **Get here.** Scroll the agent's chat.
- **Variants.** Live open ask expanded; earlier version folded; body behind *Details* when the fold setting is on.

## E2 Workspace Asks panel (P1)

- **Short.** The workspace's asks, grouped *Needs you* then *In progress*.
- **Extended.** Rows start collapsed; expanding one shows the card. In the Explorer the panel is narrow (about 320 px), so the card lays out at phone width there: action labels wrap and ⋯ ends the last row.
- **Get here.** The panel's tab, the Explorer + menu, or ⌘K "Open asks for this workspace".
- **Variants.** Main area width; Explorer width; empty ("No open asks in this workspace.").

## E3 Asks screen (P1)

- **Short.** Every workspace's asks, filtered by *Needs you*, *In progress* and the rest.
- **Extended.** Each row adds the workspace name; one row expanded at a time. Answering moves the row to its new filter.
- **Get here.** *Asks* in the sidebar header.
- **Variants.** Needs you with rows; a filter with none (its empty message).

## E4 Composer pill popover (P1)

- **Short.** This workspace's asks from the composer, this agent's first.
- **Extended.** A narrow popover: the card at phone width. *Refresh asks* at the bottom tells the agent to bring its asks up to date. Asks from other agents keep *Open chat* in their ⋯ menu.
- **Get here.** The question-bubble pill in an agent's composer, shown while something waits on you.
- **Variants.** This agent's ask expanded; another agent's ask expanded.

## E5 Overview entry (P1)

- **Short.** One waiting ask per row in the host's Overview, *Your move*.
- **Extended.** The host keeps one entry open at a time; expanding shows the card. Answering removes the row once the ask stops waiting on you.
- **Get here.** Overview, *Your move* (FSH host).
- **Variants.** Collapsed; expanded.
