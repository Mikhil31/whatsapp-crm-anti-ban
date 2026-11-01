# F13 · Campaign workflow revamp

**Source of truth:** the reviewed design page "Anti-ban UI review" (claude.ai artifact 15Hiwte9Qbx9HbKNLAYV5r, version 22,
2026-11-01). Every story below is one numbered item from that page, with the **same number**. Build what the page says, nothing
more. If something here and the page disagree, the page wins: ask, don't guess.

**Workflow** (the page's four steps, in this order): 1 Find the people (Contacts) → 2 Send (campaign page while sending) → 3 Fix who
didn't get it (not sent) → 4 See who's interested (campaign + inbox). Sections 5–9 support those four.

**Status legend:** ⬜ not started · 🟨 in progress · ✅ done · 🔒 waits on a decision or a root-cause write-up.

## How to change this feature without breaking it

1. Change the story here first (its Today / After / AC / tests), then the code.
2. Look up the concept in the **impact map** below and update **every** file in its row, including the tests and docs.
3. If you add a reason code, a label, a gate or a fill-in, add a row to the matching table (R-table, L-table, G-table, V-table).
4. Run the tests named in the story. A story is ✅ only when all its ACs have a passing test.

## Impact map (one concept → every place that must change with it)

| Concept | Single source | Every consumer to update | Tests | Docs |
|---|---|---|---|---|
| **Reason codes** (why a person isn't reached) | `apps/web/lib/reasons.ts` (sentence, button, **group**) | `components/reason-action.tsx`, `app/broadcast/[id]/*` (not-sent groups, rows), `app/inbox/[id]/*` (timeline), `lib/visibility.ts`; engine writers: `apps/gateway/src/lane.ts`, `packages/core/src/policy-gates.ts`, `packages/core/src/antiban/holds.ts` | `apps/web/lib/reasons.test.ts` | this file R-table, `08-antiban.md` |
| **Wait / time display** (2.5) | `apps/web/lib/visibility.ts` `formatWait` | every countdown: campaign page, number card, inbox timeline | `apps/web/lib/visibility.test.ts` | this file 2.5 |
| **Recipient status words** (Waiting / Sending / Sent / Delivered / Read / Not yet) | `apps/web/lib/recipient-status.ts` (new, CW-2.2) | campaign list rows, count line, Show menu, live panel | `apps/web/lib/recipient-status.test.ts` | this file 2.2–2.4 |
| **Policy gates** (14 days, other campaign, agent mid-chat, opted out) | `packages/core/src/policy-gates.ts` | `packages/core/src/campaigns.ts` (dispatch), `apps/api/src/routes/campaigns.ts` (preview), `apps/web/app/broadcast/gates.ts`, start flow on the campaign page | `tests/integration/policy-gates-per-sender.test.ts` | this file G-table, `F5-campaigns.md` |
| **Fill-ins** `{{field}}` | `packages/core/src/body-variation.ts` (`VARIABLE`, `fillVariables`) | `packages/core/src/antiban/campaign-text.ts`, `apps/api/src/routes/campaigns.ts` (fill-in report), `apps/web/app/broadcast/new/*` (Insert menu, warnings), inbox composer (7.9), AI opening (7.9) | `packages/core/src/body-variation.test.ts`, `tests/integration/fill-ins.test.ts` | this file V-table |
| **Reply labels** (Interested …) | `packages/core/src/reply-labels.ts` (new, CW-4.1) | opt-out classifier `packages/core/src/antiban/opt-out.ts`, campaign funnel, inbox filters, contact campaign list | `packages/core/src/reply-labels.test.ts` | this file L-table |
| **Retry policy** (3.5) | `packages/core/src/antiban/constants.ts` (new `RETRY_*` constants) | `apps/gateway/src/lane.ts` `failSend`, reasons R-table rows "Send failed", "WhatsApp refused" | `tests/integration/auto-retry.test.ts` | this file 3.5, `08-antiban.md` |
| **Colours / type** (9.1–9.3) | `apps/web/app/globals.css` `@theme` tokens | every `.btn-primary`, badge, notice; status dots | Playwright contrast check `tests/e2e/contrast.spec.ts` | this file 9.x |
| **Campaign live data** | `GET /api/v1/campaigns/:id/recipients` + `/eta` | `app/broadcast/[id]/*`, `lib/crm.ts` types | `tests/integration/campaign-recipients-live.test.ts` | `15-api.md` |

## Stories

Each story: **As a** … **Today** → **After** (from the page), **AC** (each one testable), **Tests** (write these first), **Files**,
**Wave** (build order). "Client" = the business using the CRM. "Person" = someone they message.

---

### Section 1 · Contacts: find and group people

**Job:** open the people from one file (or part of it) and do one thing to them: tag them or message them.

#### CW-1.1 Each imported file is a list you can open · Wave 3 · ⬜
As a client, I open the people from one file without tagging them.
- **AC1** A left rail lists "All contacts", then every import file with its row count ("Drivers Pune.csv · 500"), then tags.
- **AC2** Clicking a file shows only that file's people (the people its `import_run` created or matched).
- **AC3** Tags still show under the files and still filter.
- **Tests:** integration `contacts-by-import.test.ts` (list filtered by `importRunId`; count matches); e2e: click a file → rows = file rows.
- **Files:** `apps/api/src/routes/contacts.ts` (filter `importRunId`), `apps/web/app/contacts/page.tsx`, `lib/crm.ts`.

#### CW-1.2 You see everyone, not just the first 50 · Wave 3 · ⬜
- **AC1** The list shows "486 people match" (the true total) and pages of 50.
- **AC2** After ticking a whole page, "Select all 486" appears; using it selects every match, not only the page.
- **AC3** Actions on "all 486" (tag, message) apply to all 486.
- **Tests:** integration (total count + cursor paging over 120 rows); e2e select-all → tag → 486 tagged.
- **Files:** `contacts.ts` route (total + paging), `contacts/page.tsx`.

#### CW-1.3 Search finds names and numbers only · Wave 3 · ⬜
- **AC1** The search box matches name, phone and email only. "yes" no longer matches a custom column value.
- **AC2** A "Filters" button adds column filters ("City is Pune"), shown as removable chips, plus "Clear all".
- **Tests:** integration: contact with `custom_fields.eligible="Yes"` is NOT found by q=yes; filter city=Pune works.
- **Files:** `contacts.ts` route, `contacts/page.tsx`.

#### CW-1.4 Columns you don't use stay out of the way · Wave 3 · ⬜
- **AC1** At import each column is "Show" or "Keep only". Default "Keep only", except name, phone, email, city.
- **AC2** A "Columns" control changes it later.
- **AC3** Kept-only data stays in the database and shows only in the person's full details (side panel, 1.7).
- **Tests:** integration: import with a kept-only column → value stored, not in list payload's shown columns.
- **Files:** `packages/core/src/ingestion.ts`, `custom_field` (new `shown` flag + migration), `import/import-panel.tsx`, `contacts/fields-panel.tsx`.

#### CW-1.5 One way to tag · Wave 3 · ⬜
- **AC1** Ticking people shows a bar with "Add tag".
- **AC2** "Add tag" opens a menu with a search box; typing a name that doesn't exist offers "Create tag <name>".
- **AC3** The four old ways ("Tag many at once", "New tag", per-row "+ tag", "Tag ticked") are gone.
- **Tests:** e2e: tick 3 → Add tag → type "Shortlisted" → Create → 3 tagged.
- **Files:** `contacts/page.tsx`, `contacts/tag-manager.tsx`, `contacts/actions.ts`.

#### CW-1.6 "Message them" opens the normal campaign page · Wave 3 · ⬜
- **AC1** The selection bar has "Message them"; it opens `/broadcast/new` with those people (or that file) already chosen.
- **AC2** The second campaign form on the contacts page is removed.
- **Tests:** e2e: tick 2 → Message them → new-campaign page shows "2 people".
- **Files:** `contacts/page.tsx`, `broadcast/new/page.tsx`, `broadcast/new/audience-picker.tsx`.

#### CW-1.7 A plain table, details on the side · Wave 3 · ⬜
- **AC1** The list is a table: name, phone, shown columns, tags, added.
- **AC2** Clicking a name opens a side panel with everything, including kept-only columns; the list keeps its scroll position.
- **Tests:** e2e: scroll, open panel, close → same scroll position.
- **Files:** `contacts/page.tsx`, `contacts/lazy-details.tsx`.

#### CW-1.8 Find out why filtering, grouping and adding tags break · Wave 3 · 🔒 root cause first
- **AC1** Import the client's 30-row and 500-row files, try filters, grouping and new tag / add tag, and record each failure.
- **AC2** For each failure, a root-cause write-up (per the bug rules: evidence, confidence labels, blast radius) is shown and approved **before** any fix.
- **AC3** No code fix in this story.
- **Checks (not confirmed):** the 50 limit (1.2), search reading every column (1.3), "Tag ticked" inside the campaign form whose required fields may block it.

#### CW-1.9 Click a person: see every campaign they've been in · Wave 2 · ⬜
- **AC1** The person's side panel (Contacts and inbox) has a "Campaigns" list, newest first.
- **AC2** Each line: campaign name, which of our numbers sent it, date, status ("Read", "Replied", "Probably blocked you"), label ("Interested"), the AI one-line summary. Label and summary appear once 4.1 / 2.9 exist; until then they're absent, not blank boxes.
- **AC3** Clicking a line opens that chat.
- **AC4** Above the list: "In 3 campaigns · live now in '<name>' from …<last 3 digits>" (the "live now" part only when one is running or paused).
- **Tests:** integration `contact-campaign-history.test.ts` (two campaigns from two numbers → two lines, right sender, newest first).
- **Files:** new `GET /contacts/:id/campaigns` in `contacts.ts`, `contacts/lazy-details.tsx`, inbox side panel.

---

### Section 2 · Campaign page while it sends

**Job:** see that it is working, who it is on, and when it will be done.

#### CW-2.1 A live panel shows it's working · Wave 1 · ⬜
- **AC1** While running: a countdown ring to the next send, a pulsing "Sending" pill, "Next message to <name>", the finish as a clock time ("around 14:52 · 38 min left"), and a two-colour bar.
- **AC2** Under it, one count line: Sent · Delivered · Read · Not yet. Clicking a count filters the list to those people.
- **AC3** Paused: the panel says "Paused" and nothing moves. Finished: "Done" and nothing moves.
- **AC4** Motion (ring, pill, dots) is off when the viewer has reduced motion set.
- **Tests:** unit for the count line maths (`recipient-status.test.ts`); e2e: running campaign shows ring + pill; paused shows "Paused" and no animation class.
- **Files:** `app/broadcast/[id]/page.tsx`, new `app/broadcast/[id]/live-panel.tsx`.

#### CW-2.2 Everyone in the list from the moment you press Start · Wave 1 · ⬜
- **AC1** Every recipient is listed in send order as soon as the campaign starts.
- **AC2** Each row moves on its own: "Waiting · around 14:39" → highlighted "Sending in 12 s" with typing dots → Sent → Delivered → Read, each with its time.
- **AC3** A held row says why, in words ("Quiet hours · goes 08:00").
- **AC4** The "Gap" column is gone.
- **Tests:** unit `recipient-status.test.ts` (status + reason → row words); integration: recipients API returns send order.
- **Files:** `app/broadcast/[id]/*`, new `apps/web/lib/recipient-status.ts`, `apps/api/src/routes/campaigns.ts` (order).

#### CW-2.3 "Sent" means sent · Wave 1 · ⬜
- **AC1** The headline is "212 of 500 reached · 17 not yet". Failed is never counted as reached.
- **AC2** The bar shows reached and not-yet in two colours.
- **Tests:** unit: 5 sent + 2 failed of 10 → "5 of 10 reached".

#### CW-2.4 One filter bar, in plain words · Wave 1 · ⬜
- **AC1** One search box plus one "Show" menu: Everyone, Waiting, Reached, Not yet.
- **AC2** Reasons are words with counts ("WhatsApp refused 4"), never codes like `refused_463`.
- **AC3** `queued` and `pending` both show as "Waiting".
- **Tests:** unit (`queued`, `pending` → Waiting); e2e: no text matching `/_\d{3}|[a-z]+_[a-z]+/` in the filter bar.

#### CW-2.5 Countdowns only for short waits · Wave 1 · ⬜
- **AC1** Under a minute: seconds ("12 s"), ticking.
- **AC2** 1 to 10 minutes: "in about 4 min".
- **AC3** Longer: a clock time ("at 09:00", "at 09:00 tomorrow"), not ticking.
- **AC4** The same function is used on every screen that shows a wait.
- **Tests:** unit `visibility.test.ts`: 59 s, 61 s, 9 min 59 s, 10 min 1 s, next-day.
- **Files:** `apps/web/lib/visibility.ts` (`formatWait`), all callers.

#### CW-2.6 The paused banner has a button · Wave 1 · ⬜
- **AC1** The paused banner has "Open the number" (link to the number) or, when the number is unlinked, "Link it again".
- **Tests:** e2e: unlinked sender → banner button "Link it again" goes to the link page.

#### CW-2.7 Each row shows the latest message, one line · Wave 1 · ⬜
- **AC1** Under the name, the last message in the chat in grey, one line, cut with an ellipsis: "You: …" for ours, "<first name>: …" for theirs.
- **AC2** It changes when a reply arrives (next refresh).
- **AC3** No AI is used.
- **AC4** Media shows as "Photo", "Voice note", "Document".
- **Tests:** integration: recipients API returns `lastMessage {from, text}` for the row's conversation, decrypted, max 140 chars.
- **Files:** `campaigns.ts` route (`/recipients`), `lib/crm.ts`, `app/broadcast/[id]/*`.

#### CW-2.8 Click a row to read the chat beside the list · Wave 2 · ⬜
- **AC1** Clicking a row opens a side panel with the whole chat and a reply box.
- **AC2** The list keeps its place and keeps updating behind it.
- **AC3** Esc closes it; focus returns to the row.
- **Tests:** e2e: open, reply, Esc → row focused, list scroll unchanged.
- **Files:** `app/broadcast/[id]/*`, reuse inbox thread components.

#### CW-2.9 A one-line AI summary, only once they reply · Wave 2 · ⬜
- **AC1** When a person replies, one line is written from the whole chat ("Wants the price and a test drive this week").
- **AC2** Written once per reply (not per refresh), in the **same model call** as the 4.1 label.
- **AC3** Rows with no reply show only 2.7.
- **Tests:** integration with a fake LLM: one reply → exactly one LLM call → label + summary stored; refresh → no new call.
- **Files:** `packages/core/src/reply-labels.ts`, gateway inbound hook, `ai_run` (tokens recorded).

---

### Section 3 · Campaign page: the people who didn't get it

**Job:** get the message to everyone. For each person it didn't reach, know why and fix it, many at once.
**When it shows:** on the campaign page as soon as one person isn't sent, while it runs, and it stays after the end.

#### CW-3.1 "Not sent" is split by why, with one fix per group · Wave 2 · ⬜
- **AC1** Three groups: **Will go on its own** (each line says when), **Needs you** (one button per reason), **Can't reach on WhatsApp** (another way to reach them).
- **AC2** Every reason in the **R-table** lands in exactly the group the table says. A code not in the table lands in Needs you as "Couldn't send yet" (3.7).
- **AC3** Clicking a line filters the list to those people.
- **AC4** The finished summary reads "470 reached. 30 not yet: 21 will go on their own by 09:00, 5 need you, 4 can't be reached on WhatsApp."
- **Tests:** unit `reasons.test.ts`: every R-table code → its group; unknown code → Needs you.
- **Files:** `lib/reasons.ts` (add `group`), `app/broadcast/[id]/not-sent.tsx` (new).

#### CW-3.2 Fixes that work on a whole group · Wave 2 · ⬜
- **AC1** Group buttons, each acting on every person in the line: Try again for all, Send now, Send from another number, Send when the chat ends, Upload the picture again, Send to these in a new campaign, Download list to call.
- **AC2** Each is one API call for the group, audited once.
- **Tests:** integration per action (e.g. "Send from another number" moves 4 queued messages to sender B, audit row written).
- **Files:** new `POST /campaigns/:id/recipients/bulk` in `campaigns.ts`, `packages/core/src/campaign-actions.ts`.

#### CW-3.3 Warnings, not pauses · Wave 2 · ⬜
- **AC1** When many messages stop arriving, sending carries on and a red banner says what's happening with the numbers ("38 of the last 50 didn't arrive. WhatsApp may be limiting you.") and one **Stop** button.
- **AC2** There is nothing to "Resume".
- **Tests:** integration: stuck-hold condition no longer holds campaigns; banner data returned.
- **Files:** `packages/core/src/antiban/delivery-check.ts`, `holds.ts`, `lane-state.ts`, number card, campaign banner. See G-table.

#### CW-3.4 No pointless buttons · Wave 2 · ⬜
- **AC1** A person who probably blocked the number gets no send button; the line reads "Try another way to reach them, like a call" and they are in the call list.
- **Tests:** unit: `likely_blocked` → no action, group = Can't reach.

#### CW-3.5 The app retries by itself · Wave 2 · ⬜
- **AC1** A failed send retries automatically after 2 min, then 15 min, then 1 h (3 tries).
- **AC2** A WhatsApp refusal (463) retries once, after 6 h.
- **AC3** While retrying the person is in "Will go on its own" with "Trying again at 14:35 (2 of 3)".
- **AC4** After the last try they move to "Needs you" with "Send from another number"; "Try again now" stays as a small secondary link.
- **Tests:** integration `auto-retry.test.ts` with a fake clock: fail → 3 retries at the right times → then Needs you; 463 → one retry at 6 h.
- **Files:** `apps/gateway/src/lane.ts` (`failSend`), `antiban/constants.ts`, `reasons.ts`.

#### CW-3.6 The picture-after-reply option says who misses out · Wave 2 · ⬜
- **AC1** The form says "People who don't reply won't get the picture."
- **AC2** The campaign page shows how many are still waiting for their picture.
- **Files:** `broadcast/new/page.tsx`, `campaigns.ts` route (count), `app/broadcast/[id]/*`.

#### CW-3.7 "Needs you" always names the problem · Wave 2 · ⬜
- **AC1** Every Needs-you line uses its R-table sentence, adds WhatsApp's own error text where there is one, and has the one fix button.
- **AC2** An unknown code shows "Couldn't send yet", the raw code under a "Details" link, and "Try again now". Never blank.
- **Tests:** unit `reasons.test.ts` (unknown code, empty code, send_error with detail).

#### CW-3.8 More reasons for "can't reach" · Wave 2 · ⬜
- **AC1** New reasons: landline, bad number, same number twice, with the R-table sentences and buttons.
- **AC2** Landline and bad number come from the import's own check; same number twice says who got it ("It was sent once, to Priya").
- **Tests:** integration: a landline contact in an audience → recipient skipped `landline`.
- **Files:** `packages/core/src/campaigns.ts` / audience snapshot, `reasons.ts`.

#### CW-3.9 The finish time says why it takes this long · Wave 1 · ⬜
- **AC1** "Done by about 15:40. We send one message every 1 to 50 seconds, like a person would, so WhatsApp doesn't flag your number."
- **AC2** If the finish moved: "40 min later than planned: replies go first, and WhatsApp's new-chat limit resets at 09:00." Built from the ETA's existing `delayedBy` list; no engine change.
- **Tests:** unit: `delayedBy` [reply_priority 600 s, new_chat_cap 1800 s] → the sentence above with "40 min".
- **Files:** `lib/visibility.ts` (`etaLines`), `app/broadcast/[id]/*`.

---

### Section 4 · Campaign page + Inbox: who is interested

**Job:** out of 500 messaged, find the 40 worth following up, and follow them up.

#### CW-4.1 The AI labels every reply · Wave 2 · ⬜
- **AC1** The single model call that today asks "is this negative?" now returns one label from the campaign's label set (4.2) plus one line on what they want.
- **AC2** Opted out keeps working exactly as now; a label never overrides an opt-out.
- **Tests:** unit with fake LLM; integration: "stop spamming me" → opted out (unchanged).
- **Files:** `packages/core/src/antiban/opt-out.ts`, new `reply-labels.ts`, `message`/`conversation` label columns + migration.

#### CW-4.2 The campaign says what reply it expects · Wave 2 · ⬜
- **AC1** The new-campaign form asks "What reply do you expect?" with four answers, each with its label set (L-table).
- **AC2** Every kind also gets Opted out, Wrong person, Unclear.
- **AC3** Optional line "What counts as interested?" is passed to the model.
- **AC4** "Action elsewhere" results are worded "said they'll renew", never "renewed".

#### CW-4.3 The campaign page shows the result · Wave 2 · ⬜
- **AC1** Messaged → Delivered → Replied → one count per label → No reply. "No reply needed" campaigns show only Delivered and Read plus replies that need a person.
- **AC2** Interested people listed first with the AI's note. Every number opens the inbox filtered to those people.

#### CW-4.4 The inbox filters by campaign and by label · Wave 2 · ⬜
- **AC1** "Campaign" and "Label" menus at the top of the inbox.
- **AC2** Each chat shows its label and the AI's note.
- **AC3** Select many → assign, tag, export, message again.

#### CW-4.5 You can correct the AI in one click · Wave 2 · ⬜
- **AC1** The label in a chat is a menu; changing it updates the campaign counts.
- **AC2** Each correction is stored (who, from, to, when) so a hit rate can be shown.

#### CW-4.6 Keep the interested people as a tag · Wave 2 · ⬜
- **AC1** "Tag the 40 interested" creates tag "<campaign> · Interested" on those 40.
- **AC2** The tag appears on Contacts and can be a campaign audience.

#### CW-4.7 Two lists on the campaign page: the leads, and everyone · Wave 2 · ⬜
- **AC1** Two tabs under the funnel: "Leads" (interested only) and "Everyone" (all, with status, label, AI line, last message).
- **AC2** Any row opens the chat side panel (2.8) with reply, change label, tag.

#### CW-4.8 Every campaign stays one click away · Wave 2 · ⬜
- **AC1** Each campaign row in the list shows "470 of 500 reached · 5 need you · 40 interested".
- **AC2** Campaigns that need you sort to the top.
- **AC3** A "2 campaigns sending" pill in the top bar opens them from any screen.

#### CW-4.9 Edge cases have a place · Wave 2 · ⬜
- **AC1** Every row of the **E-table** behaves as written.
- **AC2** A label the screen doesn't know shows as "Unclear", never an error or an empty box.
- **Tests:** one unit test per E-table row (fake LLM where needed).

---

### Section 5 · Inbox thread

#### CW-5.1 Delivered messages look like WhatsApp · Wave 2 · ⬜
- **AC1** Delivered and read messages show only their status; the "✓ queued → ✓ sent → ✓ delivered" line shows only for waiting, held or failed messages.

#### CW-5.2 One plain line for a message on its way · Wave 2 · ⬜
- **AC1** One changing line: Queued → Sending in 12 s → Sending… → ticks. "Typing" and "gap between sends" never shown.

#### CW-5.3 "Couldn't open it" has a next step · Wave 2 · ⬜
- **AC1** Text: "Their phone hasn't been able to open your last message yet. We'll resend it when it can. If it's urgent, call them."

#### CW-5.4 The chat shows which campaigns it came from · Wave 2 · ⬜
- **AC1** A divider before each campaign's first message: "Campaign · <name> · <date>".
- **AC2** The side panel shows the 1.9 campaign list.

---

### Section 6 · Numbers: is each number healthy

#### CW-6.1 One line answers "is it OK" · Wave 2 · ⬜
- **AC1** First line on the number card is one of: "Sending normally", "Paused: WhatsApp's limit until 09:00", "At risk: WhatsApp's second warning". Details below, smaller.

#### CW-6.2 No engine words · Wave 2 · ⬜
- **AC1** "WhatsApp won't let this number start new chats until 14:20. Replies still go." replaces "Holding new chats: timelock until 14:20".

#### CW-6.3 Each warning says what to do · Wave 2 · ⬜
- **AC1** Adds "WhatsApp thinks this number starts too many new chats. Slow down new campaigns until 09:00."

#### CW-6.4 "Updated" only when it's old · Wave 2 · ⬜
- **AC1** Shown only after 30 s with no new data: "Last updated 2 min ago. Reconnecting…"

#### CW-6.5 Check the auto-refresh doesn't break linking · Wave 2 · 🔒 needs a real phone
- **AC1** Linked with a real phone (+919964122631 only) while the page refreshes. If the QR flickers or resets, only the live parts refresh.

#### CW-6.6 We warn, we don't block · Wave 1 (per-number rule) / Wave 2 (the rest) · ⬜
Every row of the **G-table** behaves as written. Opted out stays the one hard stop.
- **CW-6.6a · Per sending number (Wave 1).** The 14-day and other-campaign checks look only at the **same sending number**.
  - **AC1** Same number with a live campaign (running or paused, person still pending/queued in it): before launch a red confirm names the people: "12 of these people are still in '<campaign>' from <sender phone>. Sending again from the same number will cut into that conversation, and their replies may be counted for the wrong campaign." Buttons "Leave them out" (default, focused) and "Send anyway".
  - **AC2** "Leave them out" → those people are skipped with reason `in_other_campaign`. "Send anyway" → they are sent (the gate is lifted for this campaign, audited).
  - **AC3** Same number, nothing live, messaged by another campaign in the last 14 days: a plain warning line on the form ("42 of these got a campaign from you in the last 14 days, from this number."), no dialog, and they **are sent**.
  - **AC4** Different sending number: no warning and no skip. One small note only when relevant: "They'll see two chats from your business."
  - **Tests:** integration `policy-gates-per-sender.test.ts`: (a) live campaign on sender A, new campaign on A → blocked unless override; (b) same on sender B → not blocked; (c) 14-day history on A, new on A → not blocked, preview count = 1; (d) 14-day history on B, new on A → preview same-number count 0, other-number count 1.
  - **Files:** `packages/core/src/policy-gates.ts`, `packages/core/src/campaigns.ts`, `apps/api/src/routes/campaigns.ts` (`/:id/preview`), `apps/web/app/broadcast/[id]/campaign-controls.tsx` (confirm), `apps/web/app/broadcast/gates.ts`, `lib/crm.ts`.
- **CW-6.6b · Agent mid-chat (Wave 2).** Sent; the agent's chat shows "A campaign message went out here at 14:02."
- **CW-6.6c · Warnings banner (Wave 2).** WhatsApp's first/second warning and many blocks → banner "WhatsApp has warned this number. We'd stop for today." with Stop for today / Keep sending; default keeps the slower pace; can switch to full speed.
- **CW-6.6d · Many couldn't open (Wave 2).** Keeps sending with "Link it again usually fixes this" banner.

---

### Section 7 · New campaign form (and why Sending rules goes away)

#### CW-7.0 Remove the Sending rules page · Wave 2 · ⬜
- **AC1** No Sending rules page in the menu.
- **AC2** Quiet hours shown on the campaign form as a default the client can change for that campaign ("Don't send 22:00 to 08:00, India time").
- **AC3** Opt-out message and contact details live in Settings with the 7.1 live preview; the campaign form links to it in one line.

#### CW-7.1 See the opt-out message before it's sent · Wave 2 · ⬜
- **AC1** A live preview of the real closing message under the fields, updating as you type.

#### CW-7.2 Pick the time zone from a list · Wave 2 · ⬜
- **AC1** A searchable list, preset to the browser's zone.

#### CW-7.3 "Same text for everyone" tip at the right moment · Wave 2 · ⬜
- **AC1** Shown when leaving the message box (blur), not while typing, with "Add variations for me" (asks the AI).

#### CW-7.4 See how "why you're messaging" reads · Wave 2 · ⬜
- **AC1** Under the box: "If someone replies STOP, they'll read: We messaged you because <purpose>."

#### CW-7.5 "Saved" next to the button · Wave 2 · ⬜
- **AC1** "Saved" beside the button for 3 seconds instead of a lasting green box.

#### CW-7.6 Fill-ins you can see · Wave 1 · ⬜
- **AC1** An "Insert" button above the message box; typing "{" opens the same list.
- **AC2** The list shows the chosen audience's columns (name, first_name, every field), each with a sample value and coverage: "due_date · 12 Nov 2026 · 982 of 1,000 have it".
- **AC3** Picking one inserts it; in the box it shows as a chip, and the saved text stays `{{key}}`.
- **AC4** Keyboard: arrows move, Enter picks, Esc closes.
- **Tests:** integration `fill-ins.test.ts`: report for an audience of 3 with one missing `due_date` → `due_date` coverage 2 of 3, sample value from a real person; e2e: type "{" → list → Enter → `{{due_date}}` in saved body.
- **Files:** new `GET /campaigns/fill-ins?…audience` (or on preview) in `campaigns.ts`, `packages/core/src/body-variation.ts` (export key list helper), `broadcast/new/*`.

#### CW-7.7 Blank fill-ins are caught before sending · Wave 1 · ⬜
- **AC1** Under the box: "18 people have no due date." with three options: skip them / use a fallback (a text box, e.g. "soon") / send anyway.
- **AC2** Skip → those people are skipped with reason `missing_field`. Fallback → the fallback text fills the gap. Send anyway → current behaviour.
- **AC3** A `{{name}}` that isn't a column is underlined red with "No column called duedate. Did you mean due_date?" (closest key by edit distance ≤ 2).
- **AC4** Launch with an unknown key needs an explicit confirm.
- **Tests:** unit `body-variation.test.ts` (unknown keys detection, suggestion, fallback fill); integration: skip option → 1 recipient skipped `missing_field`.
- **Files:** `body-variation.ts`, `campaign-text.ts`, `campaigns.ts` (dispatch), campaign columns for the choice + fallback (migration), `broadcast/new/*`, `reasons.ts` (`missing_field` → Needs you, "Edit the message").

#### CW-7.8 Preview with real people, and dates that read like dates · Wave 2 · ⬜
- **AC1** A preview of three real recipients' finished messages with arrows to page through.
- **AC2** Date columns are detected at import and written as "12 Nov 2026" (Excel serial numbers converted).
- **AC3** Numbers can be shown as money: `{{premium}}` → "₹12,400".

#### CW-7.9 The same fill-ins everywhere you write · Wave 2 · ⬜
- **AC1** The same Insert list in the inbox reply box, saved replies and the AI assistant screen.
- **AC2** The AI gets the person's fields, so "remind them of {{due_date}}" works.

---

### Section 8 · Every screen

#### CW-8.1 Loading looks like the page that's coming · Wave 2 · ⬜
- **AC1** A skeleton of the page after 0.1 s; a spinner on the pressed button for short waits; never a big centred spinner. (`loading.tsx` per route.)

#### CW-8.2 Friendly errors · Wave 2 · ⬜
- **AC1** "We couldn't load this. Check your connection and try again." with Try again and Copy error details. No raw codes, no "npm run dev". (`error.tsx` per route.)

#### CW-8.3 Buttons say what they do · Wave 1 (reason buttons) · ⬜
- **AC1** Retry → Try again · Relink → Link the number again · Resume → Stop sending · Lift → Allow messages again · Send by hand → Open chat.

#### CW-8.4 Warmer, shorter wording · Wave 2 · ⬜
- **AC1** "We couldn't send this. Try again in a minute." · "This message is on hold. Copy the details if you need help."

#### CW-8.5 Real icons · Wave 2 · ⬜
- **AC1** One icon set (Lucide), imported one icon at a time; no typed symbols (✓ ✕ ⏸ →) as icons.

#### CW-8.6 Route audit for IDs in links · Wave 3 · ⬜
From the page's IDs answer: "That audit is the useful follow-up, not hiding IDs."
- **AC1** Every API route and file download that takes an id is checked for a login and an organisation check; a list of any that lack one is written up.

---

### Section 9 · Look and feel

🔒 **Direction not chosen yet.** The page offers A (feels like WhatsApp), B (quiet workspace), C (mission control), with the
suggested mix C + B + A. Build 9.1–9.7 (they hold for every direction); restyle screens only after the client picks.

#### CW-9.1 A darker green · Wave 1 · ⬜
- **AC1** Buttons and links use #15803d (5.0:1 with white). Bright green only for dots, bars, the ring.
- **Tests:** e2e contrast check on `.btn-primary` ≥ 4.5:1.

#### CW-9.2 Colour only means status · Wave 2 · ⬜
- **AC1** Green = go/working, amber = needs you, red = can't reach, blue = read. The stat-tile gradient is removed.

#### CW-9.3 Slightly bigger text, numbers that line up · Wave 2 · ⬜
- **AC1** 15 px body, 13 px smallest; secondary grey ≥ 4.5:1 on the canvas; counts and times use tabular figures.

#### CW-9.4 Wide pages for tables, narrow for forms · Wave 2 · ⬜
- **AC1** Contacts, campaign, inbox use full width with a sticky header row; forms max 42rem; the main button stays visible top-right.

#### CW-9.5 Five standard animations · Wave 2 · ⬜
- **AC1** Only: side panel slide 200 ms; row status fade 600 ms; skeleton shimmer; "Jump to current" smooth scroll (never auto-scroll); page fade on first visit only. All off with reduced motion.

#### CW-9.6 Light on memory with 500 rows · Wave 2 · ⬜
- **AC1** The campaign page fetches only rows changed since the last check instead of `router.refresh` of the whole page.
- **AC2** Off-screen rows use `content-visibility: auto`. No list library, no chart library.

#### CW-9.7 One look for every state · Wave 2 · ⬜
- **AC1** Three shared pieces (skeleton, empty state with one sentence + one button, error with Try again) used by every screen.

---

### From the page's answers

#### CW-A1 Credit a reply to the right campaign · Wave 2 · ⬜
From the collision answer: "credit a swiped reply to the message it quotes, and otherwise let the AI labelling in section 4 pick the campaign."
- **AC1** A reply that quotes one of our messages is credited to that message's campaign.
- **AC2** Otherwise the 4.1 labelling call picks the campaign; until 4.1 exists, the latest campaign (today's behaviour).
- **Tests:** integration: two campaigns on one number; reply quoting the first → credited to the first.
- **Files:** `packages/core/src/campaign-reply.ts`, gateway inbound (quoted message id).

## Tables (the page's tables, verbatim intent)

### R-table · every reason (CW-3.1, 3.7, 3.8)
| Reason | Group | What the client reads | Button |
|---|---|---|---|
| Quiet hours | Will go on its own | "Waiting for quiet hours to end at 08:00." | Send now |
| New-chat limit | Will go on its own | "WhatsApp lets this number start only so many new chats. These go after 09:00." | Send from another number |
| Timelock | Will go on its own | "WhatsApp has paused new chats from this number until 14:20." | Send from another number |
| Phone couldn't read it | Will go on its own | "Their phone couldn't open our message yet. We'll resend when it can." | none |
| Send failed, retrying | Will go on its own | "Couldn't send. Trying again at 14:35 (2 of 3)." | none |
| Unlinked | Needs you | "Your number was unlinked from the phone. Nothing sends until you link it again." | Link it again |
| Not connected | Needs you | "Your number is offline. Check the phone has internet." | Open the number |
| Many not delivered | banner | "38 of the last 50 didn't arrive. WhatsApp may be limiting you." | Stop |
| Many couldn't read | banner | "Several people couldn't open our messages. Linking again usually fixes it." | Link it again |
| Send failed after 3 tries | Needs you | "Couldn't send after 3 tries: <WhatsApp's own words>." | Send from another number · Try again now |
| WhatsApp refused | Needs you (after its one retry) | "WhatsApp refused this message. We don't know why yet; we'll try once more at 20:10." then "WhatsApp keeps refusing this person." | Send from another number |
| Unknown code | Needs you | "Couldn't send yet." + Details (raw error) | Try again now |
| Picture missing | Needs you | "The picture couldn't be loaded." | Upload the picture again |
| Empty message | Needs you | "This person's message came out empty. A field in your text may be blank for them." | Edit the message |
| Missing fill-in (7.7, "skip them") | 🔒 not on the page: confirm group and wording | — | Edit the message |
| Messaged recently (same number) | sent, warning on form | — | Remove them (optional) |
| In another campaign (same number) | 🔒 left-out people: group not on the page, confirm | — | Leave them out / Send anyway (before launch) |
| Agent mid-chat | sent, note to agent | — | none |
| Opted out | Needs you (hard stop) | "They asked you to stop on 12 Oct." | Allow again (admin, one at a time, with a reason) |
| Not on WhatsApp | Can't reach | "This number has no WhatsApp account." | Download list to call |
| No phone number | Can't reach | "No phone number saved for them." | Add numbers |
| Probably blocked you | Can't reach | "They've probably blocked your number." | Download list to call |
| Your own number | Can't reach | "This is the number doing the sending." | none |
| Landline | Can't reach | "This looks like a landline. Landlines can't use WhatsApp." | Download list to call |
| Bad number | Can't reach | "This number has too few digits" / "isn't valid for India" | Fix the number |
| Same number twice | Can't reach | "Two contacts share this number. It was sent once, to Priya." | Merge contacts |
| Campaign cancelled | 🔒 listed in 3.1 but not placed in a group on the page: confirm | today's sentence: "The campaign was cancelled before this contact was reached." | none |

### G-table · who stops what (CW-6.6)
| Case | Today | After |
|---|---|---|
| WhatsApp's first or second warning | New chats 2× / 3× slower | Banner "WhatsApp has warned this number. We'd stop for today." Stop for today / Keep sending; default keeps the slower pace; can switch to full speed |
| Many blocks or no replies | New chats 2× slower | Same banner with numbers: "6 of the last 50 people blocked you." |
| Many not delivered | Campaigns paused until Resume | Keeps sending; red banner; Stop is one click |
| Several couldn't open | Number paused | Keeps sending; "Link it again usually fixes this" banner |
| 14 days / other campaign | Skipped, across all numbers | Per sending number: same number + live → red confirm, default Leave them out; same number, nothing live → warning line; different number → nothing |
| Agent mid-chat | Skipped | Sent; note in the agent's chat |
| Quiet hours | Waits | Unchanged; "Send now" overrides |
| Timelock / new-chat limit | Waits for reset | Unchanged; say so, offer another number |
| Refused, banned, unlinked | Shown as failed | Shown in plain words with what to do |
| Opted out | Never sent; admin lift | Unchanged: the one hard stop |

### L-table · labels per campaign kind (CW-4.2)
| Kind | Labels |
|---|---|
| A yes or no | Interested · Has a question · Not interested |
| An action elsewhere | Will do it · Already done · Needs help · Won't do it |
| No reply needed | (no funnel) Has a question · Wants to talk |
| My own labels | up to five, typed by the client |
| Every kind also | Opted out · Wrong person · Unclear (+ Later, Auto-reply, Couldn't read, Not labelled yet from the E-table) |

### E-table · labelling edge cases (CW-4.9)
| Case | Example | What happens |
|---|---|---|
| No reply expected | Holiday hours | No funnel, Delivered and Read; questions still surface |
| Action elsewhere | Insurance renewal | Will do it / Already done / Needs help; "Already renewed last week" = done |
| Maybe, not now | "Next month maybe" | "Later" label with the AI's note on when; apart from Not interested |
| Very short / emoji | "ok", "👍", "hmm" | Unclear, except on a yes/no campaign where "ok"/👍 = yes; note says why |
| Mixed languages | "haan bhai details bhejo" | Read normally; note always in English |
| Voice note, photo, document | voice note | "Couldn't read: voice note"; goes to a person |
| Several messages in a row | "yes" … "wait, how much?" | Labelled about a minute after they stop; re-labelled on each reply; latest wins |
| Automatic replies | "We're closed" | "Auto-reply", not counted as Replied |
| Wrong person | "Who is this?" | "Wrong person" + offer to mark the number wrong |
| Angry / STOP in a sentence | "stop spamming me" | Opted out (existing check); labelling never overrides |
| Reply to an older campaign | about last month's offer | Swipe-reply → that campaign; otherwise latest (CW-A1) |
| AI off / no key / timeout | model down | "Not labelled yet" + Label now; counts show "12 not labelled" |
| AI wrong | sarcasm | One-click fix (4.5); page shows how often corrected |

### V-table · fill-ins (CW-7.6–7.9)
| Fill-in | Source | Missing value today | After |
|---|---|---|---|
| `{{name}}` / `{{contact.name}}` | contact display name | blank | caught by 7.7 |
| `{{first_name}}` | first word of name | blank | caught by 7.7 |
| `{{<field key>}}` | `contact.custom_fields[key]` | blank | caught by 7.7; dates/money formatted (7.8) |
| unknown key | — | blank for everyone, silently | red underline + suggestion; confirm to launch |

## Build waves

- **Wave 1 (this branch, now):** 2.1–2.7, 3.9, 8.3 (reason buttons), 9.1 → *agent A, campaign page*. 6.6a, 7.6, 7.7 → *agent B, gates and fill-ins*.
- **Wave 2:** the rest of sections 2–9 and CW-A1.
- **Wave 3:** Contacts 1.1–1.7, 1.8 after its root-cause write-up is approved, and 8.6. (1.9 is in wave 2: it needs nothing from the contacts rebuild.)

## Open questions (the page doesn't say; ask before building)

- R-table: which group "campaign cancelled", "missing fill-in" and "left out of another campaign" go in, and their wording.
- 7.7 "skip them": the skipped person's reason sentence.
- Section 9: which direction (A, B, C or the suggested mix).
