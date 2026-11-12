# MCP tool inventory (read-only research)

Repo: /home/jankomarek/Documents/02_Personal/11_Fakturan. Paths below are relative to `src/` unless noted.
`ACT:` = server action file in `app/(app)/...`. `SVC:` = `server/services/...`.

Existing MCP tools (`server/mcp/tools/index.ts:6-13`): get_overview (read), list_unpaid_invoices (read), get_invoice (read), search_customers (read), search_catalog (read), create_draft_invoice (capability `create`).

Legend for "Covered": YES = already an MCP tool; PART = partially; NO.

---------------------------------------------------------------------------
## 0. Cross-cutting findings (read first)

### 0.1 How the web calls a service (what a wrapper must mirror)
- Every action does: session check (`requireSession()` redirects, or `getCurrentSession()` returns `{expired:true}` in faktury/platby actions) -> Zod `safeParse` of the raw input -> `actorFromRequest()` (`server/auth/session.ts:50`) -> service call -> `revalidatePath` (web-only, MCP skips) -> `ServiceError` message becomes `{ok:false,error}`.
- MCP equivalent already exists: `runTool` (`server/mcp/tool.ts:84-110`): `admit()` (availability, account active, settings.enabled, capability, consent row), `def.input.parse`, `runWithActor(ctx.actor, ...)`, output check, `touchMcpConnection`. `ServiceError` -> tool error via `toolErrorResult` (`server/mcp/errors.ts`).
- Per-call rate limit for MCP: `RATE_RULES.mcpCallUserClient` 60/min (`server/rate-limit.ts:30`), checked per HTTP request in `mcpEndpoint`.
- Service signatures take `Actor` (mutations) or `ownerId` (reads). MCP gets `ctx.actor` (source "mcp", clientId, clientName) and `ctx.ownerId`.
- Mutations all go through `mutate(actor, action, fn)` (`server/services/mutation.ts:17`), sync only (throws if async or if no audit row recorded).

### 0.2 Rate limits and demo locks: where they live
All inside the SERVICES (so a pure wrapper keeps them), except two in actions:
- IN ACTION ONLY (wrapper must replicate):
  - `quickSearch` (`app/(app)/hledani-actions.ts:12-27`): trims, returns empty if `< MIN_QUERY_LENGTH` (lib/quick-search), `enforceRateLimit(actor, RATE_RULES.searchUser)`, then `searchAll(userId, term, PER_GROUP)` (SVC quick-search.ts:71). On RateLimitError returns `limited:true`.
  - `lookupAresAction` (`app/(app)/ares-actions.ts:14-30`): `enforceRateLimit(actor, RATE_RULES.aresLookup)` then `lookupAres(ico)` from `server/external/ares` (not a service file; external HTTP call).
- IN SERVICE (kept by wrapper): `sendUser` 60/min (invoice-mail.ts:362,393,468,735; reminders.ts:288), `sendBulkUser` 5/h (invoice-mail.ts:734), `viesLookup` (customers.ts:320), `fxLookupUser` (exchange-rates.ts:151), `mailSaveUser` (email-templates.ts:106,142), `bankCheckUser` + `DEMO_MODE` lock (bank-poll.ts:325-326), `mailTestUser`/`bankSaveUser` (mail-settings/bank-mailbox - excluded).
- `assertAdmin` is only in administration services (excluded). No admin check on any wrapped service.
- Demo locks: `isDemo()`/`env.DEMO_MODE` (`server/demo/mode.ts`) used only by bank-mailbox.ts, bank-poll.ts, mail-settings.ts, users.ts, auth. MCP itself is off in demo (`server/mcp/availability.ts`, MCP-009). No demo lock in invoice/customer/catalog services.
- Account limits (`services/account-limits.ts`) are enforced inside services (MCP spec MCP-032 relies on that).

### 0.3 DOMAIN LOGIC THAT LIVES IN ACTIONS, NOT SERVICES (a pure service wrapper would skip it)
1. `saveDraftAction` (`faktury/actions.ts:188-200`): `assertTagNames(names)` -> `ensureDefaultSeries(actor)` -> `saveDraft(actor, draft)` -> `setInvoiceTags(actor, saved.id, names)` -> returns `{id, revision, problems: checkIssuable(ownerOf(actor), saved.id)}`. Existing `create_draft_invoice` already replicates ensureDefaultSeries but NOT tags and NOT checkIssuable problems. An `update_draft_invoice` tool must do all five steps. Note: tags are written in a SECOND mutation (two audit rows `invoice.save` + `invoice.tags_set`), not atomic.
2. `updateIssuedAction` (:214-222): `assertTagNames` -> `updateIssuedInvoice` -> `setInvoiceTags` (same pattern).
3. `createCreditNoteAction` (:342) and `convertAdvanceAction` (:351): call `ensureDefaultSeries(actor)` BEFORE the service.
4. `customerDefaultsAction` (:238-255): composes `newDraftDefaults` + `clauseDefaultsOf` + `getCustomer().dic` + `daysBetween` into `CustomerDefaults` (form helper; the agent version is just reading `customerDefaults()` SVC customers.ts:353 / `newDraftDefaults`).
5. `bulkSendPreviewAction` (:431-440): wraps `bulkSendPreview(owner, ids)` and adds `paused: getAutomation(owner).paused` + `requestId: randomUUID()`. `bulkSendAction` (:442) needs that `requestId` and the `previewed` map (recipients per invoice) back from the preview. Two-step protocol lives in the UI+action.
6. `saveLineToCatalogAction` (:224-228): builds a `CatalogInput` from an invoice line (`description` default "", `category:""`, `tags:[]`).
7. `searchCustomersAction/searchCatalogAction` (:267-292): `PICKER_LIMIT = 8` and field projection (MCP search tools already do their own).
8. `sendSummaryAction` (`pravidelne/actions.ts:115-121`): reads customer email + `getAutomation().sendTime` (confirmation text for recurring send). Pure read composition.
9. `previewRecurringAction` (`pravidelne/actions.ts:59-71`): bypasses `run()`; calls `previewRecurring(user.id, parsed)` with `session.user.id`.
10. `resetEmailTemplateAction` (`nastaveni/posta/sablony/actions.ts:45-54`): after `resetEmailTemplate` reads back `getEmailTemplate` and returns subject/body.
11. `setAdvanceFinalModeAction` (`nastaveni/automatizace/actions.ts:83-88`): not an automation service call; it is `savePreferences(actor,{advanceFinalMode})`.
12. `completeOnboardingAction` (`nastaveni/vychozi/actions.ts:49`): `ensureDefaultSeries` + `completeOnboarding` (excluded: onboarding).
13. `setAutomationAction` / `setPausedAction`: the `confirmed:boolean` flag is a service-level check (automation.ts:174,192) - the UI sets it from a dialog; an agent wrapper must NOT default it to true (it is the human confirmation).
14. Action-level Zod wrappers around service schemas (the exact input to reuse): `draftInput = {draft: draftInputSchema, tags}`, `issueInput = {id, revision, variableSymbol?}`, `updateInput = {id, tags, document: issuedInputSchema}`, `sendInput = {id, message: sendInputSchema}`, etc. (`faktury/actions.ts:92-141`).
15. NOT domain logic but web-only: `changedInvoices()`/`revalidatePath` everywhere; reports are read through `cachedReport/cachedTax` (`server/report-cache.ts`, "use cache" + `accountStamp`) - an MCP tool should call `reportBundle`/`taxOverview` directly (as get_overview does) not the cache module.

### 0.4 Concurrency / revision wrinkles
- Optimistic concurrency uses `invoice.revision` (int). Takes `revision`: `issueInvoice` (opts.revision), `saveDraft` (draft.revision, optional - missing means create/new or by `clientId`), `updateIssuedInvoice` (issuedInputSchema.revision, nullish -> reported stale), `addPayment/addRefund/updatePayment` (paymentInputSchema.revision), `deletePayment(actor,id,revision)`, `markPaid(opts.revision)`, `closeDifference(opts.revision)`, `sendInvoice/sendReceipt/resendFromLog/bulkSend` (sendInputSchema.revision), `confirmBatch` (import; excluded), `saveMcpSettings` (own revision).
- **The existing `get_invoice` output (`server/mcp/tools/invoice.ts:15-69`) does NOT expose `revision`, nor payment ids, nor line ids, nor email-log ids, nor version ids.** Every revision-taking tool needs `revision` added to get_invoice (and to create_draft_invoice's output), plus `payments[].id` for update/delete payment. `InvoiceDetail = Invoice & {lines, tags}` (invoices.ts:92) already carries `revision`.
- Stale error = `ServiceError(TEXTS.invoices.stale)`; web maps to `{stale:true}`; MCP maps to a tool error (add a hint to re-read).
- Idempotency: `saveDraft` accepts `clientId` (uuid) for first-write replay (used by create_draft_invoice `idempotency_key`). `sendInput.requestId` (uuid) is the send idempotency key; `bulkSend` has `requestId`; `checkMailboxNow(actor, requestId)`.
- Non-serializable / awkward returns: all service returns are plain objects except `Date` fields (rows contain `Date` e.g. `sentAt`, `archivedAt`, `createdAt`) and `NotIssuableError` (extends ServiceError, carries `problems: IssueProblem[]`, `invoice-lifecycle.ts:72`) which the web turns into `{problems}`; MCP wrapper must render problems into the tool error text. `verifyVat` returns `Date` (action stringifies). Audit rows contain JSON `before/after` + ip/userAgent.
- FormData/File: only `uploadSupplierImageAction`, `uploadMailLogoAction`, import upload route, backup restore upload - all excluded.

### 0.5 Input-schema conventions
- Money: web schemas use integer minor units (`priceMinor`, `amountMinor`). The existing MCP tool takes decimal strings parsed with `parseMoney` and quantity via `parseQuantity` (`create-draft.ts:22-26`); new tools should keep that convention (`{formatted}` outputs via `server/mcp/format.ts`).
- Dates are `YYYY-MM-DD` (`isCalendarDate`).
- Document text in outputs must be fenced with `quoted()` (MCP-033).

---------------------------------------------------------------------------
## 1. INVOICES

| Tool | Lvl | Wraps | Input (reuse) | Covered | Wrinkle |
|---|---|---|---|---|---|
| list_invoices | 1 read | SVC invoices.ts:1113 `listInvoices(ownerId, filter)` (+ `parseInvoiceFilter` :933, `invoiceSummary` :1144) | `InvoiceFilter` via `parseInvoiceFilter(raw)` (status/q/customer/dates/sort/page); `INVOICE_STATUS_FILTERS` :912 | PART (list_unpaid_invoices :1121 only) | Page<InvoiceRow> with Date fields; bound page size; `ownedCustomerId` :1025 guards foreign customer ids |
| get_invoice | 1 | SVC invoices.ts:318/325 | existing | YES | **add `revision`, payment ids, line/version/log ids**; add `type`-specific `relatedDocuments` (credit-notes.ts:159) |
| list_invoice_versions / get_invoice_version | 1 | SVC invoice-versions.ts:401 `listVersions`, :415 `getVersion` | `invoiceId` / `versionId` | NO | version `document` is a big JSON snapshot (page `faktury/[id]/verze/[versionId]/page.tsx`) |
| list_invoice_mail_log | 1 | SVC invoice-mail.ts:532 `listEmailLog(ownerId, invoiceId)` + :572 `mailStateOf` | `invoiceId` | NO | rows carry recipients (personal data) and `status` incl. "unknown" needing acknowledge |
| list_reminder_history | 1 | SVC reminders.ts:362 `reminderHistory`, :425 `remindersForReview(ownerId,today)` | `invoiceId` / today | NO | `today` must be Prague date (`ctx.today`) |
| check_invoice_issuable | 1 | SVC invoice-lifecycle.ts:259 `checkIssuable(ownerId,id)` -> `IssueProblem[]` | `{id}` | NO (draft tool does not return it) | web returns it from `saveDraftAction` |
| preview_issue | 1 | SVC invoice-lifecycle.ts:334 `previewIssue(ownerId,id)` | ACT faktury/actions.ts:202 `{id}` | NO | shows number that WOULD be assigned; `peekNumber` (number-series.ts:383) does not consume |
| create_draft_invoice | 2 drafts | SVC invoices.ts:650 `saveDraft` | custom strict Zod (create-draft.ts:53-61) | YES | missing: tags, checkIssuable problems (see 0.3.1) |
| update_draft_invoice | 2 | SVC invoices.ts:650 `saveDraft` + tags.ts:66 `setInvoiceTags` + `assertTagNames` + `ensureDefaultSeries` + `checkIssuable` | ACT `saveDraftAction` (:188) `{draft: draftInputSchema (invoices.ts:241), tags}`; `draft.id`+`draft.revision` identify the edit | NO | whole-document replace (not a patch) - tool should read draft, merge, send; `lines` is full replacement; revision required; rejects non-draft (`invoices.ts:669` stale) |
| duplicate_invoice | 2 | SVC invoices.ts:764 `duplicateInvoice(actor,id)` -> `{id}` | ACT :334 `{id}` | NO | creates new draft; copies customer-account checks (`accountForCopy` :753) |
| draft_from_template | 2 | SVC invoice-templates.ts:345 `draftFromTemplate(actor,templateId)` | ACT sablony/actions.ts:49 `{id}` | NO | creates draft |
| convert_advance_to_final | 2 (creates a DRAFT final invoice; see note) | SVC advances.ts:118 `convertAdvance` after `ensureDefaultSeries` | ACT :351 `{id}` | NO | web runs ensureDefaultSeries first (0.3.3). Final is issued automatically only by `advance-automation.ts` job (issueIn at :138), not by this call. Level 2 is my reading; confirm. |
| delete_draft | 5 full (delete) | SVC invoices.ts:731 `deleteDraft` | ACT :368 `{id}` | NO | only drafts |
| issue_invoice | 4 | SVC invoice-lifecycle.ts:550 `issueInvoice(actor,id,{revision,variableSymbol?})` | ACT :206 `issueInput`; `variableSymbol` must match `MANUAL_VARIABLE_SYMBOL` (invoices.ts:88) | NO | consumes number (`allocateNumber` via `issueIn` :467); throws `NotIssuableError` with `problems`; revision required; web previews first (`previewIssue`) |
| mark_sent | 3 accounting (state only, no mail) | SVC invoice-lifecycle.ts:667 `markSent` | ACT :294 `{id}` | NO | `markSentMany` :693 `{done,skipped}` (ids max `MAX_BULK_DOCUMENTS`, lib/invoice) |
| acknowledge_unknown_mail | 3 | SVC invoice-mail.ts:502 `acknowledgeUnknown(actor,logId)` | ACT :302 `{id: logId}` | NO | needed to clear "unknown delivery" before resend (`hasUnresolvedUnknown` :233) |
| update_issued_invoice | 5 (edits a document the customer may hold; creates version; `resendSuggested`) - alt 4 | SVC invoice-versions.ts:278 `updateIssuedInvoice` + `setInvoiceTags` + `assertTagNames` | ACT :214 `{id,tags,document: issuedInputSchema (invoices.ts:259)}` | NO | returns `EditResult {revision,variableSymbol,resendSuggested,balanceWarning,status}`; `EDITABLE_STATUSES` invoice-versions.ts:64; external docs refused (`assertNotExternal`) |
| refresh_customer_snapshot | 5 (same reason) | SVC invoice-versions.ts:319 | ACT :376 `{id}` | NO | EditResult |
| restore_invoice_version | 5 | SVC invoice-versions.ts:421 `restoreVersion(actor,versionId)` | ACT :384 `{id: versionId}` | NO | needs version id from list_invoice_versions |
| cancel_invoice (storno) | 5 | SVC invoice-lifecycle.ts:605 `cancelInvoice` | ACT :318 `{id}` | NO | refreshes balances of related docs |
| restore_cancelled_invoice | 5 | SVC invoice-lifecycle.ts:643 `restoreInvoice` | ACT :326 `{id}` | NO | final-invoice conflict (`isFinalConflict` :636) |
| create_credit_note | 5 | SVC credit-notes.ts:69 `createCreditNote` after `ensureDefaultSeries` | ACT :342 `{id}` | NO | creates a credit-note DRAFT (no `allocateNumber` in credit-notes.ts); issuing it is separate (`issue_invoice`). Preview helper: `creditPreview` (exchange-rates.ts:199, async, rate lookup) |
| delete_imported_invoice | 5 | SVC invoice-lifecycle.ts:709 `deleteImported` | ACT :360 `{id}` | NO | only imported (external) docs |
| load_exchange_rate | 1 | SVC exchange-rates.ts:159 `loadRate(actor,{currency,date})` (async, rate-limited fxLookupUser, may write `exchange_rate.fetch`) | ACT :257 `rateInput` | NO | actor-taking read; writes cache row |
| invoice tags: list_tags / set_invoice_tags | 1 / 2 | SVC tags.ts:136 `listTags`; :66 `setInvoiceTags(actor,id,names)` | `tagNamesSchema` (tags.ts ~:18-33), `assertTagNames` | listTags only used in `faktury/form-data.ts`; no standalone web action for set | `deleteTag` (tags.ts:145) is NOT called by any web route/action - skip |

## 2. SENDING (emails to customers) - level 4

| Tool | Wraps | Input (reuse) | Wrinkle |
|---|---|---|---|
| prepare_invoice_email (read, level 1) | SVC invoice-mail.ts:603 `sendPrefill(ownerId,invoiceId,logId?)` | ACT :392 `{id,logId?}` | returns the editable draft message (to/cc/bcc/subject/body, attachments flags); `logId` variant prefill for resend |
| send_invoice | invoice-mail.ts:360 `sendInvoice(actor,invoiceId,raw)` -> `{logId}` | ACT :415 `{id,message: sendInputSchema}` (lib/mail-send.ts:50: to/cc/bcc/subject/body + `requestId` uuid + `revision` + `confirmedUnknown?` + `attachIsdoc?`) | rate limit sendUser in service; queued (async delivery by job - `deliverX` internal); PDF attached internally (not a binary input). Needs `revision`, `requestId` (tool can accept `idempotency_key` like create_draft) |
| resend_from_log | invoice-mail.ts:462 `resendFromLog(actor,logId,{requestId,confirmedUnknown})` | ACT :423 `resendInput` | |
| bulk_send_preview (level 1) / bulk_send | invoice-mail.ts:699 `bulkSendPreview`, :723 `bulkSend(actor,ids,requestId,previewed)` | ACT :431/:442 `idsInput`, `bulkInput` | action-composed protocol (0.3.5); `sendBulkUser` 5/h |
| send_payment_receipt | invoice-mail.ts:386 `sendReceipt(actor,invoiceId,paymentId,message)` | ACT :407 `{id,paymentId,message}`; prefill ACT :398 (= `sendPrefill(...,{kind:"payment_receipt",paymentId})`) | needs payment id (not in get_invoice yet); `receiptStale` :223 |
| send_reminder | reminders.ts:282 `sendManualReminder(actor,invoiceId,{...message,stageKey,confirmedRepeat})` | ACT :456 `reminderInput`; prefill :450 `reminderPrefill(ownerId,invoiceId,stageKey)` reminders.ts:265 | `stageKey` is a reminder-rule id or null (= manual); `confirmedRepeat` human confirm flag (don't default true); rate limit in service |

Reminder per-invoice switches (level 3, no customer-visible effect): `snooze_reminders` reminders.ts:343 `{id, until|null}` (ACT :464), `set_reminders_off` :354 `{id,on}` (ACT :472), `set_partial_reminders` :358 (ACT :480).

## 3. CUSTOMERS

| Tool | Lvl | Wraps | Input | Covered | Wrinkle |
|---|---|---|---|---|---|
| search_customers | 1 | customers.ts:172 | existing | YES | |
| list_customers / get_customer | 1 | customers.ts:154 `listCustomers(ownerId, filter)` + `parseCustomerFilter` :85, :168 `getCustomer` | filter query | NO | `customerInvoiceStats` (invoices.ts:1165) for stats; `averagePaymentDays` payments.ts:593 (unused by web pages) |
| save_customer (create + edit) | 2 | customers.ts:259 `saveCustomer(actor,input)` | `customerInputSchema` (customers.ts:37; has optional `id`) | NO | ACT zakaznici:49 and faktury:230 (`createCustomerAction`, same call). Duplicate-ICO handling `duplicateIcoOf` :188 is inside the service. Returns saved row |
| archive_customer / restore_customer | 2 (reversible) | customers.ts:288/292 | `{id}` | NO | ACT zakaznici:53/60 |
| delete_customer | 5 | customers.ts:296 | `{id}` | NO | ACT zakaznici:67; refused if invoices exist (service) |
| verify_customer_vat | 2 (external VIES call, writes vatVerifiedAt) | customers.ts:315 `verifyVat(actor,id)` async | `{id}` | NO | rate limit viesLookup inside; returns `Date` -> ISO string (ACT :74-82) |
| lookup_company_ares | 1 | `lookupAres(ico)` server/external/ares (NOT a service) | `{ico}` | NO | rate limit `aresLookup` is in the ACTION (0.2) - must be replicated; external network |

## 4. CATALOG

| Tool | Lvl | Wraps | Input | Covered | Wrinkle |
|---|---|---|---|---|---|
| search_catalog | 1 | catalog.ts:158 | existing | YES | |
| list_catalog / get_catalog_item / list_catalog_categories / list_units | 1 | catalog.ts:139 `listCatalog`+`parseCatalogFilter` :65, :153, :169, :302 `listUnits` | | NO | |
| save_catalog_item (create+edit) | 2 | catalog.ts:256 `saveCatalogItem` | `catalogInputSchema` :32 (`priceMinor`, `currency`, `unit`, `category`, `tags`, optional `id`) | NO | ACT cenik:50; also `saveLineToCatalogAction` composes it (0.3.6) |
| archive / restore_catalog_item | 2 | catalog.ts:284/288 | `{id}` | NO | ACT cenik:54/61 |
| save_unit | 2 | catalog.ts:312 `saveUnit(actor,name)` | `unitNameSchema` :48 | NO | ACT cenik:68 |
| delete_unit | 5 (delete) | catalog.ts:333 | `{id}` | NO | ACT cenik:72 |

## 5. PAYMENTS (on invoices) - level 3 (delete = 5)

| Tool | Wraps | Input (reuse) | Wrinkle |
|---|---|---|---|
| add_payment | payments.ts:346 `addPayment(actor,invoiceId,raw)` -> `{id}` | ACT :488 `{id, payment: paymentInputSchema}` (lib/payments.ts ~:98: revision, paidOn, amountMinor, currency, creditedMinor?, method (PAYMENT_CHANNELS), note) | revision; foreign-currency `creditedMinor`; status derived by `deriveStatus` (lib/payments.ts) |
| add_refund | payments.ts:365 `addRefund` | ACT :496 same | |
| update_payment | payments.ts:422 `updatePayment(actor,paymentId,raw)` | ACT :504 | payment id + invoice revision |
| delete_payment | payments.ts:482 `deletePayment(actor,id,revision)` | ACT :512 `{id,revision}` | **level 5** (destructive; user's rule) |
| mark_paid | payments.ts:526 `markPaid(actor,id,{revision,paidOn?})` | ACT :520 | paidOn must be calendar date |
| mark_paid_many | payments.ts:542 `{done,skipped}` | ACT :528 `idsInput` | |
| close_difference | payments.ts:563 `closeDifference(actor,id,{revision,confirmed})` | ACT :536 | `confirmed` = human confirmation flag (do not default) |
| list_payments | payments.ts:337 `listPayments` | | already inside get_invoice (without ids) |

## 6. BANK (payment notices, "aviza")

| Tool | Lvl | Wraps | Input | Wrinkle |
|---|---|---|---|---|
| list_bank_notices / bank_status / notice_counts | 1 | bank-notices.ts:539 `listNotices(ownerId,filter)`, :493 `bankStatus`, :598 `noticeCounts` | NoticeFilter (see `platby/page.tsx`) | |
| notice_candidates | 1 | bank-notices.ts:649 `noticeCandidates(ownerId,noticeId,search?)` | ACT platby:93 `{id,search?≤100}` | |
| assign_notice | 3 | bank-notices.ts:816 `assignNotice(actor,id,raw)` | ACT platby:58 `{id, assign: assignInputSchema}` (lib/notice-queue.ts:16 `{invoiceId, creditedMinor?}`) | creates a payment |
| split_notice | 3 | :840 `splitNotice` | `splitInputSchema` :22 (2..10 `parts`) | |
| dismiss_notice / restore_notice | 3 | :868 / :881 | `{id}` (ACT platby:72/79) | |
| undo_notice | 5 (removes the payment it created; `undoNoticeIn` payments.ts:280) - alt 3 | :891 | `{id}` (ACT platby:86) | |
| check_mailbox_now | 3, borderline (reads the user's bank mailbox via IMAP) | bank-poll.ts:322 `checkMailboxNow(actor,requestId)` | ACT platby:99 `{requestId: uuid}` | needs configured mailbox; DEMO lock + `bankCheckUser` rate limit inside; **depends on bank-mailbox credentials -> belongs with the human-confirm list (section 14)** |
| bank accounts: list_bank_accounts | 1 | bank-accounts.ts:90 | | |
| save_bank_account | 3 | bank-accounts.ts:121 `saveBankAccount` | `bankAccountInputSchema` :22 (name, currency, number+bankCode or iban, swift) ACT ucty:43 | returns id (action drops it) |
| set_default_bank_account | 3 | :168 `setDefaultForCurrency(actor,currency,id)` | ACT ucty:49 `{id,currency}` | note arg order |
| hide / unhide_bank_account | 3 | :209 / :190 | `{id}` | |
| delete_bank_account | 5 | :228 | `{id}` | refused if used (`isAccountUsed` :113) |

## 7. RECURRING PLANS ("pravidelne")

| Tool | Lvl | Wraps | Input | Wrinkle |
|---|---|---|---|---|
| list_recurring / get_recurring / list_recurring_runs / list_plan_invoices | 1 | recurring.ts:323 `listRecurring`, :308 `getRecurring`, :346 `listRuns`, :387 `listPlanInvoices` | ids | |
| preview_recurring | 1 | recurring.ts:357 `previewRecurring(ownerId, raw, count=12)` | `recurringInputSchema` :51 | |
| save_recurring (create+edit) | 3, **but `mode: "issue"`/`"send"` makes the scheduler issue/send by itself -> treat those modes as level 4 (issue_send)** | recurring.ts:264 `saveRecurring` | `recurringInputSchema` (name, customerId, document: `templateDocumentSchema` invoice-templates.ts:67, frequency/every/issueRule/issueDay/startsOn/endsOn/maxCount/periodOffset, mode draft|issue|send, notifyDaysBefore, `confirmSend`) | `confirmSend` is required for send mode (recurring.ts:226) = human-confirmation flag; wrapper should not let the agent set it unless capability >= 4; restore sets mode send plans to paused (account-restore.ts) |
| pause_recurring / resume_recurring | 3 | recurring-run.ts:247 / :267 | `{id}` | resume of a "send" plan re-enables automatic emails |
| resolve_missed_run | 3 (action "draft" creates a draft; "skip") | recurring-run.ts:647 `resolveMissed(actor,runId,"draft"|"skip")` | ACT pravidelne:98 | |
| recurring_from_template | 3 | recurring.ts:268 | `{id: templateId}` | |
| delete_recurring | 5 | recurring.ts:291 | `{id}` | |

## 8. TEMPLATES (invoice templates "sablony")

| Tool | Lvl | Wraps | Input | Wrinkle |
|---|---|---|---|---|
| list_invoice_templates / get_template | 1 | invoice-templates.ts:135 / :130 | | |
| save_invoice_as_template | 3 | invoice-templates.ts:227 `templateFromInvoice(actor,invoiceId,name)` | ACT sablony:41 `{id,name}` | |
| delete_template | 5 | :209 | `{id}` (ACT sablony:57) | |
| (save_template raw) | - | :205 `saveTemplate` + `templateInputSchema` :94 | **not called by any web route/action** (only internally) - skip or add deliberately |

## 9. NUMBER SERIES ("rady") - level 3, delete 5
list_number_series (1): number-series.ts:189 `listSeries(ownerId,date?)`; `peekNumber` :383 (read next number).
save_number_series: :227 `saveSeries(actor,raw)` `seriesInputSchema` :40 (ACT rady:45). set_next_number: :325 `setNextNumber(actor,id,next,date?)` `nextNumberInputSchema` :56 (ACT rady:51) - **affects numbering of legal documents; risk of gaps/duplicates, service checks `isNumberTaken` :90**. set_default_series :298 (ACT rady:57). delete_series :360 (5; ACT rady:63). `ensureDefaultSeries` :172 is internal (called by actions before save/credit note/convert).

## 10. SUPPLIER & SETTINGS

| Tool | Lvl | Wraps | Input | Wrinkle |
|---|---|---|---|---|
| get_supplier | 1 | supplier.ts:80 `getSupplier`, :95 `missingSupplierKeys` | | |
| save_supplier | 3 | supplier.ts:104 `saveSupplier(actor,input)` | `supplierInputSchema` :25 (ACT dodavatel:48) | whole-profile replace; images are separate (`setSupplierImage` binary - excluded) |
| get_preferences | 1 | preferences.ts:120 `getPreferences` | | |
| save_preferences | 3 | preferences.ts:128 `savePreferences(actor,patch)` | `preferencesPatchSchema` :96 (ACT vychozi:32) | patch; **omit design/appearance keys** (`designId, accentColor, surfaceColor, textColor, lineColor, logoPosition` = web cosmetics via `saveDesignAction` designy/actions.ts:21) and decide on `show*`; includes `advanceFinalMode` (also set by ACT automatizace:83), FX settings (`fixedRates`), turnover limits (feeds reports `limits`) |
| get_automation | 1 | automation.ts:55 `getAutomation`, :74 `automationImpact` | | |
| set_automation (key,enabled) | 3 to disable; **4 to enable** (enabling reminders/recurringSend/paymentReceipt/advanceInvoice makes the app send mail on its own) | automation.ts:167 `setAutomation(actor,key,enabled,{confirmed})` | ACT automatizace:43 `{key: AUTOMATION_KEYS (lib/automation.ts:3), enabled, confirmed}` | `confirmed` human flag; `available` false keys throw |
| set_paused | 3 pause / 4 resume | :191 `setPaused(actor,paused,{confirmed})` | ACT :51 | resume requires confirmed |
| set_send_time / set_daily_digest / set_period_summary / set_tax_reminder / set_limit_mail | 3 | automation.ts:207 / :216 / :228 / :250 / :254 | `string`, bool, `PERIOD_SUMMARIES`, bool, bool (ACT :56-81) | these mail the OWNER (digests), not customers |
| list_reminder_rules | 1 | reminders.ts:79 | | |
| save_reminder_rule | 3 | reminders.ts:125 `saveReminderRule(actor, raw)` | `reminderRuleSchema` lib/reminders.ts:38 (offsetDays, texts cs/en, optional id) (ACT automatizace:90) | raw `unknown` parsed inside |
| delete_reminder_rule | 5 | reminders.ts:182 | `id` (ACT :97) | |
| list_email_templates / get | 1 | email-templates.ts:85 `listEmailTemplates`, :76 `getEmailTemplate` | | |
| save_email_template | 3 | email-templates.ts:104 | `emailTemplateSchema` lib/email-template.ts:42 (kind, language, subject, body, variables validated) (ACT posta/sablony:37) | rate limit mailSaveUser inside; text customers will receive |
| reset_email_template | 3 | :140 `resetEmailTemplate(actor,kind,language)` | `{kind: MESSAGE_KINDS, language: LANGUAGES}` (ACT :45) | returns defaults after reset (action read-back, 0.3.10) |
| save_mail_look (non-binary parts) | 3, optional | mail-look.ts `saveMailLook(actor,raw)` (ACT posta/vzhled:27) | | web cosmetics for emails; logo upload excluded - suggest leaving out (cosmetic) |

## 11. REPORTS / TAX (read, level 1)
- get_overview (YES): uses `reportSummary`, `reportCounts` (reports.ts:13,17) + `invoiceSummary`.
- Candidates, all pure functions of `(ownerId, ReportFilter, today)`: `reportBundle` (reports.ts:67) which includes summary, previous period, series, aging bands (`agingBands` :29), `topCustomers` :33, `topItems` :37, `currencyShares` :41, `paymentDays` :45 and `limits` (turnover VAT/flat limits; `components/reports/limits-card.tsx`). Filter: `parseReportFilter`/`filterFromQuery`/`reportQuery` in `lib/report-filter.ts`. Web path: `app/(app)/prehledy/page.tsx` -> `cachedReport(userId, accountStamp, today, query)` (`server/report-cache.ts:14`). Tools: `get_report` (bundle subset), `get_aging`, `get_top_customers`, `get_turnover_limits`.
- Tax: `taxOverview(ownerId, TaxFilter, today)` tax-report.ts:26 (+`parseTaxFilter`), web `prehledy/dane/page.tsx` -> `cachedTax`. Exports (`exportTaxOverview`, `renderTaxPdf`, report-export.ts `buildSheet`) are file-based = excluded.
- Wrinkle: `Unconverted` amounts (documents without CNB rate) should be surfaced like get_overview does.
- `data-checks.ts` (`accountDataProblems`) is an ops/consistency checker, not user-facing -> skip.

## 12. SEARCH
- search_customers / search_catalog: YES.
- `quick_search` (global: customers, invoices, catalog, recurring...): SVC quick-search.ts:71 `searchAll(ownerId,q,perGroup)`; ACT hledani-actions.ts:12 (rate limit searchUser + min length in the ACTION, 0.2). Level 1. Returns `SearchHit {group,id,label,detail,href}`; `href` is a relative web path -> use `appLink(baseUrl, href)`.

## 13. AUDIT HISTORY (read, level 1)
- `listAudit(actor, filter)` audit-read.ts:121 -> `Page<AuditRow>`; filter `AuditFilter {action,entity,source (web|scheduler|import|system|mcp),actor self|other,from,to,page,pageSize<=200}` via `parseAuditFilter` :81 (drops invalid; dates are Prague-day `YYYY-MM-DD`). Web: `nastaveni/historie/page.tsx`. `listAuditFacets(actor)` :173 (action/entity names).
- `entityHistory(userId, entity, entityId)` :191 (async, <=100 rows) used by `components/audit/entity-history.tsx` (invoice/customer/catalog_item/recurring_invoice/...).
- Wrinkle: rows include `before`/`after` JSON (already `redact()`ed for secrets, but contain business data), `ip`/`userAgent` (already nulled for foreign actors via `maskForeignActor` :115 - MCP output should omit ip/userAgent/requestId anyway), `clientId/clientName`. `exportAuditCsv` :267 = file export, excluded. A bare `listAuditForOwner(ownerId, limit)` exists in `server/audit/read.ts` (no filtering; used elsewhere).

## 14. IMPORT UNDO (level 5, included only for "undo imports")
`undoBatch(actor,batchId)` import-undo.ts:29 (ACT nastaveni/import/actions.ts:121 `{batchId}`), needs a list tool: `listBatches(ownerId, limit=20)` import-batch.ts:96 (read, level 1). Everything else about import (upload/parse/confirm/mapping/presets/discard) is file-based -> excluded.

## 15. EXCLUDED (for completeness) and TO CONFIRM
Excluded per brief: administration (`administrace/actions.ts`, `pozvanka/[token]/actions.ts`, users.ts, invitations.ts, instance-*), account backup/restore (`nastaveni/zaloha`, account-backup/restore), delete account + session revocation (`nastaveni/ucet/actions.ts`), exports (`nastaveni/export`), file/PDF/ISDOC routes (`faktury/[id]/pdf|nahled|priloha|verze/.../pdf`, `hromadne-pdf`, `soubory/[id]`, `prehledy/export`, `prehledy/dane/export`, `nastaveni/historie/export`, `nastaveni/designy/nahled`, `posta/vzhled/nahled`, `import/nahrani`, `zaloha/nahrani`), logo/image upload (`uploadSupplierImageAction`, `removeSupplierImageAction`, mail logo), cosmetics (`setThemeAction` app/actions.ts, `saveDesignAction`, dashboards `dashboardy/actions.ts`, widgets, notifications `upozorneni/actions.ts`, onboarding, design-preview), MCP own settings (`nastaveni/asistenti/actions.ts`, mcp-settings.ts, mcp-connections.ts), internal (`planX/runX/recoverX/purgeX/deliverX`, `applyPayments`, `insertPayment`, `linkTags`, `escapeLike`, `ownerOf`, `insertLines`, `ingestNotice`, `queueMail`, `queueReminder`, `issueIn`, `allocateNumber` ...), also `createdAt`-style web-only helpers (`customerDefaultsAction`, `loadRate` kept as optional read).

### FLAG FOR HUMAN CONFIRMATION (SMTP / mailbox credentials) - NOT in the inventory above
- `saveMailSettingsAction`, `clearOwnSmtpAction`, `sendTestMailAction` (`nastaveni/posta/actions.ts:23,28,33`) -> `mail-settings.ts` (`saveMailSettings`, `clearOwnSmtp`, `sendTestMail`; DEMO lock, `mailSaveUser`/`mailTestUser` rate limits). SMTP credentials (secrets, encrypted via server/crypto.ts).
- `saveBankMailboxAction`, `clearBankMailboxAction`, `testBankMailboxAction` (`nastaveni/aviza/actions.ts:25,30,35`) -> `bank-mailbox.ts` (IMAP credentials; DEMO lock; `bankSaveUser`/`bankTestUser`).
- Borderline related: `check_mailbox_now` (section 6) uses the stored mailbox credentials but does not set them; `reminder`/`email template` texts are customer-visible but not secrets.

---------------------------------------------------------------------------
## 16. AUDIT LOGGING - how it works

- Table `audit_log` (`server/db/schema/audit.ts:5`): id autoinc, at, actorId, ownerId (no FK, protected by triggers `drizzle/0001_audit_triggers.sql`), source enum `web|scheduler|import|system|mcp`, scope `user|instance`, action, entity, entityId, before/after JSON, ip, userAgent, requestId, clientId, clientName (cols added in `drizzle/0053_mcp_settings_audit_client.sql`). `audit_purge` table permits account-deletion purge.
- `server/audit/context.ts`: `Actor {userId, source, clientId?, clientName?, ip?, userAgent?, requestId?}`; `runWithActor(actor, fn)` stores in AsyncLocalStorage; `currentActor()` throws outside a mutate.
- `server/audit/record.ts:35` `recordAudit(tx, entry)`: validates scope (user scope needs ownerId; instance scope only for entities in `INSTANCE_ENTITIES`: user, session, account, invitation, rate_limit, route, backup, exchange_rate), reads actor from ALS, applies `redact()` (`server/audit/redact.ts`: masks keys containing pass/pwd/secret/token/apikey/privatekey/cookie/authorization/heslo/totp as `[skryto]`, binaries as `[binární data]`).
- `server/services/mutation.ts:17` `mutate(actor, action, fn(tx, audit))`: `runWithActor` + immediate sqlite transaction; **throws if fn is async or recorded zero audit rows** -> every service mutation is audited atomically with the change. The audit callback uses `entry.action ?? action`; a mutation can write several rows (e.g. recalculating balances).
- The MCP wrapper (`mcp/tool.ts:92`) wraps the whole `run` in `runWithActor(ctx.actor)` with `source: "mcp"`, clientId, clientName (OAuth client's self-declared name), `requestId = randomUUID()` and NO ip/userAgent. `mutate(actor,...)` called with that same actor stores them, so any new write tool must pass `ctx.actor` to the service (not a fresh web actor). The audit view shows "Asistent: <name>" (MCP-030).
- Reads are NOT audited (MCP-031). Rate-limit denial audits `rate_limit.exceeded` (instance scope) once per window.
- Audit action names seen via `mutate(actor,"...")`: invoice.save/issue/update/delete/delete_imported/duplicate/credit_note/final_from_advance/restore_version/refresh_customer/send/tags_set/pdf_download/import_pdf, payment.create/refund/update/delete/mark_paid/close_difference, notice.assigned/split/dismissed/restored/undone, customer.save/delete/vat_verify, catalog_item.save, unit.save/delete, recurring.pause/resume/delete/run, number_series.save/set_default/set_next/delete/ensure_defaults, bank_account.save/set_default/hide/unhide/delete, supplier.save/image_*, preferences.save/onboarding_complete, reminder_rule.save/delete, email_template.save/reset, automation.enable/disable/pause/resume, mcp.settings_changed/connected/disconnected, invoice_template.delete, tag.delete (no caller). Statuses cancel/restore use `changeStatus` (invoice-lifecycle.ts:~586) with its own action names.
- Writes NOT through `mutate`: dashboards.ts, import-batch.ts (importBatch updates), exports.ts, bank-mailbox.ts row updates, account-restore (all excluded domains).

## 17. `mcp_settings` schema and capability switches

`server/db/schema/mcp.ts` (migration `drizzle/0053_mcp_settings_audit_client.sql`):
```
mcp_settings(
  user_id  text PK -> user.id ON DELETE CASCADE,
  enabled  integer(boolean) NOT NULL DEFAULT false,
  can_read   boolean NOT NULL DEFAULT true,
  can_create boolean NOT NULL DEFAULT false,
  can_edit   boolean NOT NULL DEFAULT false,
  can_issue  boolean NOT NULL DEFAULT false,
  can_send   boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0,        -- optimistic concurrency for saveMcpSettings
  updated_at integer(timestamp_ms) NOT NULL)
```
One row per user only after first save; defaults in `DEFAULT_MCP_SETTINGS` (`lib/mcp-settings.ts:30`). Drizzle property names: `read, create, edit, issue, send` (cols `can_*`).
Current model = 5 switches `read|create|edit|issue|send` (`McpCapability`, lib/mcp-settings.ts:3-11), NOT yet the new 5 cumulative levels. Only `["read","create"]` are `AVAILABLE_CAPABILITIES` (lib/mcp-settings.ts:14).

Where capability switches are used (all must change for new levels):
- Type/consts/Zod: `lib/mcp-settings.ts` (`McpCapability`, `MCP_CAPABILITIES`, `AVAILABLE_CAPABILITIES`, `McpSettings`, `DEFAULT_MCP_SETTINGS`, `mcpSettingsSchema` strict, edit/issue/send `.default(false)`).
- Service `server/services/mcp-settings.ts`: `readSettings` :26, `getMcpSettings` :36, `allowedCapabilities` :41 (filters `AVAILABLE_CAPABILITIES` by switch; empty when disabled), `saveMcpSettings` :46 (rejects unavailable switches with `E.notAvailable`; **hard-writes edit/issue/send = false** at :64-66; revision check `E.stale`; audit `mcp.settings_changed` with before/after minus revision). Also re-exports AVAILABLE_CAPABILITIES.
- Wrapper `server/mcp/tool.ts:13,38,70-75` (`ToolDef.capability`, `allowedCapabilities(settings).includes(def.capability)` else `T.capabilityOff[def.capability]`). **With cumulative levels, `admit` must check level >= required rather than set membership.**
- `server/mcp/server.ts:35-45`: lists ALL tools, appends `offSuffix` when capability off, `readOnlyHint: def.capability === "read"`.
- `server/mcp/consent-info.ts:3,45,58` (`allowedCapabilities` -> consent page); `components/auth/assistant-consent.tsx:16-52`; `app/(auth)/pristup-asistenta/page.tsx:79-91`.
- UI settings form `components/settings/assistants-form.tsx:8-10,63,117-141` (checkbox per capability, disabled with "připravujeme" when not in AVAILABLE_CAPABILITIES) + page `app/(app)/nastaveni/asistenti/` + action `asistenti/actions.ts:28` (`saveMcpSettingsAction`).
- Texts `lib/texts.ts`: consent `capabilities` :3108, settings `capabilitiesTitle/Label/comingSoon/capabilities` :3154-3163, `errors.notAvailable` :3165, tools `capabilityOff` :3200-3206 (+`offSuffix` :3207).
- Backup: `server/backup/tables.ts:659-672` (columns can_read..can_send listed, `since: 2`); `server/services/account-restore.ts:242` (restore forces `enabled=false`, MCP-042); `server/services/users.ts:36,101` (account delete cleanup).
- Spec: `docs/superpowers/specs/2026-11-11-mcp-design.md` MCP-011 (:72-81 table), MCP-012 (:83), MCP-025.
- Tests mentioning capabilities:
  - `tests/backend/mcp-settings.test.ts:12,70` (`AVAILABLE_CAPABILITIES` toEqual `["read","create"]`), :60-70 defaults, :73-90 save/revision, :95-100 "edit/issue/send cannot be switched on", :106+ audit.
  - `tests/backend/mcp-tool.test.ts:56-67,160-170` (echo tools with capability read/create; capabilityOff text).
  - `tests/backend/mcp-endpoint.test.ts:41,51,197` (tools list includes off tools; `setAccess` helper :60 uses `{enabled,read,create}`).
  - `tests/backend/mcp-tools-read.test.ts:262-266` (asserts the set of `create` tools equals `["create_draft_invoice"]` - must be updated), :509 (`tool.capability === "read"`).
  - `tests/backend/mcp-tools-create.test.ts:173,457` (capability create; `TEXTS.mcp.tools.capabilityOff.create`).
  - `tests/e2e/mcp-settings.spec.ts:34-57`, `tests/e2e/mcp-consent.spec.ts:44-55`, `tests/e2e/mcp-helpers.ts` (Czech labels "Číst ...", "Zakládat koncepty faktur"), `tests/unit/mcp-consent-info.test.ts`, `tests/unit/source-rules.test.ts`, `tests/backend/backup-registry.test.ts` / `backup-roundtrip` (column registry).
- Migration need: moving to 5 cumulative levels means either keep columns and reinterpret (read/create/edit/issue/send -> read/drafts/accounting/issue_send/full) or add a single `level` column + backfill; backup registry (`tables.ts`) and its tests must match the schema.

---------------------------------------------------------------------------
## 18. Summary of surprises
1. get_invoice lacks `revision`/payment ids; all concurrency-checked tools depend on it.
2. Draft save = 5 steps in the action (tags, series, problems) - not in `saveDraft`.
3. `confirmed` / `confirmedRepeat` / `confirmSend` / `confirmedUnknown` flags in services are human-confirmation gates; agent wrappers must surface them, not auto-set.
4. Enabling automations, recurring plans with mode issue/send, and resuming paused sending are effectively level 4 even though they are "settings".
5. Rate limits for ARES and quick search live only in actions.
6. Credit note and advance->final create drafts (numbers consumed only on `issueInvoice`).
7. `saveTemplate` and `deleteTag` have no web caller.
8. `saveMcpSettings` forces edit/issue/send to false and the tests assert it; the cumulative-level change touches ~12 files listed in section 17.
