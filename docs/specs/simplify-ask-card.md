# Simplify the open ask card

Status: draft, waiting for approval. Reviewed at `52e68f5` (`client/AsksView.tsx`).

## Context

**Personas**

- **Owner** (the one human running the agents): checks many times a day on desktop, either in the chat or in the Explorer Asks panel, and sometimes on a phone. Wants to unblock agents fast.
- **Owner on a phone** (same person, narrow screen): only clears the obvious ones and leaves the rest for desktop.

**Top scenarios, ranked**

1. Press the agent's suggested move ("QA-approve + merge").
2. Tell the agent something else ("no, fix the docs preview first").
3. Close an ask the owner no longer needs: done it myself, or don't pursue it.
4. Rare: talk the ask through in a side chat (Discuss), or jump to the agent that raised it (Open chat).

**What each thing on the card is for**

- Agent actions: the answers the agent prepared. This is why the card exists.
- PR line and preview chips: show whether the suggested move is safe right now.
- Note field: free-text answer, or a note sent along with any button.
- Reply / Done / Drop: built-in ways to answer when the agent's actions don't fit.
- Discuss: a read-only side chat about this one ask.
- Open chat: go to the agent that raised the ask.

## Current state

An open PR ask, expanded (screenshot in the request; `AskDetail`, `client/AsksView.tsx:572`):

| Row | Contents |
|---|---|
| PR line | `PR #1265 open · checks ✓ · review required` |
| Chips | 2 preview deployments |
| Agent actions | `QA-approve + merge #1265 ★` (primary), `Changes` |
| Note | 3-line textarea, "Note or reply (optional)" (`:678`) |
| Built-in actions | `Reply` (disabled until text is typed, `:696`), `Done` (`:702`), `Drop` (`:708`), `Discuss` (`:720`), `Open chat` (`:727`) |

That is **7 buttons in two rows of equal visual weight** below the agent's own two, plus an input. In the chat view `Open chat` is hidden for the agent viewing it, so the chat shows 6.

**Scenario cost (counted on the card above)**

| Scenario | Clicks | Controls to scan before acting |
|---|---|---|
| 1. Suggested move | 1 | 8 (7 buttons + input) |
| 2. Other answer | 2 + typing (focus, Reply or Enter) | 8 |
| 3. Done / Drop | 1 | 8 |
| 4. Discuss / Open chat | 1 | 8 |

## Findings

Ranked by effect on scenario 1.

1. **Rare and destructive actions sit next to the main one.** Rule: main-scenario, "only the main scenario's action visible, rare lifecycle and destructive actions together under one ⋯ menu". Evidence: `:693-729` renders Done, Drop, Discuss, Open chat as always-visible buttons. Drop (ends the ask, tells the agent not to pursue it) is one click away from Done and styled the same. Impact: the owner scans 8 controls to press 1.
2. **Three ways to talk to the agent, shown as three buttons.** Reply (to the main agent), Discuss (side chat), Open chat (navigate). Rule: main-scenario, "each step offers one forward action". Evidence: `:696`, `:720`, `:727`. Impact: Reply is the common one; the other two are rare.
3. **The Reply button is a disabled button that duplicates Enter.** Rule: main-scenario, "disabled controls only where the user can unlock them and the reason shown". Evidence: `:696` disabled until text; `:680-689` Enter already sends on web. Impact: one dead button always on screen.
4. **The note field takes three lines while empty.** Rule: scope, controls sized for real data. Evidence: `styles.input`, `multiline`, `:675`. Most answers are a button press, not text.
5. **Labels restate what the card already shows.** Rule: scope, "free of text that restates its container"; naming, "each label states the effect". Evidence: `★` on a button already drawn as primary (`:632`); `#1265` in the action label while the PR line shows it. `Done` and `Drop` don't say their effect (mark resolved vs. tell the agent to stop).

Passes: PR line and preview chips each serve scenario 1 (is it safe to merge?) and stay.

## Desired state

```
PR #1265 open · checks ✓ · review required
● pr-1265.casteo.dev   ● docs-pr-1265.casteo.dev
[ QA-approve + merge ] [ Changes ]                          ⋯
[ Reply to the agent…                                     ➤ ]
```

- **Content first, answers last.** The body, PR line and chips come first; every way to answer sits together at the bottom: the agent's actions with ⋯ at the row's end, then a full-width reply field (replies are often a sentence or more). Same order in the chat (today it puts actions above the body).
- **Recommended action is primary**, no `★` on live cards (the snapshot row at `:486` keeps it, since its chips have no primary style).
- **One reply field**, full width, starts at one line and grows to about 6 lines as you type. A send icon inside it appears once there is text; Enter sends on web. Removes the `Reply` button.
- **One `⋯` menu** at the end of the action row (beside the reply field when there are no actions), holding:
  - `Mark done`
  - `Discuss in side chat` (`Open discussion` when one exists)
  - `Open chat` (hidden for the agent viewing it, as today)
  - separator, then `Drop ask` (destructive tone)
  
  Text typed in the reply field still goes along with whichever item is chosen, as today.
- **Agent instructions** (`server/service.ts`): action labels are verb + object, no PR number (the card shows it).

**Scenario cost after**

| Scenario | Clicks | Controls to scan |
|---|---|---|
| 1. Suggested move | 1 | 4 (2 actions, ⋯, input) |
| 2. Other answer | 2 + typing | 4 |
| 3. Done / Drop | 2 (was 1) | 4, then the menu |
| 4. Discuss / Open chat | 2 (was 1) | 4, then the menu |

Scenarios 3 and 4 gain a click; they are the rare ones, and Drop moves out of reach of a stray press.

## What stays

- Every capability: Reply, Done, Drop, Discuss, Open chat, a note with any of them.
- PR line, preview chips, links, orphaned notice.
- Snapshot (earlier version) rows, unchanged.
- No data or protocol change; `act` keeps its four verbs.

## Decisions (2026-11-23)

1. *Mark done* lives in the ⋯ menu only (A2).
2. Phone layout: ⋯ ends the last action row; the reply field spans the card below (atlas review). This replaces the header-row idea.
3. Content first, answer bar at the bottom, on every surface including the chat (atlas review).
4. The ⋯ menu comes from a new `Menu` export in the plugin SDK (`@getpaseo/plugin/client/ui`), backed by the host menu engine: popover on desktop, sheet on phones (A1). This needs a paseo (FSH) PR before the card PR.
5. The reply field never shares a row with buttons: full width, grows with its text (A7 review).

## Next step

Atlas: [`docs/prototypes/ask-card/`](../prototypes/ask-card/index.html), with cards in [simplify-ask-card-ui-card.md](./simplify-ask-card-ui-card.md). Once it is signed off, two PRs, in this order:

1. paseo (FSH): a `Menu` export in `@getpaseo/plugin/client/ui`, on the host menu engine.
2. paseo-asks: the card (answer bar, ⋯ menu, header status badge, no ★ or PR number on live buttons), plus the action-label rule in the agent instructions.
