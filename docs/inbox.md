# Inbox: in-progress port

Inbox is a bundled page (`buzz.inbox/inbox`) that opens recent conversations
for the selected community. The stacked evidence, conversation UI and Drafts
PRs are one user-approved Inbox launch batch; none should ship independently.

## Evidence slice (stacked with Inbox UI)

PR3 added no Inbox UI. This page uses `session.unread.inbox()` as its single
conversation projection and `session.inboxFeed` as bounded addressed and participating-thread history
demand. These changes are one launch batch, not a separately shippable
backend feature. Ordinary channel and thread readers, read-state storage and
outbox retain their existing ownership. No projects, approvals or reminders.

## Conversation UI (PR4; Drafts in PR5)

### Archive conversations

Archive in the row button or row context menu removes that conversation from the active Inbox. The Archive shortcut (⌃⌘A on Apple platforms, Ctrl+Shift+E elsewhere; rebindable in Settings → Shortcuts) archives the last opened conversation, or restores it in the archived view, including from the composer. The filter menu groups Type, From, and Status, followed by Drafts. Status switches between Inbox and Archived using the same single-choice highlight as Type; activity and sender selections stay in effect in either view. The existing Unread only toggle stays independent. Status, activity, sender and attention choices are saved on this device for the current account and community, with each missing or invalid choice using its own default. Older saved combined status falls back to Inbox. The toolbar wraps on narrow screens. Choosing Archived opens the archived view, where Restore returns a conversation to Inbox. Archive/Restore row buttons appear on hover or keyboard focus and remain visible without a hover pointer; row actions do not open or mark an unselected conversation read. Archiving the open conversation, from its row, context menu or the shortcut, closes its tab and opens the next visible conversation (or the preceding one at the end), marking it read as a normal selection would; with none remaining, focus returns to the list. Archiving any other row moves focus to the next visible row. Incoming replies and mentions preserve an open archived conversation and its composer draft. When a Type, From or Unread only choice leaves the list empty, Clear filters resets those three and keeps Status; an empty Archived view without them offers Show Inbox. Either returns focus to the filters. Archive records a timestamp watermark, the later of the archive time and the conversation's newest evidence, and the message IDs already observed. A fresh incoming participating-thread reply, Solo top-level response or DM message at or beyond that watermark returns the conversation to its ordinary activity views (Threads or DMs, and All activity); Mentions still requires a fresh explicit mention. DM arrivals reopen the conversation whether they are replies or top-level messages. Already observed replies and replayed older mentions do not reopen it. An archive saved for part of a session's merged top-level row hides that row only when archives cover all of its messages. Reply reopening persists without discarding the mention cutoff, so bounded evidence eviction cannot hide the reopened conversation or resurface its older mentions. A fresh explicit mention retires the saved cutoff; manual Restore clears it in every activity view. Sending a reply does not archive or restore a conversation; Inbox reuses the unchanged shared composer. Archive/filter/selection policy lives entirely in the Inbox plugin. The shared unread evidence owner supplies verified conversation-member facts (`id`, `createdAt`, `mentioned`) through the existing injected `session.unread.inbox()` capability, available to any plugin requesting `relay`. The Inbox plugin uses those facts to retire superseded archive intent; the shared contract contains no Archive state or cutoff policy.

Archive applies only to conversations admitted by the shared Inbox projection; it does not override channel visibility policy or change channel archive state. Archive is personal view intent saved on this device, partitioned by the relay session's community and viewer scope. It persists across reloads and reconnects, with the same-window subscription and cross-window storage notifications as other view intent. Failed saves leave the conversation visible and expose Retry. Archive choices do not synchronize across devices or change unread or notification policy. It does not delete messages or claim a task has finished. The archived view uses the same bounded verified conversation evidence as Inbox, so it is not a permanent full-history archive browser.

Inbox now renders chat-only DMs, Solo conversations, mentions and participating threads through
`session.unread.inbox()`, with independent Activity type and Sender filters and
an independent Unread only toggle. Sender classification uses `session.agentChoices` and
cached/profile-backed identity evidence, never a new inventory or name heuristic.
The Mentions activity filter uses explicit mention messages for each conversation's preview, sender, ordering, resume point and unread count. A later ordinary reply does not make a read mention unread again. DMs remain direct activity rather than mentions merely because their recipient is tagged. All activity and Threads retain their conversation-wide projections. A row shows its newest message and sender, matching its time, while opening it still resumes at the oldest unread message. A Solo chat's top-level row shows the newest top-level message from anyone else, even one that is not Inbox evidence, and is ordered by it. It skips messages addressed only to agents and roots that have their own thread row; unread counts still come only from evidence.
Rows retain exact IDs and current names while `inboxFeed.incomplete` marks only specific group members awaiting their stored edit/deletion closure. Those rows say “Preview updating…” or “Preview unavailable. Retry inbox.”; other rows stay usable. This is a visible completeness warning, not a guarantee that the relay did not change after verification. A failed read exposes Retry above the list. Retry stays focusable while pending; successful recovery returns focus to the Show filter only if Retry still owned focus when its alert was removed.

The list is the Inbox page's first tab, in the host tab workspace behind `conversation.ui.Tabs`. Opening a row shows its conversation beside the list in the side tab pane, with the same reader and composer as Channels tabs: a thread at its exact message, revealed even outside the newest bounded page, or a whole DM or session conversation where its Channels tab would open. A plain open replaces the tab the previous one added, so one tab follows the selection; a tab moved to the main pane stays. The tab's right-click menu offers Open in channel, which opens its conversation in Channels; a thread opens there at the same message. A thread also names its conversation above its original message, as the rows do (`#channel` or `DM · names`); that name is a link that does the same. The pane resizes, closes and handles Escape as Channels' does. A late verified root can regroup a conversation without changing its open tab. Inbox tabs do not enter a channel visit, so showing one preserves forced-unread intent. Reading is saved by the shared unread owner, through the reader's dwell and the row's explicit read. Failed read actions retain their captured Retry unless access, the session or a newer intent retires it. A DM Retry reuses the original channel cutoff and manual-clear keys, not the retry-time clock or later arrivals. Re-clicking the selected row reselects its tab without repeating its read. Closing the tab ends the selection, so reopening the row reads it again. Archiving the selected conversation's channel, or its room becoming a Huddle, closes its tab and returns focus it held to the filters, and restoring the channel does not reopen it; other retained tabs follow Channels' unavailable placeholder, and focus their reader held moves to the tab. Re-clicking the selected row reveals its current message in its tab; a session mention that regrouped into a thread reselects its timeline tab. Context menus allow device-local Mark unread. Row accessible descriptions reuse the visible safe preview or incomplete placeholder; Show more follows the filtered result count. `NavigationItem` owns selected styling and `aria-current`. No Inbox-owned session, parallel fold, composer or outbox.

Solo chats include ordinary incoming top-level messages, excluding agent-only coordination and system events. Their flat rows appear under All and DMs; nested threads stay separate. Reading in Channels or Inbox clears the same evidence. Finite discovery fetches surviving incoming Solo activity independently of the aggregate channel sample, paging past self, quiet and deleted messages.

### Open Inbox with a filter

Four shortcuts open the Inbox page with its filters applied, including from the composer, like Slack's: ⌘⇧A (Ctrl+Shift+A elsewhere) opens All activity with Unread only, and ⌘⇧T, ⌘⇧M and ⌘⇧K open Threads, Mentions and DMs. Each also shows Inbox rather than Archived and leaves Drafts. Threads, Mentions and DMs keep the saved Unread only choice; Sender is never changed. They are rebindable in Settings → Shortcuts. The shortcut opens `buzz.inbox/inbox` with a versioned route (`{ attention?: "unread", activity? }`) that the page validates, and a plain open from the sidebar or topbar carries none and leaves saved filters alone. The page applies a route once per presentation of the visit, but not when Back/Forward returns to it, which keeps the filters as they were left, using the same saved choices as the filter menu, so pressing a shortcut again after changing the filters by hand applies it again, even though the host treats an identical address as the same history entry.

## Navigation badge

The Inbox navigation entry shows, in the sidebar's subtle count chip, how many
conversations in the default Inbox view are unread: every activity type and
sender, excluding archived ones. It counts conversations, not messages, showing
99+ above 99. It
reads the same `session.unread.inbox()` projection and device-local archive
state as the page. Once the channel roster is ready it ensures only the shared
unread evidence the sidebar already loads, so DMs, recent mentions and recent
or live thread replies count before Inbox is first opened. The addressed feed
and older-thread history are read when Inbox opens, not at launch; their
conversations then join the count. Its unread count is part of the entry's
accessible name. It ignores the page's saved filters. Because the badge keeps the projection subscribed for the whole
session, `inbox()` folds each channel's own rows (plus shared overlays) rather
than every retained event per channel.

## Drafts (PR5)

Drafts is a quiet Inbox header action. It lists only meaningful saved composer
text in this viewer/community scope, up to 500 with explicit truncation; an
emptied selected editor stays open until send, close or confirmed delete. The
list preserves the Inbox row hierarchy and supports channel, DM and exact-root
thread coordinates. Only the selected draft loads history through the existing
channel window or ThreadPanel; thread composition waits for a verified matching
root, and a deleted/malformed root never rebinds its saved text. The shared
composer and session outbox retain recipient, admission, signing and delivery
rules. A selected channel/DM draft opens at the real returned tail without
reading or overwriting the canonical saved scroll position. The origin action
navigates separately and reports failure without dismissing the editor.

The selected editor's lifetime does not depend on list-summary eligibility. Rich
saved envelopes use an 8 MiB preview bound rather than the former 128 KiB text-sized
cutoff; larger records receive an explicit notice instead of a false empty list.
The shared composer reconciles an untouched editor with saved changes from another
window. Locally edited documents remain in place with **Load saved draft** and
**Keep my draft** choices; Send cannot silently use a conflicted document.
Foreground revision checks also prevent an observed replacement being overwritten
by stale send cleanup. These checks are not a cross-window storage transaction.

Outbox acceptance and saved-draft replacement are separate outcomes. Drafts closes
after replacement succeeds, not merely after acceptance. If no draft was ever saved
and a fresh read still confirms absence, persistent write failure does not lock the
composer after acceptance: no stale sent text needs cleanup. A nonempty unsaved
agent follow-up stays editable with a save warning. Existing or unreadable saved
revisions retain the accepted-message recovery state and offers **Retry draft cleanup**, never another
Send of that accepted body. Recovery survives composer remounts within the same
session; it is RAM evidence, not a new durable receipt or a guarantee across app
restart. Existing outbox delivery/retry ownership is unchanged.

Delete is consentful and device-local. Confirm moves keyboard focus to the
actual destructive button; Cancel restores its trigger. After **successful**
scoped saved-text cleanup, the existing attachment-draft owner clears only the
same session/destination files and aborts its pending uploads. A failed text
cleanup preserves files and text for retry; sibling channel/thread drafts and
other viewers are untouched. Successful Close, Delete and saved Send restore focus
to the invoking draft row, another remaining row, or Back to Inbox; callbacks from
an earlier visit cannot retire a later selection. Failed Delete keeps its retryable
confirmation focused. This is not a new persisted index or migration.


## Ownership and limits

`session.unread.inbox()` / `subscribeInbox()` own retained verified unread
evidence and read actions. `session.inboxFeed` owns finite, verified addressed
history demand and exact incomplete-target metadata, not a row cache. Finite
results and live arrivals, edits and deletions use the existing session admission
and shared unread fold, so own/deleted messages stay absent and unresolved roots
never become duplicate conversations. Current membership gates the feed's
completeness targets and unread's rows; joining alone does not materialize
pre-membership history without fresh shared admission. Inbox renders those shared
conversation rows directly; there is no second project/approval row merge or
feed-owned reconciliation buffer and deletion-count abort.

Channel-archived rooms are excluded from the shared Inbox projection in every
activity view. Signed archive/unarchive metadata invalidates that projection even
when membership and channel type stay unchanged. Archiving removes their rows and
closes a selected Inbox detail, without clearing retained evidence or read/local-unread
intent. Unarchiving makes retained conversations eligible again; it does not
reopen the detail. Ordinary Channels/search retain member history access and
archived posting restrictions. This is Inbox eligibility, not access revocation or
notification policy.

PR4 owns only presentation, filtering and selection. No parallel signing or persistence is
added. Optional profile enrichment belongs to PR4; access, cache clear and
session retirement fence these projections. Opening Inbox does not mark rows
read; selecting an unread row does. Canonical Messages keeps its own reading
behavior.

A DM is one conversation row, and so is a session's flat top-level timeline;
Inbox opens that session row in the channel reader. Elsewhere, including session
threads, each thread root or top-level message is its own row; a session message
whose replies are in Inbox stays with its thread.

DM read clears the channel through its newest retained evidence. Thread read
advances the thread prefix, including earlier unshown replies, plus individually
represented top-level mentions and local message marks, but not unrelated
messages. Participation follows the shared unread owner's direct-parent policy,
including its existing bounded lookups for replies whose membership is undecided.
Fetched roots and participation witnesses remain structural, never extra Inbox rows.
A lookup-only root uses the existing exact-message manual-unread target until counted
root evidence arrives; its known root still supplies grouping and read-through.
Relevant replies remain thread activity even when the root cannot be fetched.
Multiple steps are not atomic: failures leave remaining evidence retryable. Manual unread is local to this device. Hosts without frontier-sync
disable read mutations. Saved frontiers are not proof of remote reconciliation.

This is **bounded recent evidence**, not a complete historical inbox. Unread
retains at most 4,096 events / 8 MiB, observing up to 500 recent events per
128-channel roster batch. A lazy addressed query returns up to 50 kind-9/40002
messages. For those exact IDs and unresolved failed targets, general `#e`
queries page signed kind-40003 edits and kind-5/9005 deletions, then deletions
of the edits; `include_aux` on an ordinary `#p` query is not a supported relay
contract. Both auxiliary stages must finish before the feed is ready. Retained
unread evidence can be provisionally admitted between queries, but exact target
IDs are marked incomplete **before** unread subscribers are notified. The
consumer must not show their body as current while incomplete; failures retain
that metadata and offer retry. This is a completeness signal, not atomic content
admission or a second message fold. A mention outside the latest 50 addressed
rows is not discovered by that query; if a failed target falls outside a later page its
bounded auxiliary check still runs before its incomplete flag is cleared.
Incomplete obligations survive disconnect and unrelated access revocation while
the corresponding readable unread evidence survives; full cache/session retirement
clears both. Tombstone checks include retained author edits even if a later relay
query omits their soft-deleted rows. If reference visibility withholds an auxiliary
event, the finite attempt stays failed/incomplete rather than treating the filtered
page as exhausted history. Explicit Retry can settle it once existing shared
readers have admitted the missing reference; Inbox adds no reference-resolution loop.
Thread discovery separately pages viewer-authored posts/replies and explicit
follow choices, then batches up to 100 candidate roots per channel for targeted
reply reads. Seeds stay outside unread retention until a thread has incoming
activity. The existing unread projection decides relevance and survival after
edit/delete closure; a root leaves the pending query only once incoming evidence
survives that fold. Self-only or deleted pages continue with the composite
`until`/`before_id` cursor. Explicit unfollows are excluded, and changing follow
choices invalidates an already-demanded feed. Completed exact IDs clear their
incomplete flags before other discovery batches finish, so later failures leave
usable rows visible. Discovery caps one attempt at 256 raw requests, 4 MiB,
2,000 authored seeds and 2,000 admitted events; hitting a cap shows an error,
not complete history. Retrying starts a fresh bounded attempt and does not
extend those limits.

Auxiliary reads cap retained results at 2,000 events / 4 MiB per stage; the shared reader
keeps its existing per-request deadline and cancellation. Missing roots,
participation or older activity can omit rows; an empty Inbox does not prove
complete history. No polling, independent row source or channel window is
opened for the feed. Access/cache/disconnect/disposal fence pending reads; local
read intent remains with unread. Packaged/native acceptance and human visual
feedback remain separate.

Reminders and their NIP-ER lifecycle are **not included** in this change.
The unfinished reminder prototype is preserved separately for later work,
not shipped in the Inbox source or broker routes. Follow/mute Inbox policy,
full backlog discovery and nonchat activity are outside this slice. Project and
approval queries, grouping, routing and detail presentation are deliberately
excluded rather than presented as partial parity. Native/ACP packaged acceptance and human visual feedback
remain open. Do not treat this as the full OG Inbox port.

## Split assertion ledger

The #422 source's 2,073-line mounted file has 38 literal `it` blocks plus
four parameterized groups (2 + 2 + 3 + 2 = 9 executions), totaling
**47 executed cases**. Fourteen literal Drafts cases moved intact to PR5's
`DraftsView.test.tsx`; PR4 owns the remaining 24 literal cases and all four
parameterized core groups. The original 47 = 24 core literals +
14 Drafts literals + 9 grouped core executions. PR4's 41 expanded test runs
at its published head comprise those 33 original core cases plus eight new
regressions. PR5 adds two Drafts deletion tests. PR3 retains the existing
unread suite and feed integration cases with historical edit/first-admission
safety regressions. `view-state.test.ts` adds five scoped enumeration and
meaningful-cap tests; `attachment-draft.test.tsx` adds pending/ready cleanup
regressions.
The mixed filter case keeps its two selector assertions in PR4; its Drafts
header-button assertion belongs to PR5's mounted Drafts suite. Source
project/todo/sidebar navigation tests already on main are not copied here.

Browser mapping: original case 1's chat/filter/context/read/reflow assertions
remain in PR4; its Drafts switch/return fragment lives in PR5's Drafts view test.
Original case 2 is PR5's real rich-editor/scroll/geometry/send journey. Original
strict-window case keeps exact unread anchor/new arrival/canonical origin/deletion
in PR4 and moves saved-root newest-context to PR5. Original old-DM, session
recipient and narrow failed-save cases stay in PR4. That is the original seven
browser cases split across PR4/PR5, plus PR4's new in-head focus and Escape
focus cases and development-React StrictMode case. The joined stack runs eight
cases in PR4 and two in PR5, each in Chromium and WebKit (20 executions total).
The fixture uses per-test isolated synthetic identities/servers, preserving the
base `channelWriteKinds`, `dmMembers`, companion and stale-stream guards.

The counts above are historical PR-head counts. A later test prune removed two
mounted cases whose assertions stronger cases already make: `InboxPage.test.tsx`
"Retry repeats a rejected mark-unread mutation, not just evidence refresh"
(kept by the failed mark-unread Retry cases) and `DraftsView.test.tsx` "a
selected draft edits through the shared scoped composer without navigating or
sending" (kept by the same-window editor, 128 KiB rich-editor and emptied-editor
cases). `InboxPage.test.tsx` now collects 61 cases and `DraftsView.test.tsx` 29.

## Verification status

`inbox-feed.test.ts` exercises the real session reader/visibility/unread owners
with signed ephemeral events, including the first-admission subscriber ordering,
held edit and tombstone reads, failure/retry, reentrant access removal and cache
reset, root regrouping, and an edited addressed target older than 500 ordinary
messages. `unread.test.ts` retains the current main read/catch-up behavior and
adds Inbox projection/read-state cases. Neither file establishes browser paint,
real relay persistence or packaged/native acceptance. PR4's mounted real-session
`InboxPage.test.tsx` covers filters, read/retry and pending row/detail evidence.
`tests/browser/inbox.spec.mjs` uses the actual broker/browser in Chromium and
WebKit for exact focus, viewport/scroll, responsive failure recovery, canonical
origin and session-recipient publication. This is synthetic fixture evidence,
not human live or packaged acceptance. `DraftsView.test.tsx`,
`view-state.test.ts`, `attachment-draft.test.tsx` and
`tests/browser/inbox-drafts.spec.mjs` cover Drafts storage, exact-root admission,
scoped editing/deletion (including failed text and pending uploads), selected-only
history, native editing, scroll and responsive geometry in both engines.

### Review repairs, 2026-10-01

The uncommitted repair tree based on `9d3d43cf` passed 561 focused tests across
14 files, TypeScript, changed-file Biome, design checks and all 22 Inbox browser
executions in Chromium/WebKit. The browser total is now 11 cases per engine:
the prior ten plus one real two-page draft-storage journey. No cases were removed.
Existing native-focus cases now also cover selected-row re-click, empty-filter
focus fallback, and media Escape staying inside its portal before detail dismissal.
State/failure permutations remain in mounted React or the relay owners' tests.

The relay regressions failed before repair for both lifecycle paths, omitted
retained edits and withheld auxiliary pages. Separate advancing count/byte-limit
cases fail when their corresponding guard is removed. Mounted Drafts regressions
failed before repair for channel/thread post-send cleanup, external replacement
and a valid rich document crossing 128 KiB. The DM cutoff and cold Settings
fallback tests also fail when their repairs are reverted. An independent review
of the first dismissal fix caught a portal propagation defect; both browser engines
reproduced it before the DOM-containment guard and passed afterward.

Independent changed-path re-review found no remaining blockers in the repairs.
These are local fixture/service results, not checks on pushed PR heads or a future
merged tree. Human, live-relay and attended native/packaged acceptance remain open;
no full scan or shipping-readiness attestation is implied.


## Visual-only pass (#770)

Built on main's existing Inbox and Drafts: one filter menu, outline/filled unread
toggle, trailing unread dots, adjacent list/detail with one header, and the shared
centered draft-delete dialog. The list/detail divider reuses `usePanelSplit` and
`ResizeHandle`: drag, arrows (Shift for larger steps), Home/End and double-click
reset. The list defaults to 420px where space allows and can resize from 320px
up to a 50/50 split with the conversation, which keeps at least 316px.
Its chosen width is in memory across detail close/reopen and Inbox/Drafts switching,
not persisted across restarts. At ≤700px available width, detail replaces the list
and the divider is hidden.

All matching **already-loaded** Inbox rows render without Show more. Optional
profile enrichment remains bounded to the first 50 candidates; cached names still
apply, and uncached later names may keep key fallbacks. No new history demand,
profile loop, row cache, relay/session/unread/store or native changes.

Main retains loading, representative People/Agents filters, grouped Mentions,
selected-read visibility, read/retry, workflow attribution, thread follows, exact
readers and draft persistence. Deletion retains consent and text-before-attachment
cleanup. The former history/candidate/exact-mention work is excluded.

**Separate engineering handoff:** diagnose missing older/agent conversations by
tracing fetched events, participation evidence and filtering. Agree mixed/unknown
sender behavior, mention policy and filter persistence separately. Coordinate
John's archive/refresh/development work; progressive relay loading is not fixed here.

**Evidence:** integration with main `ce2f66ea` preserves John's #757 archive
retirement and #758 refresh status without shifting rows, plus main's #800 test
pruning. It passes 116 Inbox tests, 2 shared-hook tests, TypeScript/build and 74
Chromium/WebKit executions across Inbox, sidebar and existing panel journeys.
Independent merge-resolution review found no blockers. The prior `5b4d45d0` head
passed hosted CI and DCO; current-head hosted checks remain a separate gate.
Common splitter checks stay in Inbox; Drafts keeps cross-view width, header
alignment, narrow sizing, editing and modal/focus coverage. No browser cases were
removed. Human confirmation and required review remain open; local synthetic
checks do not attest native/live acceptance.
