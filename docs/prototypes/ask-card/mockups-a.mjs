// Area A — the ask card: fixtures, the card renderer and the states of A1–A4.
// Anatomy follows client/AsksView.tsx (AskRow → AskDetail, PrDetail, Deployments) as the cards redraw it.
// Frames show only the card: 560 px desktop (chat column), 360 px phone, on surface0.

export const ASK_CARD_ICONS = {
  'more-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  'git-pull-request': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  split: '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'messages-square': '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
}

export function askCardStates({ ic, esc }) {
  const KIND = { pr: 'git-pull-request', decision: 'split', question: 'circle-help' }

  // ── card renderer ────────────────────────────────────────────────────
  // c: { kind, id, title, pr, badge:[text,tone], orphaned, age, outcome, notice, actions:[[label,primary]],
  //      more:{open,popover}, body (trusted html), readOnly, links, prLine:[[text,tone]], chips:[[state,label]],
  //      reply, collapsed, phone, deleted, hideBody }
  function card(c) {
    const p = c.phone ? ' ak-phone' : ''
    const head = `<div class="ak-head"><span class="ak-kind">${ic(KIND[c.kind] || 'circle-help')}</span><span class="ak-id">${esc(c.id)}</span>
      <span class="ak-title">${esc(c.title)}${c.deleted ? ' <em>(since deleted)</em>' : ''}</span>
      ${c.pr ? `<span class="ak-badge ak-badge-${c.pr[1]}">${esc(c.pr[0])}</span>` : ''}
      ${c.badge ? `<span class="ak-badge ak-badge-${c.badge[1]}">${esc(c.badge[0])}</span>` : ''}
      ${c.orphaned ? '<span class="ak-badge ak-badge-warn">orphaned</span>' : ''}
      <span class="ak-age">${esc(c.age || '')}</span></div>`
    if (c.collapsed) return `<div class="ak-card ak-collapsed${p}">${head}</div>`
    const outcome = c.outcome ? `<div class="ak-outcome">${c.outcome}</div>` : ''
    const notice = c.notice ? `<div class="ak-notice">${ic('warn')}<span>${esc(c.notice)}</span></div>` : ''
    const moreBtn = c.more
      ? `<button type="button" class="ak-iconbtn${c.more.open ? ' is-open' : ''}" aria-label="More">${ic('more-horizontal')}</button>${c.more.popover || ''}`
      : ''
    const body = c.body && !c.hideBody ? `<div class="ak-body${c.readOnly ? ' is-readonly' : ''}">${c.body}</div>` : ''
    const links = c.links ? `<div class="ak-links">${c.links.map((l) => `<span class="ak-link">${esc(l)}</span>`).join('')}</div>` : ''
    const prLine = c.prLine ? `<div class="ak-prline">${c.prLine.map(([t, tone]) => `<span${tone ? ` class="ak-${tone}"` : ''}>${esc(t)}</span>`).join('<i>·</i>')}</div>` : ''
    const chips = c.chips
      ? `<div class="ak-chips">${c.chips.map(([s, l]) => `<span class="ak-chip ak-chip-${s}"><b>${{ live: '●', deploying: '◌', failed: '✕' }[s]}</b>${esc(l)}</span>`).join('')}</div>`
      : ''
    // answer bar: row 1 actions with ⋯ at its far end; row 2 full-width reply field (grows). No actions: field + ⋯ on one row.
    const replyField = `<div class="ak-reply${c.reply ? ' has-text' : ''}"><span class="ak-reply-text">${c.reply ? esc(c.reply) : 'Reply to the agent…'}</span>${c.reply ? `<span class="ak-send">${ic('send')}</span>` : ''}</div>`
    const btns = (c.actions || []).map(([l, pri]) => `<button type="button" class="ak-btn${pri ? ' ak-btn-primary' : ''}">${esc(l)}</button>`).join('')
    const bar = c.actions && c.actions.length
      ? `<div class="ak-bar"><div class="ak-actions">${btns}<span class="ak-more-wrap">${moreBtn}</span></div>${replyField}</div>`
      : `<div class="ak-bar"><div class="ak-tail">${replyField}<span class="ak-more-wrap">${moreBtn}</span></div></div>`
    const inner = c.deleted ? '' : `${outcome}${notice}${body}${links}${prLine}${chips}${bar}`
    return `<div class="ak-card${p}">${head}${inner ? `<div class="ak-detail">${inner}</div>` : ''}</div>`
  }

  const menu = (items) =>
    `<div class="ak-menu" role="menu">${items
      .map((i) => (i === '-' ? '<div class="ak-sep"></div>' : `<div class="ak-item${i[2] ? ' is-danger' : ''}" role="menuitem">${ic(i[0])}<span>${esc(i[1])}</span></div>`))
      .join('')}</div>`
  const sheet = (items) =>
    `<div class="ak-scrim"></div><div class="ak-sheet" role="menu"><i class="ak-grab"></i>${items
      .map((i) => (i === '-' ? '<div class="ak-sep"></div>' : `<div class="ak-item${i[2] ? ' is-danger' : ''}" role="menuitem">${ic(i[0])}<span>${esc(i[1])}</span></div>`))
      .join('')}</div>`
  const toast = (t) => `<div class="ak-toast">${ic('alert-circle')}<span>${esc(t)}</span></div>`

  const DONE = ['check-circle', 'Mark done']
  const DISCUSS = ['messages-square', 'Discuss in side chat']
  const OPEN_CHAT = ['message-square', 'Open chat']
  const DROP = ['x-circle', 'Drop ask', true]
  const FULL = [DONE, DISCUSS, OPEN_CHAT, '-', DROP]

  // frame wrappers: the root keeps `frame` so comment pins work
  const desk = (inner, extra = '') => `<div class="frame ak-frame"><div class="ak-screen ak-desk ${extra}">${inner}</div></div>`
  const phone = (inner, extra = '') => `<div class="frame ak-frame"><div class="ak-screen ak-ph ${extra}">${inner}</div></div>`

  // ── fixtures (fictional) ─────────────────────────────────────────────
  const BODY_PR = `<p>The export job dropped rows when a CSV field contained a newline. Fields are now quoted, and the regression test passes.</p><p>Docs preview is attached below.</p>`
  const PR_OK = [['PR #1265 open'], ['checks ✓', 'ok'], ['review required']]
  const CHIPS2 = [['live', 'pr-1265.example.dev'], ['live', 'docs-1265.example.dev']]
  const prAsk = {
    kind: 'pr', id: 'A12', title: 'Ship the export fix', pr: ['checks ✓', 'ok'], age: '4m',
    actions: [['QA-approve + merge', true], ['Request changes']], more: true, body: BODY_PR, prLine: PR_OK, chips: CHIPS2,
  }
  const decision = {
    kind: 'decision', id: 'A14', title: 'Pick a cache strategy for exports', age: '12m',
    actions: [['a: Cache per user', true], ['b: Cache per workspace'], ['c: No cache'], ['d: Defer to next release']], more: true,
    body: `<p>Exports recompute on every request. Option <code>a</code> is the smallest change and keeps results private to the requester.</p>`,
  }
  const question = {
    kind: 'question', id: 'A15', title: 'Which branch should the release cut from?', age: '1h', more: true,
    body: `<p>Both <code>main</code> and <code>release/2.4</code> contain the export fix. Say which one the release should cut from.</p>`,
  }
  const phoneAsk = {
    ...prAsk, phone: true, title: 'Ship the export fix',
    actions: [['QA-approve and merge when checks are green', true], ['Ask the agent to fix the docs preview first'], ['Request changes']],
    body: `<p>The export job dropped rows when a CSV field contained a newline. Fields are now quoted.</p>`,
  }
  const handed = {
    ...prAsk, badge: ['in progress', 'run'], actions: undefined,
    outcome: 'You chose <b>QA-approve + merge</b> · 2 min ago',
  }
  const closedBase = { ...prAsk, actions: undefined, readOnly: true }

  // ── states ───────────────────────────────────────────────────────────
  return {
    A1: [
      { id: 's1', caption: 'PR ask — checks passing, two preview chips, two actions', html: desk(card(prAsk)),
        notes: ['Primary = the agent\'s recommended action. A send action moves the ask to A3; a resolve action closes it as A4; an open action just opens its URL.', 'Any answer disables the card until the server confirms, then the reply field clears.'] },
      { id: 's2', caption: 'Decision — four options, one recommended', html: desk(card(decision)) },
      { id: 's3', caption: 'Question — no agent actions; reply field and ⋯ stand alone', html: desk(card(question)) },
      { id: 's4', caption: 'Reply field with text — send icon showing', html: desk(card({ ...prAsk, reply: 'Hold the merge — the docs preview still shows the old CSV example. Fix that first, then merge.' })),
        notes: ['Web: Enter sends, Shift+Enter adds a line. Phone: Return adds a line, tap send. The field grows as you type.', 'Text in the field goes along with whichever action or menu item is pressed next.'] },
      { id: 's5', caption: 'Phone — long action labels wrap, ⋯ ends the last row', html: phone(card(phoneAsk)) },
      { id: 's6', caption: 'Orphaned — the raising agent is archived', html: desk(card({ ...prAsk, orphaned: true, notice: 'The agent that raised this is archived. Closing it here notifies nobody.' })),
        notes: ['Answering an orphaned ask shows the toast "A12 closed; its agent is gone, so nobody was told."'] },
      { id: 's7', caption: 'Edge — checks failing and merge conflicts', html: desk(card({ ...prAsk, pr: ['checks ✗', 'err'], actions: [['Fix and re-run checks', true], ['Request changes']], prLine: [['PR #1265 open'], ['checks ✗', 'err'], ['has conflicts', 'err'], ['review required']] })),
        notes: ['The agent decides whether to keep its Merge when green action; the card only reports the PR state.'] },
      { id: 's8', caption: 'Edge — a preview deploying, another failed', html: desk(card({ ...prAsk, chips: [['live', 'pr-1265.example.dev'], ['deploying', 'docs-1265.example.dev'], ['failed', 'storybook-1265.example.dev']] })),
        notes: ['Deploying and failed chips open the deployment logs.'] },
      { id: 's9', caption: 'Edge — answer failed: toast, reply text kept', html: desk(`${card({ ...prAsk, reply: 'Fix the docs preview first, then merge' })}${toast('Could not send: the host is unreachable.')}`),
        notes: ['The controls come back enabled and the reply field keeps its text.'] },
      { id: 's10', caption: 'Collapsed — header row only', html: desk(card({ ...prAsk, collapsed: true })),
        notes: ['Tapping the header collapses or expands the card. In the chat, the card for the agent\'s latest call on an open ask starts expanded.'] },
    ],
    A2: [
      { id: 's1', caption: 'Desktop popover — all four items', html: desk(card({ ...prAsk, more: { open: true, popover: menu(FULL) } }), 'ak-tall'),
        notes: ['Items run top to bottom as the card lists them; a separator precedes Drop ask. Picking an item closes the menu.', 'Text in the reply field goes along as the note; the labels do not change.'] },
      { id: 's2', caption: 'In the raising agent\'s own chat — no Open chat', html: desk(card({ ...prAsk, more: { open: true, popover: menu([DONE, DISCUSS, '-', DROP]) } }), 'ak-tall') },
      { id: 's3', caption: 'Discussion already open — Open discussion', html: desk(card({ ...prAsk, more: { open: true, popover: menu([DONE, ['messages-square', 'Open discussion'], OPEN_CHAT, '-', DROP]) } }), 'ak-tall') },
      { id: 's4', caption: 'Phone — bottom sheet', html: phone(`${card({ ...phoneAsk, more: { open: true } })}${sheet(FULL)}`, 'ak-sheet-frame') },
      { id: 's5', caption: 'On a handed-back ask (A3) — Mark done, Discuss, Open chat, Drop ask', html: desk(card({ ...handed, more: { open: true, popover: menu(FULL) } }), 'ak-tall') },
      { id: 's6', caption: 'On a closed ask (A4) — Discuss and Open chat only', html: desk(card({ ...closedBase, pr: ['merged', 'muted'], badge: ['done', 'muted'], outcome: 'Done by the agent · PR merged · 1 h ago', prLine: [['PR #1265 merged']], chips: undefined, more: { open: true, popover: menu([DISCUSS, OPEN_CHAT]) } }), 'ak-tall') },
      { id: 's7', caption: 'Edge — orphaned ask: no Discuss, silent close', html: desk(`${card({ ...prAsk, orphaned: true, more: { open: true, popover: menu([DONE, OPEN_CHAT, '-', DROP]) } })}`, 'ak-tall'),
        notes: ['Mark done and Drop ask close it silently; the toast says "A12 closed; its agent is gone, so nobody was told."'] },
      { id: 's8', caption: 'Edge — provider has no read-only mode', html: desk(`${card({ ...prAsk })}${toast('Side chats need a provider with a read-only mode (Claude).')}`),
        notes: ['Shown after picking Discuss in side chat on such an agent; the menu has already closed.'] },
    ],
    A3: [
      { id: 's1', caption: 'Right after you chose a send action', html: desk(card(handed)),
        notes: ['No agent actions: the move is the agent\'s. Reply field and ⋯ stay.', 'Back to A1 when the agent gives new actions, its agent is archived, or after a day with the agent not running. In lists it sits under In progress.', 'If the agent\'s turn ends without moving it, the agent gets one reminder; the card does not change.'] },
      { id: 's2', caption: 'PR checks still running, a chip deploying', html: desk(card({ ...handed, pr: ['checks …', 'muted'], prLine: [['PR #1265 open'], ['checks running'], ['review required']], chips: [['live', 'pr-1265.example.dev'], ['deploying', 'docs-1265.example.dev']] })) },
      { id: 's3', caption: 'After a reply — the note quoted in the outcome line', html: desk(card({ ...handed, outcome: 'You replied “Fix the docs preview first” · just now' })) },
      { id: 's4', caption: 'Phone', html: phone(card({ ...handed, phone: true })) },
    ],
    A4: [
      { id: 's1', caption: 'Done by the agent — PR merged', html: desk(card({ ...closedBase, pr: ['merged', 'muted'], badge: ['done', 'muted'], outcome: 'Done by the agent · 1 h ago', prLine: [['PR #1265 merged']], chips: undefined })),
        notes: ['A reply here reaches the agent, which may reopen the ask. ⋯ offers Discuss and Open chat only.'] },
      { id: 's2', caption: 'Dropped by you, with a note', html: desk(card({ ...closedBase, pr: ['closed', 'muted'], badge: ['dropped', 'muted'], outcome: 'Dropped by you: superseded by #1270 · 3 h ago', prLine: [['PR #1265 closed']], chips: undefined })) },
      { id: 's3', caption: 'Resolved by a decision option', html: desk(card({ ...decision, actions: undefined, readOnly: true, badge: ['done', 'muted'], outcome: 'You chose <b>b: Cache per workspace</b> · yesterday' })) },
      { id: 's4', caption: 'Phone — dropped', html: phone(card({ ...closedBase, phone: true, pr: ['closed', 'muted'], badge: ['dropped', 'muted'], outcome: 'Dropped by you: superseded by #1270 · 3 h ago', prLine: [['PR #1265 closed']], chips: undefined })) },
      { id: 's5', caption: 'Collapsed row — muted badge', html: desk(card({ ...closedBase, pr: ['merged', 'muted'], badge: ['done', 'muted'], collapsed: true, age: '1h' })) },
      { id: 's6', caption: 'Edge — the ask was deleted (chat card)', html: desk(card({ kind: 'pr', id: 'A12', title: 'Ship the export fix', deleted: true, age: '' })),
        notes: ['No body; the header says "(since deleted)".'] },
    ],
  }
}
