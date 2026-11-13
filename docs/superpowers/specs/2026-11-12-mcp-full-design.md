# Fakturan: plný přístup asistentů přes MCP – návrh

Datum: 2026-11-12. Navazuje na `2026-11-11-mcp-design.md` (dál jen „návrh MCP v1“), který zůstává platný, pokud tento dokument neříká jinak. Podklad s odkazy na soubory a řádky: `2026-11-12-mcp-full-inventory.md` (dál jen „inventura“).

Značky: bez značky = rozhodl uživatel. **[volba]** = rozhodnutí autora návrhu, které uživatel může změnit.

---

## 1. Záměr

Uživatel chce, aby asistent uměl ve Fakturanu všechno, co dává smysl dělat agentem, a zároveň chce přesně omezit, co asistent smí, typicky „nesmí nic mazat“. Místo pěti nezávislých přepínačů schopností proto zavádíme **jednu úroveň oprávnění** s pěti stupni, kde vyšší obsahuje vše z nižších. Každé volání nástroje se ověří proti úrovni a zapíše do logu.

MCP zůstává **tenká vrstva nad existujícími službami** (ARC-001). Nástroj nesmí obsahovat doménovou logiku. Kde dnes logika žije ve web akci místo ve službě, přesune se beze změny chování do služby a web i MCP volají totéž (kap. 6).

## 2. Cíle, mimo rozsah, neúspěch

### 2.1 Cíle

1. Úroveň oprávnění (5 stupňů) místo přepínačů schopností v Nastavení › Asistenti.
2. Nástroje MCP pro všechny agentně smysluplné funkce Fakturanu (kap. 5), každý jako obal existující služby.
3. Kontrola úrovně při každém volání (navazuje na MCP-012).
4. Nový **log volání** asistentů (každé volání včetně čtení a odmítnutí), vypínatelný, oddělený od Historie změn.

### 2.2 Mimo rozsah

- **Administrace** (uživatelé, pozvánky, stav a audit instance, záloha a obnova účtu, smazání účtu). Jen ve webu, na žádné úrovni.
- **Soubory**: stažení PDF/ISDOC, hromadné PDF a ZIP, import ze souborů (nahrání, mapování, potvrzení dávky, předvolby mapování), exporty, nahrání loga a obrázků dodavatele, náhledy designu. Nástroje místo souboru vracejí odkaz do webu.
- **Vzhled webu**: motiv, dashboardy a widgety, zvoneček oznámení, onboarding, designy dokladů (`saveDesignAction`), vzhled e-mailů (`mail-look`) **[volba]**.
- **Přístupové údaje**: SMTP (`mail-settings`) a bankovní schránka (`bank-mailbox`) se přes MCP nenastavují ani nemažou **[volba]**.
- **Operace vyžadující potvrzení člověkem** (uživatel zvolil variantu B): tam, kde služba přijímá potvrzovací příznak (`confirmed`, `confirmedRepeat`, `confirmedUnknown`, `confirmSend`), posílá obal vždy `false` a nástroj potvrzení nikdy nenabízí ve vstupu. Kde operace bez potvrzení nikdy neprojde, nástroj neexistuje (viz 5.7). Kde služba potvrzení vyžaduje jen v některém stavu, vrátí se chyba nástroje s větou, že operaci je potřeba dokončit ve webu, a s odkazem.
- **Automatizace zapnuté člověkem ve webu** se při operacích asistenta chovají jako při stejné operaci ve webu: zapsání platby nebo spárování avíza může odeslat automatické potvrzení platby, převod zálohy může vést k automatickému vystavení konečné faktury. Uživatel to přijal, protože automatizaci zapnout přes MCP nejde. Úrovně se kvůli tomu nemění.
- MCP prompty a resources, přepínače po jednotlivých asistentech, API tokeny (beze změny proti v1).
- Vlastní nastavení MCP (úroveň, log, propojení) se přes MCP měnit nedá.

### 2.3 Neúspěch, i když to technicky funguje

- Asistent provede operaci nad svou úrovní, nebo ji provede přes jiný nástroj nižší úrovně (obejití).
- Nástroj se chová jinak než stejná akce ve webu (jiná validace, chybějící krok, jiný audit).
- V nástroji vznikne doménová logika, kterou web nemá.
- Asistent potvrdí něco, co ve webu potvrzuje člověk.
- Volání chybí v logu, i když je log zapnutý; nebo log obsahuje data z dokladů.
- Změna provedená asistentem chybí v Historii změn, nebo v ní nejde poznat, že ji udělal asistent.
- Asistent vidí nebo změní data jiného účtu.

## 3. Úrovně oprávnění

| # | Id | Název ve webu | Smí navíc proti nižší úrovni |
|---|---|---|---|
| 1 | `read` | Jen čtení | Vše číst. Nic nezměnit. |
| 2 | `drafts` | Koncepty | Zakládat a upravovat koncepty faktur, zákazníky, položky ceníku. Nic, co vidí zákazník, a nic, co spotřebuje číslo. |
| 3 | `accounting` | Účetní operace | Platby, bankovní avíza, účty, číselné řady, opakované faktury v režimu koncept, šablony, nastavení dodavatele, výchozích hodnot, upomínek a e-mailových šablon, vypínání automatizací. |
| 4 | `issue_send` | Vystavování a odesílání | Vystavit fakturu (spotřebuje číslo), odeslat e-mail zákazníkovi, upomínku, potvrzení platby, hromadné odeslání; opakované faktury, které se vystaví samy. |
| 5 | `full` | Plný přístup | Mazat, stornovat, obnovit storno, dobropisy, úprava vystavené faktury a obnovení její verze, vrácení avíza, vrácení importu. |

- **MCP-050** Úroveň je jedna na uživatele a platí pro všechny jeho asistenty (jako v1). Výchozí je `read`. Hlavní vypínač (MCP-010) zůstává beze změny.
- **MCP-051** Nástroj deklaruje minimální úroveň. U `save_recurring` je požadovaná úroveň vyšší ze dvou: podle režimu na vstupu a podle režimu uloženého plánu (`draft` = 3, `issue` a `send` = 4). Uložený plán se čte přes `getRecurring`. Asistent s úrovní 3 tak nezmění běžící plán, který sám vystavuje nebo odesílá **[volba]**.
- **MCP-052** Ověření při každém volání (rozšíření MCP-012) v tomto pořadí: dostupnost → účet → vypínač → propojení → **minimální úroveň nástroje** (před validací vstupu, takže asistent pod úrovní se nedozví nic o vstupu) → validace vstupu → případně úroveň odvozená ze vstupu (MCP-051) → služba **[volba]**. Odmítnutí je chyba nástroje s českou větou, která říká potřebnou úroveň („Tahle operace vyžaduje úroveň Vystavování a odesílání. Úroveň nastavíte v Nastavení › Asistenti.“). Zachycuje i volání nástroje, který klient zná ze staršího seznamu.
- **MCP-053** `tools/list` vrací **jen nástroje dostupné na aktuální úrovni uživatele** (nahrazuje MCP-025). Když je hlavní vypínač vypnutý nebo klient odpojený, seznam je prázdný **[volba]**. Server posílá MCP `instructions` (a stejnou větu má popis každého nástroje úrovně nižší než 5 **[volba]**): „Fakturan má pět úrovní oprávnění (Jen čtení, Koncepty, Účetní operace, Vystavování a odesílání, Plný přístup). Aktuální úroveň je <název>. Pokud ti chybí nástroj pro to, co uživatel chce, je možné, že vyžaduje vyšší úroveň; řekni uživateli, že ji může nastavit v Nastavení › Asistenti. Operace, které ve webu potvrzuje člověk, přes asistenta nejdou vůbec.“ Endpoint je bezstavový (MCP-035), takže změnu úrovně klient uvidí po novém načtení seznamu nástrojů; do té doby ho chrání MCP-052. Anotace: `readOnlyHint` pro úroveň 1, `destructiveHint` pro úroveň 5 **[volba]**.
- **MCP-054** Nastavení › Asistenti: místo přepínačů schopností volba úrovně (5 možností s jednou větou popisu, co úroveň přidává). Souhlasová stránka ukazuje aktuální úroveň místo seznamu schopností.
- **MCP-055** Migrace dat: nový sloupec `level` v `mcp_settings`, sloupce `can_*` se odstraní. Převod: `can_create = true` → `drafts`, jinak `read` **[volba]**. Registr záloh (`server/backup/tables.ts`) a obnova se upraví; starší záloha se sloupci `can_*` se při obnově převede stejným pravidlem. Po obnově zůstává hlavní vypínač vypnutý (MCP-042). Souhlasy a tokeny OAuth schopnosti neobsahují (jediný scope `fakturan`, MCP-008), takže stávající propojení po migraci fungují dál bez nového souhlasu.
- **MCP-056** Změna úrovně se zapíše do Historie změn jako dosud (`mcp.settings_changed`, zdroj `web`).

## 4. Log volání

- **MCP-060** Nová tabulka `mcp_call_log`: id, `owner_id`, `at`, `client_id`, `client_name`, `tool`, `outcome` (`ok` | `denied` | `error`), `reason` (krátký kód: např. `level`, `disabled`, `not_connected`, `invalid_input`, `service_error`, `confirm_in_web`), `required_level`, `request_id`. **Neukládají se argumenty ani výstup** **[volba]** (data z dokladů v logu nebudou; v souladu s MCP-036).
- **MCP-061** Zápis dělá obal `runTool` u každého volání, kde je znám vlastník (claim `sub` odpovídá aktivnímu účtu), včetně odmítnutí před `admit` dokončením. Zápis logu nesmí změnit výsledek volání: selhání zápisu jde do Sentry a volání pokračuje. Zápis logu je mimo audit transakci služby.
- **MCP-062** Přepínač „Zaznamenávat volání asistentů“ v Nastavení › Asistenti, výchozí **zapnuto** **[volba]**. Když je vypnutý, do logu se nic nezapisuje. Změny dat jdou do Historie změn vždy (MCP-030) bez ohledu na přepínač. Změna přepínače se zapíše do Historie změn.
- **MCP-063** Nastavení › Asistenti zobrazí log: čas, asistent, nástroj, výsledek, důvod odmítnutí česky; stránkování, nejnovější nahoře; filtr podle asistenta a výsledku **[volba]**.
- **MCP-064** Záznamy starší než **90 dní** maže plánovač (stejný vzor jako ostatní `purge*` v `server/scheduler/start.ts`) **[volba]**. Tlačítko „Smazat log“ ve webu **[volba]**.
- **MCP-065** Log patří k účtu: maže se se smazáním uživatele (cascade). V záloze účtu není **[volba]** (je to provozní záznam s krátkou životností).
- **MCP-067** U odmítnutí kvůli úrovni se do `required_level` zapíše úroveň, která chyběla; u neplatného vstupu a chyb před ověřením úrovně je prázdná.
- **MCP-066** Rate limit (HTTP 429, MCP-032) se do logu nezapisuje, protože odmítnutí nastane před rozlišením nástroje **[volba]**.

## 5. Nástroje

Pravidla platná pro všechny nástroje:

- **MCP-070** Každý nástroj volá právě tu službu (nebo službu přesunutou z akce podle kap. 6), kterou volá odpovídající akce webu, se stejným vstupním schématem (Zod schéma služby nebo akce, viz inventura). Mutace dostávají `ctx.actor` (audit se zdrojem `mcp`), čtení `ctx.ownerId`.
- **MCP-071** Konvence v1 platí dál: anglické `snake_case` názvy, české popisy, částky na vstupu jako desetinné řetězce převedené stávajícími pomocníky (`parseMoney`, `parseQuantity`), ve výstupu formátované i strojové (`server/mcp/format.ts`), data `RRRR-MM-DD`, texty z dokladů ohraničené `quoted()` (MCP-033), odkazy do webu absolutní. Kde webové schéma bere částky v nejmenších jednotkách, nástroj převede desetinný řetězec stávajícím pomocníkem; jiné převody nevznikají.
- **MCP-072** Optimistická souběžnost: nástroje měnící fakturu nebo platbu přijímají `revision` stejně jako web. `get_invoice` proto nově vrací `revision`, ID plateb, ID verzí a ID záznamů pošty. Chyba „zastaralé“ vrací text s radou znovu načíst fakturu.
- **MCP-073** Chyby služeb se mapují jako v1 (`toolErrorResult`). `NotIssuableError` vrátí výčet problémů v textu i ve `structuredContent`.
- **MCP-074** Izolace účtů: cizí ID se chová jako neexistující (jako MCP-022), u všech nástrojů.
- **MCP-075** Stránkování a limity velikosti výstupu převzaté ze služeb; tam, kde služba limit nemá, nástroj omezí stránku na nejvýš 50 položek **[volba]**.

Tabulky níže jsou závazný seznam. Odkazy na služby a vstupní schémata jsou v inventuře (sekce v závorce).

### 5.1 Úroveň 1 – Jen čtení

| Nástroj | Služba | Pozn. |
|---|---|---|
| `get_overview`, `list_unpaid_invoices`, `search_customers`, `search_catalog` | stávající | beze změny |
| `get_invoice` | stávající | doplnit `revision`, ID plateb, verzí, pošty, `relatedDocuments` (MCP-072) |
| `list_invoices` | `listInvoices` + `parseInvoiceFilter` | (inv. 1) |
| `list_invoice_versions`, `get_invoice_version` | `listVersions`, `getVersion` | (1) |
| `list_invoice_mail_log` | `listEmailLog`, `mailStateOf` | (1) |
| `list_reminder_history` | `reminderHistory` | (1) |
| `check_invoice_issuable` | `checkIssuable` | (1) |
| `preview_issue` | `previewIssue` | ukáže číslo, nespotřebuje ho |
| `prepare_invoice_email`, `prepare_payment_receipt`, `prepare_reminder` | `sendPrefill`, `reminderPrefill` | předvyplněný e-mail pro odeslání (2) |
| `list_tags` | `listTags` | (1) |
| `list_customers`, `get_customer` | `listCustomers`, `getCustomer`, `customerInvoiceStats` | (3) |
| `lookup_company_ares` | služba z kap. 6 (rate limit + `lookupAres`) | (3) |
| `list_catalog`, `get_catalog_item`, `list_catalog_categories`, `list_units` | catalog.ts | (4) |
| `list_bank_notices`, `get_bank_status`, `list_notice_candidates` | bank-notices.ts | (6) |
| `list_bank_accounts` | `listBankAccounts` | (6) |
| `list_recurring`, `get_recurring`, `list_recurring_runs`, `list_plan_invoices`, `preview_recurring` | recurring.ts | (7) |
| `list_invoice_templates`, `get_invoice_template` | invoice-templates.ts | (8) |
| `list_number_series` | `listSeries`, `peekNumber` | (9) |
| `get_supplier`, `get_preferences`, `get_automation`, `list_reminder_rules`, `list_email_templates`, `get_email_template` | (10) | bez klíčů vzhledu |
| `get_report`, `get_tax_overview` | `reportBundle`, `taxOverview` (přímo, ne přes cache) | (11) |
| `quick_search` | služba z kap. 6 (min. délka + rate limit + `searchAll`) | (12) |
| `list_audit`, `get_entity_history` | `listAudit`, `entityHistory` | bez ip/userAgent/requestId (13) |
| `list_import_batches` | `listBatches` | (14), jen kvůli `undo_import` |
| `get_exchange_rate` | `loadRate` | zapisuje jen cache kurzu jako ve webu **[volba: úroveň 1]** |

### 5.2 Úroveň 2 – Koncepty

| Nástroj | Služba |
|---|---|
| `create_draft_invoice` | služba z kap. 6 (uložení konceptu se štítky a problémy vystavení); rozšířit o `tags`, výstup o `revision` a `problems` |
| `update_draft_invoice` | totéž, s `id` + `revision`; celé nahrazení dokumentu jako ve webu |
| `duplicate_invoice` | `duplicateInvoice` |
| `draft_from_template` | `draftFromTemplate` |
| `convert_advance_to_final` | služba z kap. 6 (`ensureDefaultSeries` + `convertAdvance`); vzniká koncept |
| `save_customer` (založit i upravit), `archive_customer`, `restore_customer`, `verify_customer_vat` | customers.ts |
| `save_catalog_item`, `archive_catalog_item`, `restore_catalog_item`, `save_unit` | catalog.ts |
| `save_line_to_catalog` | služba z kap. 6 (sestavení položky ceníku z řádku faktury) |

### 5.3 Úroveň 3 – Účetní operace

| Nástroj | Služba |
|---|---|
| `mark_sent`, `mark_sent_many` | invoice-lifecycle.ts (jen stav, nic se neposílá) |
| `snooze_reminders`, `set_reminders_off`, `set_partial_reminders` | reminders.ts |
| `add_payment`, `add_refund`, `update_payment`, `mark_paid`, `mark_paid_many` | payments.ts |
| `assign_notice`, `split_notice`, `dismiss_notice`, `restore_notice` | bank-notices.ts |
| `check_mailbox_now` | `checkMailboxNow` (použije uložené údaje, nemění je) |
| `save_bank_account`, `set_default_bank_account`, `hide_bank_account`, `unhide_bank_account` | bank-accounts.ts |
| `save_recurring` | `saveRecurring`; režim `draft` = 3, `issue` = 4; režim `send` neprojde bez potvrzení (2.2) |
| `pause_recurring`, `resolve_missed_run`, `recurring_from_template` | recurring*.ts |
| `save_invoice_as_template` | `templateFromInvoice` |
| `save_number_series`, `set_default_series` | number-series.ts |
| `save_supplier` | `saveSupplier` (bez obrázků) |
| `save_preferences` | `savePreferences` s patchem bez klíčů vzhledu (`designId`, barvy, `logoPosition`) |
| `set_automation` (jen `enabled: false`), `pause_automation` | automation.ts; zapnutí a obnovení vyžadují potvrzení, nejsou (5.7) |
| `set_send_time`, `set_daily_digest`, `set_period_summary`, `set_tax_reminder`, `set_limit_mail` | automation.ts (pošta jen vlastníkovi) |
| `save_reminder_rule`, `save_email_template`, `reset_email_template` | reminders.ts, email-templates.ts; reset přes službu z kap. 6 |

### 5.4 Úroveň 4 – Vystavování a odesílání

| Nástroj | Služba |
|---|---|
| `issue_invoice` | `issueInvoice` (`revision`, volitelný `variableSymbol`) |
| `send_invoice`, `resend_from_log` | invoice-mail.ts; `idempotency_key` → `requestId`; `confirmedUnknown` vždy `false` |
| `send_payment_receipt` | `sendReceipt` |
| `send_reminder` | `sendManualReminder`; `confirmedRepeat` vždy `false` |
| `save_recurring` s režimem `issue` nebo nad plánem v režimu `issue`/`send` (MCP-051), `resume_recurring` | recurring*.ts **[volba: obnovení vždy úroveň 4, plán může vystavovat sám]** |
| `set_next_number` | `setNextNumber` **[volba: úroveň 4, protože ovlivní číslování vystavovaných dokladů]** |

### 5.5 Úroveň 5 – Plný přístup

| Nástroj | Služba |
|---|---|
| `delete_draft` | `deleteDraft` |
| `update_issued_invoice`, `refresh_customer_snapshot`, `restore_invoice_version` | invoice-versions.ts (úprava vystavené faktury přes službu z kap. 6, se štítky) |
| `cancel_invoice`, `restore_cancelled_invoice` | invoice-lifecycle.ts |
| `create_credit_note` | služba z kap. 6 (`ensureDefaultSeries` + `createCreditNote`); vzniká koncept dobropisu |
| `delete_imported_invoice` | `deleteImported` |
| `delete_customer`, `delete_unit`, `delete_payment`, `delete_bank_account`, `delete_recurring`, `delete_invoice_template`, `delete_number_series`, `delete_reminder_rule` | příslušné služby |
| `undo_notice` | `undoNotice` (odstraní platbu) |
| `undo_import` | `undoBatch` |

### 5.6 Bez nástroje (služba nemá webového volajícího)

`saveTemplate`, `deleteTag`, samostatné `setInvoiceTags`. Štítky se nastavují přes uložení konceptu a úpravu vystavené faktury jako ve webu.

### 5.7 Bez nástroje kvůli potvrzení člověkem (varianta B)

`close_difference` (`closeDifference`), potvrzení neznámého doručení (`acknowledgeUnknown`: „only a person can tell whether the message arrived“), hromadné odeslání (`bulkSendPreview` + `bulkSend`: `previewed` je „what the person confirmed“), zapnutí automatizace (`setAutomation` s `enabled: true`), obnovení pozastavených automatizací (`setPaused(false)`), první uložení opakované faktury v režimu `send`. Asistent na dotaz odpoví, že to se dělá ve webu; popisy souvisejících nástrojů to uvádějí.

## 6. Logika přesunutá z akcí do služeb

Pravidlo: přesun beze změny chování. Webová akce po přesunu volá novou funkci služby a její stávající testy projdou bez úprav (kromě importů). Žádná nová doménová pravidla.

| Dnes v akci | Co se přesune |
|---|---|
| `saveDraftAction` (`faktury/actions.ts:188`) | `assertTagNames` → `ensureDefaultSeries` → `saveDraft` → `setInvoiceTags` → `checkIssuable` |
| `updateIssuedAction` (:214) | `assertTagNames` → `updateIssuedInvoice` → `setInvoiceTags` |
| `createCreditNoteAction` (:342), `convertAdvanceAction` (:351) | `ensureDefaultSeries` před službou |
| `saveLineToCatalogAction` (:224) | sestavení `CatalogInput` z řádku |
| `quickSearch` (`hledani-actions.ts:12`) | minimální délka dotazu a rate limit `searchUser` |
| `lookupAresAction` (`ares-actions.ts:14`) | rate limit `aresLookup` + `lookupAres` |
| `resetEmailTemplateAction` (`posta/sablony/actions.ts:45`) | načtení výchozího textu po resetu |

`revalidatePath` a další čistě webové kroky zůstávají v akcích.

## 7. Architektura (pro implementera)

- `src/lib/mcp-settings.ts`: typ `McpLevel`, pořadí úrovní, `logCalls`; odstranit `McpCapability` a `AVAILABLE_CAPABILITIES`.
- `src/server/mcp/tool.ts`: `ToolDef.level: McpLevel` (minimální) a volitelné `levelFor(ctx, input)` pro MCP-051; `admit()` porovnává úroveň; obal zapisuje log (MCP-061). Pořadí podle MCP-052.
- `src/server/mcp/server.ts`: `tools/list` filtrovaný podle úrovně, `instructions` podle MCP-053.
- Nástroje po doménách v `src/server/mcp/tools/*.ts` (např. `invoices.ts`, `sending.ts`, `customers.ts`, `catalog.ts`, `payments.ts`, `bank.ts`, `recurring.ts`, `templates.ts`, `series.ts`, `settings.ts`, `reports.ts`, `audit.ts`, `imports.ts`), registrace v `tools/index.ts`.
- Nová služba `src/server/services/mcp-call-log.ts` (zápis, výpis, purge) a schéma + migrace Drizzle.
- UI: `components/settings/assistants-form.tsx`, stránka `nastaveni/asistenti`, souhlasová stránka, texty v `lib/texts.ts`.
- Všechna místa, která dnes pracují se schopnostmi, jsou vyjmenovaná v inventuře, sekce 17.
- Dokumentace: README (sekce Asistenti) a nové ID MCP-050 až MCP-075 do hlavního návrhu kvůli `test:coverage-spec`.

## 8. Testování

- **Registr nástrojů:** test, že každý nástroj má úroveň; že sada nástrojů podle úrovně odpovídá kap. 5 (snapshot názvů); že žádné vstupní schéma nástroje neobsahuje potvrzovací příznak; že žádný nástroj nevolá služby ze 5.7.
- **Seznam nástrojů:** `tools/list` pro každou úroveň vrací přesně nástroje do té úrovně; vypnutý přístup vrací prázdný seznam; volání nástroje mimo seznam je odmítnuto (MCP-052).
- **Obal:** pro každou úroveň odmítnutí nástroje vyšší úrovně a povolení nástroje stejné úrovně; odvozená úroveň ze vstupu (`save_recurring`, `set_automation`); log se zapíše u `ok`, `denied`, `error`; při vypnutém logu se nezapíše nic; selhání zápisu logu nezmění výsledek; log neobsahuje argumenty.
- **Nástroje:** pro každý nástroj backend test šťastné cesty nad testovací databází, který ověří, že výsledek odpovídá volání stejné služby (stav databáze a audit se zdrojem `mcp`), a test cizího ID (MCP-074).
- **Přesuny z akcí:** stávající testy akcí projdou; pro nové funkce služeb test, který pokrývá všechny přesunuté kroky.
- **Migrace a záloha:** převod `can_*` → `level`; obnova staré zálohy; registr záloh.
- **E2E:** volba úrovně v Nastavení, přepínač logu, zobrazení logu, souhlasová stránka s úrovní.
- **Ruční:** připojení Claude Code proti lokální instanci, vyzkoušení nástroje na každé úrovni a odmítnutí nad ní; výsledek do PR.

## 9. Pořadí

1. Úrovně: model, migrace, záloha, obal, UI, souhlas (stávajících 6 nástrojů převedeno na úrovně).
2. Log volání: tabulka, zápis v obalu, přepínač, výpis v UI, purge.
3. Přesuny logiky z akcí do služeb (kap. 6).
4. Nástroje po úrovních: 1, 2, 3, 4, 5.
5. README, ID do hlavního návrhu, ruční ověření, PR.

## 10. Ponecháno na implementerovi

- Přesné výstupní schéma každého nástroje (rozumná podmnožina toho, co vrací služba, bez interních polí).
- Rozdělení nástrojů do souborů a sdílené pomocníky pro formátování výstupu.
- Rozvržení volby úrovně a logu v rámci stávajícího designu Nastavení.
- Textace popisů nástrojů (česky, včetně upozornění „dokončete ve webu“ u souvisejících operací ze 5.7).
