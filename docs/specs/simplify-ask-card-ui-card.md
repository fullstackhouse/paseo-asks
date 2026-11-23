# Simplify the ask card — area A, the card

Map: [simplify-ask-card-ui-map.md](./simplify-ask-card-ui-map.md). Spec: [simplify-ask-card.md](./simplify-ask-card.md).

## Area-wide

- **Who.** The owner, answering the agents. On desktop in the chat or the Explorer, and sometimes on a phone.
- **Frame.** One card, drawn at desktop width (about 560 px, the chat column) and phone width (360 px). The card has no route of its own. Every E surface hosts the same component.
- **Header row.** Kind icon, ask id, title (one line while collapsed), PR badge when it has a PR, *orphaned* when its agent is archived, age. Tapping the header collapses or expands the card.
- **Order inside.** Content first, then the answer bar, on every surface including the chat: body → links → PR line → preview chips → answer bar. You read the ask before you answer it.
- **Answer bar.** Every way to answer sits in one row at the bottom of the card, left to right: the agent's actions, the reply field taking the remaining width, then ⋯. If the row is too narrow (under about 200 px left for the field), the reply field and ⋯ wrap onto their own row below the actions. A card with no actions has the reply field and ⋯ alone.
- **Feedback.** Any answer disables the card's controls until the server confirms. The card then re-renders in its new state, and the reply field clears.
- **Errors.** A failed answer shows the error in a toast, and the reply field keeps its text.
- **Permissions.** None. Whoever has the app answers.
- **Labels.** The ★ and the PR number never appear on live buttons: primary styling marks the recommended action, and the PR line carries the number.

## A1 Open ask (P1)

- **Short.** The ask waiting on you, with the agent's answers, a reply field and a ⋯ menu.
- **Extended.** Shows the agent's actions, with the recommended one in primary style. A *send* action hands the instruction to the agent and moves the ask to A3. A *resolve* action records the choice and closes the ask as A4. An *open* action opens its URL and leaves the ask as it is. The reply field is one line and grows as you type. A send icon inside it appears once there is text. On web Enter sends and Shift+Enter adds a line; on phones Return adds a line and you tap send. ⋯ at the end of the answer bar opens A2. Text in the reply field goes along with whichever action or menu item you press next.
- **Get here.** Expand a row on any E view. In the chat, the card for the agent's latest call on an open ask is already expanded.
- **Shows.** Header row. Body (markdown; in the chat behind a *Details* link when Settings → Plugins → Asks folds bodies). Links. PR line (`PR #1265 open · checks ✓ · review required`). Preview chips. The answer bar: agent actions, the reply field "Reply to the agent…", ⋯.
- **Scenarios.** QA-approve and merge PR #1265 in one tap. Answer "fix the docs preview first" instead. Pick option b of a decision.
- **Variants.**
  - PR ask: checks passing, two preview chips, two actions.
  - Decision with four options, one recommended.
  - Question with no agent actions: the answer bar is the reply field and ⋯.
  - Decision with four options: the options fill the first row, and the reply field and ⋯ wrap below.
  - Reply field with text, send icon showing.
  - Phone width: actions wrap, and the reply field and ⋯ take their own row below them.
  - Orphaned: notice "The agent that raised this is archived. Closing it here notifies nobody."
- **Edge cases.**
  - Checks failing → the PR line shows `checks ✗` in the error tone. The agent decides whether to keep its *Merge when green* action.
  - Has conflicts → the PR line adds `has conflicts`.
  - A preview deploying or failed → its chip shows `◌ deploying …` or `✕ failed …` and opens the logs.
  - The answer fails → toast "Could not send: …", and the reply text stays.
  - Answering an orphaned ask → toast "A3 closed; its agent is gone, so nobody was told."

## A2 More menu (P1, menu on A1)

- **Short.** The rare and closing moves, out of the way of the main one.
- **Extended.** Items, in order:
  - *Mark done*: you did it yourself; closes the ask as done and tells the agent.
  - *Discuss in side chat*: opens a read-only child chat about this ask; becomes *Open discussion* once one exists.
  - *Open chat*: goes to the agent that raised the ask.
  - A separator, then *Drop ask* in the destructive tone: closes the ask and tells the agent not to pursue it.
  - Text in the reply field goes along as the note; the labels don't change. Picking an item closes the menu. A popover on desktop, a bottom sheet on phones.
- **Get here.** ⋯ on A1, A3 or A4.
- **Shows.** Up to four items with a separator before *Drop ask*.
- **Variants.**
  - Desktop popover, all four items.
  - In the raising agent's own chat: no *Open chat*.
  - Discussion already open: *Open discussion*.
  - Phone bottom sheet.
  - On A3 (in progress): *Mark done*, *Discuss*, *Open chat*, *Drop ask*.
  - On A4 (closed): *Discuss*, *Open chat* only.
- **Edge cases.**
  - Orphaned ask → no *Discuss*. *Mark done* and *Drop ask* close it silently, and the toast says nobody was told.
  - Discuss on an agent whose provider has no read-only mode → toast "Side chats need a provider with a read-only mode (Claude)."

## A3 Handed back (P1)

- **Short.** You answered; the agent is working on it.
- **Extended.** No agent actions: the move is the agent's. Shows what you chose and when, in the form "You chose QA-approve + merge · 2 min ago". The answer bar keeps the reply field and ⋯, so you can add "actually, wait" or drop it. The ask returns to A1 when the agent gives it new actions, when its agent is archived, or after a day with the agent not running. In lists it sits under *In progress*.
- **Get here.** A *send* action or a reply on A1.
- **Shows.** Header with the *in progress* badge. The outcome line. Body (collapsed by default outside the chat). PR line and chips, still live. Answer bar: reply field and ⋯.
- **Variants.**
  - Right after you chose a send action.
  - PR checks still running, chips deploying.
  - After a reply, with the note quoted in the outcome line.
- **Edge cases.**
  - The agent's turn ended without moving it → the agent gets one reminder. The card itself doesn't change.

## A4 Closed ask (P1)

- **Short.** Done or dropped; kept as a record.
- **Extended.** A collapsed row with the *done* or *dropped* badge in the muted tone. Expanded, it shows who closed it, how, and any note ("Dropped by you: superseded by #1270"), then the body read-only. The reply field stays: a reply reaches the agent, which may reopen the ask. ⋯ offers *Discuss* and *Open chat* only.
- **Get here.** *Mark done* or *Drop ask* on A2, a *resolve* action on A1, or the agent resolving it.
- **Shows.** Header with the status badge. Outcome line. Body. Links. PR line (`merged`/`closed` once the PR is). Answer bar: reply field and ⋯.
- **Variants.**
  - Done by the agent, PR merged.
  - Dropped by you, with a note.
  - Resolved by a decision option ("You chose b: squash-only").
- **Edge cases.**
  - The ask was deleted → the chat card header says "(since deleted)", and there is no body.

## Open questions

1. Where does the ⋯ menu come from: a host `Menu` export in the plugin SDK, or one built in the plugin from `Modal`? (A1; recommended: host export.)
2. Should *Mark done* stay visible next to ⋯? (A2; recommended: menu only. The cards assume menu only.)
