# Fakturan 3: Faktury, PDF a QR – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uživatel vytvoří fakturu z konceptu nebo šablony, vystaví ji s číslem z řady, stáhne PDF s QR platbou ve zvoleném designu a dál ji může opravovat s historií verzí.

**Architecture:** Výpočet částek je čistá funkce v `src/lib`, jediný zdroj všech součtů, klient je jen zobrazuje. Stav dokladu mění jen `src/server/services/invoices.ts` přes `mutate`. PDF vzniká z modelu `InvoiceView` přes `@react-pdf/renderer`, design je jeden soubor plus registrace a náhled i stažení jdou stejnou cestou.

**Tech Stack:** Next.js 16.4, Drizzle, better-sqlite3, Zod, `@react-pdf/renderer` 4, `sharp`, `qrcode`, Vitest, fast-check, Stryker, Playwright, dev: `pdfjs-dist`, `@napi-rs/canvas`, `jsqr`, `pixelmatch`.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`

## Global Constraints

- Příkazy `npm`/`npx` v tomto plánu znamenají `pnpm`/`pnpm exec`.
- Práce probíhá na `main`. Nic se nepushuje. Nic se v tomto plánu neposílá klientovi, odeslání e-mailem je plán 4.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů. Agent staguje jen své soubory.
- Komentáře jen pro neočividné invarianty, UI texty česky a v `src/lib/texts.ts`, jen tokeny barev.
- Název testu obsahuje ID požadavku, `tests/spec-pending.txt` se průběžně zmenšuje. ID, které tento plán splní jen zčásti, v seznamu zůstává.
- Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)` se záznamem `scope: 'user'` a `ownerId`. Mutace je synchronní, PDF ani jiná asynchronní práce v ní neběží.
- Každý dotaz na data účtu jde přes `scoped(ownerId)`. Každá nová tabulka s vlastníkem patří do `USER_OWNED_TABLES` a před tabulky, na které nekaskádově odkazuje. Každá entita má test `assertIsolated` včetně `update` a `remove`.
- Vstupy se validují na serveru sdíleným Zod schématem. Klient nikdy neposílá součty, číslo z řady ani stav.
- Peníze jako celé číslo v nejmenší jednotce, množství v tisícinách, procenta slevy v setinách procenta, kurz v milióntinách. Žádný `number` s desetinnou částí v doménové logice. Aktuální čas přes `clock`, obchodní data jako `CalendarDate`, „dnes“ přes `calendarDateInPrague`.
- Každý nový balíček s nativní částí nebo soubory čtenými za běhu musí fungovat ve standalone obraze. Docker je jediná build cesta.

## Review Focus

1. Dvě karty upravují stejný koncept, nebo autosave doběhne po vystavení: starší zápis se odmítne a nic se tiše nepřepíše (Task 3).
2. Dvě současná vystavení a ručně obsazené číslo v řadě: čísla jsou unikátní, obsazené se přeskočí a selhané vystavení nespotřebuje číslo (Task 4).
3. Položka s 2000 znaků popisu, slovo bez mezer přes celou šířku, 300 položek: nic nepřeteče, nezamrzne ani se neztratí řádek (Task 7).
4. Zaokrouhlení přes hranici a extrémní částky: součet položek a slev vždy sedí a částka mimo limit je odmítnutá, ne zkreslená (Task 2).
5. Dodavatel si po vystavení změní adresu, logo nebo účet, zákazník se přejmenuje: starý doklad vypadá stejně jako při vystavení (Task 4, Task 7).

---

### Task 1: Nástroje ověřování

**Files:**
- Create: `stryker.config.json`, `tests/helpers/consistency.ts`, `tests/helpers/pdf.ts`
- Modify: `package.json`, `.gitignore`, `.github/workflows/ci.yml`, `tests/e2e/fixtures.ts`
- Test: `tests/backend/consistency.test.ts`

**Interfaces:**
- Produces:
  - `assertConsistent(db: Db, ownerId: string): void`
  - `pdfText(pdf: Buffer): Promise<string[]>` (text po stranách)
  - `pdfPagePng(pdf: Buffer, page: number, scale?: number): Promise<Buffer>`
  - `decodeQr(png: Buffer): string | null`
  - `expectMatchesSnapshot(png: Buffer, name: string): void`, reference v `tests/pdf-snapshots/`, přepis přes `UPDATE_PDF_SNAPSHOTS=1`, práh 0,1 % pixelů
  - skript `test:mutation`

Spec: TST-008, TST-013, TST-015, TST-018. Stryker s Vitest runnerem mutuje `src/lib/money.ts`, `src/lib/number-format.ts`, `src/lib/invoice-totals.ts`, `src/lib/qr-payload.ts`, `thresholds.break` 90, v CI neběží. `assertConsistent` v tomto úkolu kontroluje audit a vazby na účet, po Task 4 přidá: uložené součty každého dokladu odpovídají `computeTotals` z jeho řádků, každý vystavený doklad má číslo a snapshoty, koncept číslo nemá, žádné číslo se neopakuje. Plány 5 a 6 ji rozšíří o platby. E2E fixture ji spouští na konci každého testu nad `dataDir`.

- [ ] **Step 1: Napiš test** `[TST-018] kontrola souladu odhalí ručně poškozený řádek`, který do dat vloží rozpor a čeká výjimku, a `[TST-018] prochází na čistém účtu`.
- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/consistency.test.ts`, čekej FAIL, modul neexistuje.
- [ ] **Step 3: Nainstaluj** `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `pdfjs-dist`, `@napi-rs/canvas`, `jsqr`, `pixelmatch`, `pngjs` jako dev závislosti a implementuj rozhraní výše. `npm install` spusť v `node:24-bookworm-slim`, aby lockfile prošel `npm ci` v obrazu.
- [ ] **Step 4: Ověř:** `npm test`, PASS, `npm run test:mutation` doběhne nad dosavadními moduly a skóre nižší než 90 % u `money.ts` a `number-format.ts` oprav testy.
- [ ] **Step 5: Commit** `test: add consistency check, pdf helpers and mutation testing`

---

### Task 2: Výpočet částek

**Files:**
- Create: `src/lib/invoice-totals.ts`
- Modify: `src/lib/money.ts`
- Test: `tests/unit/invoice-totals.test.ts`, `tests/unit/invoice-totals.property.test.ts`, `tests/unit/invoice-examples.test.ts`

**Interfaces:**
- Produces:
  - `type Discount = { kind: 'none' } | { kind: 'percent'; basisPoints: number } | { kind: 'amount'; minor: number }`
  - `type TotalsLine = { quantityMilli: number; unitPriceMinor: number; discount: Discount }`
  - `type RoundingMode = 'none' | 'whole'`
  - `type Totals = { lines: { grossMinor: number; discountMinor: number; netMinor: number }[]; subtotalMinor: number; discountMinor: number; roundingMinor: number; totalMinor: number }`
  - `computeTotals(lines: TotalsLine[], discount: Discount, rounding: RoundingMode): Totals`, vyhodí `AmountOutOfRangeError`
  - `parseQuantity(input: string): number | null`, `formatQuantity(milli: number): string`
  - `MAX_DOCUMENT_MINOR = 99_999_999_999`, `MAX_QUANTITY_MILLI = 9_999_999_999`

Spec: INV-012, INV-014, INV-015, ARC-002, TST-012, TST-014. Pořadí: řádek hrubě = `množství × cena / 1000`, sleva řádku, součet, sleva dokladu, zaokrouhlení. Mezivýpočty přes `BigInt`, zaokrouhlení půl od nuly. Sleva je omezená na základ, výsledek není záporný. Rozdíl zaokrouhlení je uložená hodnota, ne dopočet v PDF. Limit platí pro každý mezisoučet (přenos z plánu 2: `MAX_PRICE_MINOR × množství`).

- [ ] **Step 1: Napiš testy**

```ts
test('[INV-012] 1,5 hod. × 1 234,56 Kč = 1 851,84 Kč', ...)
test('[INV-012] 0,333 ks × 0,10 Kč zaokrouhlí půl od nuly', ...)
test('[INV-014] 10 % z 999,99 Kč po slevě řádku 5 % sedí na haléř', ...)
test('[INV-015] 100,50 Kč na koruny dá 101 Kč a rozdíl 0,50 Kč', ...)
test('[INV-015] 100,49 Kč na koruny dá 100 Kč a rozdíl -0,49 Kč', ...)
test('[INV-012] cena za 1e12 Kč × 9 999 999,999 je odmítnutá AmountOutOfRangeError', ...)
test('[TST-012] total = Σ net − sleva dokladu + zaokrouhlení pro libovolné vstupy', ...)
test('[TST-012] sleva nikdy nedá záporný řádek ani doklad', ...)
test('[TST-014] vzorová faktura č. N', ...) // aspoň 10 ručně spočítaných dokladů v tabulce
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/unit/invoice`, FAIL.
- [ ] **Step 3: Implementuj** rozhraní výše.
- [ ] **Step 4: Ověř:** `npx vitest run tests/unit/invoice`, PASS, a `npm run test:mutation` má u `invoice-totals.ts` aspoň 90 %.
- [ ] **Step 5: Commit** `feat(invoices): add invoice totals calculation`

---

### Task 3: Koncepty, štítky a přenosy z evidence

**Files:**
- Create: `src/server/db/schema/invoice.ts`, `drizzle/0015_invoice.sql`, `src/lib/invoice.ts`, `src/server/services/invoices.ts`, `src/server/services/tags.ts`
- Modify: `src/server/db/schema/index.ts`, `src/server/services/users.ts`, `src/server/services/bank-accounts.ts`, `src/server/services/customers.ts`, `src/server/services/number-series.ts`, `src/server/services/preferences.ts`, `src/server/db/schema/settings.ts`, `src/lib/preferences.ts`, `src/lib/texts.ts`
- Test: `tests/backend/invoices.test.ts`, `tests/backend/invoices-isolation.test.ts`

**Interfaces:**
- Consumes: `computeTotals`, `customerDefaults`, `getPreferences`, `defaultAccountFor`, `defaultSeriesFor`
- Produces:
  - `INVOICE_STATUSES = ['draft','issued','sent','partially_paid','paid','cancelled','credited']`, `INVOICE_TYPES = DOCUMENT_TYPES`
  - `type Appearance = { designId; colors: { accent; surface; text; line }; logoPosition: 'left'|'right'|'none'; showLogo; showQr; showQrLogo; showSignature; showDuzp }`
  - `saveDraft(actor, raw: DraftInput): { id: string; revision: number; totals: Totals }`, kde `DraftInput` nese `id?` a `revision?`
  - `deleteDraft(actor, id)`, `duplicateInvoice(actor, id): { id }`
  - `getInvoice(ownerId, id): InvoiceDetail | null` (faktura, řádky, štítky)
  - `newDraftDefaults(ownerId, customerId: string | null): DraftInput`
  - `isOverdue(row, today: CalendarDate): boolean`
  - `setInvoiceTags(actor, id, names: string[])`, `listTags(ownerId)`, `deleteTag(actor, id)`

Datový model:

| Tabulka | Sloupce |
|---|---|
| `invoice` | `id`, `user_id`, `type`, `status`, `cancelled_from`, `number`, `variable_symbol`, `variable_symbol_manual`, `series_id`, `customer_id`, `customer_name`, `bank_account_id`, `issue_date`, `due_date`, `taxable_date`, `language`, `currency`, `exchange_rate_micros`, `payment_method`, `order_ref`, `reference`, `text_before`, `text_after`, `note`, `discount_kind`, `discount_value`, `rounding`, `subtotal_minor`, `discount_minor`, `rounding_minor`, `total_minor`, `paid_minor`, `appearance` (JSON), `supplier_snapshot`, `customer_snapshot`, `account_snapshot` (JSON), `logo_file_id`, `qr_logo_file_id`, `signature_file_id`, `related_invoice_id`, `external`, `search_text`, `revision`, `issued_at`, `sent_at`, `created_at`, `updated_at` |
| `invoice_line` | `id`, `invoice_id` (cascade), `user_id`, `position`, `catalog_item_id` (set null), `name`, `description`, `quantity_milli`, `unit`, `unit_price_minor`, `discount_kind`, `discount_value`, `net_minor` |
| `tag`, `invoice_tag` | `tag(id, user_id, name, name_key)` s unikátním `(user_id, name_key)`, `invoice_tag(invoice_id, tag_id, user_id)` |

Indexy: unikátní částečný `(user_id, number) WHERE number IS NOT NULL`, `(user_id, status)`, `(user_id, issue_date)`, `(user_id, customer_id)`. `customer_id`, `bank_account_id` a `related_invoice_id` jsou bez kaskády a `invoice` je v `USER_OWNED_TABLES` před tabulkami, na které odkazuje. `series_id` je `set null`, protože řadu s přiděleným číslem chrání počítadlo a koncept si řadu při vystavení dosadí znovu. Sloupce `paid_minor`, `external` a `related_invoice_id` zatím jen nesou výchozí hodnotu pro plány 5, 6 a 8.

Pravidla:
- Koncept je shovívavý: smí mít prázdné položky i bez zákazníka. Přísná kontrola je až při vystavení. Součty přepočítá vždy server.
- `revision` se při každém uložení zvýší. Uložení se starší `revision` nebo nad nekonceptem vrátí `ServiceError(TEXTS.invoices.stale)`. Autosave beze změny neprojde do auditu: stejná technika jako `AlreadyOnboarded`.
- Limity: 500 položek, název 200, popis 2000, poznámky 2000, 20 štítků, štítek 40 znaků. Cena nejvýš dvě desetinná místa plyne z typu v nejmenší jednotce, formulář používá `parseMoney`.
- `Preferences` získá `surfaceColor`, `textColor`, `lineColor`, `logoPosition`, `rounding`, `pdfFileName` (výchozí `{cislo}.pdf`), `fxBasis` (`issue_date`|`taxable_date`, pro plán 6). `Appearance` se do konceptu zkopíruje z výchozích hodnot, takže změna nastavení staré doklady nemění.
- Štítky jsou organizační údaj: mění se i na vystaveném dokladu, nevytvářejí verzi a nevyžadují opětovné odeslání. Štítek se založí při prvním použití, `name_key` je `foldText`.
- Přenosy: `isAccountUsed` a `deleteCustomer` čtou faktury (SET-022, CUS-007), `isNumberTaken` čte `invoice`.

- [ ] **Step 1: Napiš testy**

```ts
test('[INV-001] koncept nemá číslo a nezapočítá se do souhrnu', ...)
test('[INV-002] koncept jde smazat', ...)
test('[INV-010] nová faktura převezme splatnost, jazyk, měnu a design z výjimky zákazníka', ...)
test('[INV-012] klientem podstrčený total se ignoruje', ...)
test('[INV-017] uložení bez změny nepřidá auditní záznam', ...)
test('[INV-017] uložení se starší revizí je odmítnuté a data zůstanou', ...)
test('[INV-018] duplikát je koncept s dnešními daty, bez čísla a se stejnými položkami', ...)
test('[INV-026] štítek se založí při prvním použití a „Práce“ a „prace“ je tentýž', ...)
test('[SET-022] použitý účet nejde smazat, jen skrýt', ...)
test('[CUS-007] zákazník s dokladem nejde smazat', ...)
test('[TST-009] izolace faktury, řádků a štítků včetně update a remove', ...) // assertIsolated
test('[ADM-006] smazání účtu s fakturami nezanechá řádky', ...)
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/invoices`, FAIL.
- [ ] **Step 3: Implementuj schéma a vygeneruj migraci** `npx drizzle-kit generate`, pojmenuj ji `0015_invoice`.
- [ ] **Step 4: Implementuj služby** podle rozhraní a pravidel.
- [ ] **Step 5: Ověř:** `npm test`, PASS, včetně strukturálního testu `USER_OWNED_TABLES`.
- [ ] **Step 6: Commit** `feat(invoices): add drafts, tags and invoice schema`

---

### Task 4: Vystavení a životní cyklus

**Files:**
- Modify: `src/server/services/invoices.ts`, `src/server/services/number-series.ts`, `src/lib/invoice.ts`, `src/lib/texts.ts`, `tests/helpers/consistency.ts`
- Create: `src/lib/template-vars.ts`
- Test: `tests/backend/invoices-issue.test.ts`, `tests/unit/template-vars.test.ts`

**Interfaces:**
- Consumes: `allocateNumber`, `isNumberTaken`, `missingSupplierFields`, `variableSymbolFrom`
- Produces:
  - `checkIssuable(ownerId, id): IssueProblem[]`, `type IssueProblem = { field: string; message: string }`
  - `issueInvoice(actor, id, opts: { revision: number; seriesId?: string; variableSymbol?: string }): { id: string; number: string }`
  - `cancelInvoice(actor, id)`, `restoreInvoice(actor, id)`, `markSent(actor, id)`
  - `renderVariables(text: string, ctx: VariableContext): string`, `validateVariables(text: string): string[]`, `VARIABLE_NAMES`
  - `type InvoiceSnapshot = { supplier; customer; account }`, `invoiceDocument(row)`: typovaný přístup k JSON

Spec: INV-001 až 005, INV-040, NUM-003, NUM-005, NUM-007, SET-002, FOR-005, CUS-008, TPL-004. V jedné transakci: kontrola, přidělení čísla, VS, snapshoty dodavatele, zákazníka a účtu, ID obrázků, dosazení proměnných a uložené součty.

Pravidla:
- `checkIssuable` požaduje: údaje dodavatele (SET-002), zákazníka, aspoň jednu položku s názvem, množství nad nulou, cenu aspoň 0, splatnost ne před vystavením, u převodu účet ve měně faktury (FOR-005), u cizí měny kurz. Kurz se v tomto plánu zadává ručně, automatika ČNB je plán 6.
- Přidělení čísla v `allocateNumber` přeskakuje ruční obsazená čísla v cyklu nad `isNumberTaken`. Selhání kdekoli vrátí celou transakci, počítadlo se neposune.
- `seriesId` musí patřit účtu a typu dokladu. Bez něj se bere `series_id` konceptu, jinak `defaultSeriesFor`.
- VS se odvodí podle `variableSymbolFormat`. Ruční VS: jen číslice, nejvýš 10, nastaví `variable_symbol_manual`.
- Proměnné jsou v konceptu doslova a dosazují se při vystavení a v náhledu, jedním průchodem, takže hodnota obsahující `{{` se dál nerozvine. Období je kalendářní měsíc data vystavení, plán 4 ho přepíše podle plánu. Neznámé proměnné v běžné faktuře zůstanou jako text, chyba jsou jen v šabloně.
- Storno uloží `cancelled_from`, `restoreInvoice` stav vrátí. Číslo zůstává obsazené. Stornovat jde `issued` a `sent`, doklad s platbami až po plánu 5 odmítne.
- `supplier.setSupplierImage` a `clearSupplierImage` nesmažou soubor odkazovaný vystaveným dokladem (přes `logo_file_id` a sousedy), jen zruší vazbu v profilu.
- `recordCatalogUse` proběhne při vystavení. Změna ceny v ceníku se doklad netýká, řádek drží kopii.

- [ ] **Step 1: Napiš testy**

```ts
test('[INV-001] vystavení přidělí číslo z řady', ...)
test('[SET-002] bez IČO nejde vystavit a problém pojmenuje pole', ...)
test('[FOR-005] převod bez účtu v EUR je odmítnutý s vysvětlením', ...)
test('[NUM-003] faktura použije zvolenou řadu, cizí řada je odmítnutá', ...)
test('[NUM-005] 20 souběžných vystavení dá 20 různých čísel', ...) // přes allocate-worker
test('[NUM-005] ručně obsazené 2026-002 se přeskočí', ...)
test('[NUM-005] odmítnuté vystavení nespotřebuje číslo', ...)
test('[NUM-007] VS 2026040 z čísla 2026-040, ruční VS s písmeny je odmítnutý', ...)
test('[CAT-003] změna ceny v ceníku nemění vystavený doklad', ...)
test('[CUS-008] přejmenování zákazníka nezmění vystavený doklad', ...)
test('[INV-002] vystavenou fakturu nejde smazat', ...)
test('[INV-003] storno a jeho vrácení obnoví předchozí stav a číslo', ...)
test('[INV-005] označení jako odeslaná nastaví stav bez e-mailu', ...)
test('[TPL-004] {{rok}} a {{cislo_faktury}} se dosadí při vystavení', ...)
test('[SEC-011] hodnota zákazníka {{rok}} se nerozvine', ...)
test('[TST-018] uložené součty odpovídají položkám po vystavení', ...)
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/invoices-issue.test.ts tests/unit/template-vars.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** rozhraní a pravidla, doplň `assertConsistent` o kontroly z Task 1.
- [ ] **Step 4: Ověř:** `npm test`, PASS.
- [ ] **Step 5: Commit** `feat(invoices): add issuing and invoice lifecycle`

---

### Task 5: Úprava vystaveného dokladu a verze

**Files:**
- Create: `src/server/db/schema/invoice-version.ts`, `drizzle/0016_invoice_version.sql`, `src/server/services/invoice-versions.ts`, `src/lib/invoice-diff.ts`
- Modify: `src/server/services/invoices.ts`, `src/server/services/users.ts`
- Test: `tests/backend/invoice-versions.test.ts`

**Interfaces:**
- Produces:
  - `updateIssuedInvoice(actor, id, raw: IssuedInput): { revision: number; resendSuggested: boolean; balanceWarning: 'none'|'overpaid'|'underpaid' }`
  - `refreshCustomerSnapshot(actor, id)`
  - `listVersions(ownerId, invoiceId)`, `getVersion(ownerId, versionId)`, `restoreVersion(actor, versionId)`
  - `diffInvoices(a: InvoiceDocument, b: InvoiceDocument): InvoiceChange[]`

Spec: INV-020 až 023, CUS-008. `invoice_version(id, invoice_id, user_id, version_no, document JSON, created_at)`, unikátní `(invoice_id, version_no)`. Stav před každou změnou se zapíše jako verze ve stejné transakci. Obnovení je nová změna, historii nepřepisuje. Změna čísla kontroluje `isNumberTaken` kromě sebe sama a VS ji následuje jen bez `variable_symbol_manual`. Změna data nikdy nepřidělí nové číslo. `resendSuggested` je `true` pro stav `sent`, nikdy se nic neodešle. Úprava `cancelled` je odmítnutá. `balanceWarning` a návrat stavu podle plateb se počítají z `paid_minor`, stavový přechod přidá plán 5, ID INV-023 zůstává v pending.

- [ ] **Step 1: Napiš testy**

```ts
test('[INV-020] úprava odeslané faktury nabídne opětovné odeslání a nic neodešle', ...)
test('[INV-021] každá změna vytvoří verzi a stará jde obnovit', ...)
test('[INV-021] rozdíl verzí ukáže změněnou položku a částku', ...)
test('[INV-022] obsazené číslo je odmítnuté, stejné číslo téhož dokladu projde', ...)
test('[CUS-008] obnovení údajů zákazníka je jediná cesta a vytvoří verzi', ...)
test('[TST-009] izolace verzí', ...)
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/invoice-versions.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci, služby.
- [ ] **Step 4: Ověř:** `npm test`, PASS.
- [ ] **Step 5: Commit** `feat(invoices): add versioned edits of issued invoices`

---

### Task 6: QR platba

**Files:**
- Create: `src/lib/qr-payload.ts`, `src/server/pdf/qr.ts`
- Test: `tests/unit/qr-payload.test.ts`, `tests/backend/qr.test.ts`

**Interfaces:**
- Produces:
  - `type QrPlan = { kind: 'spayd' | 'epc'; payload: string } | { kind: 'none'; reason: QrReason }`
  - `QrReason = 'disabled' | 'paid' | 'zero' | 'currency' | 'not_czech_account' | 'missing_iban_bic'`
  - `planQr(input: { currency; dueMinor: number; iban; bic; variableSymbol; message; recipient; enabled: boolean; paid: boolean }): QrPlan`
  - `amountDue(row: { totalMinor; paidMinor }): number`
  - `qrPng(payload: string, logo: Buffer | null): Promise<Buffer>`

Spec: QR-001 až 006. SPAYD: `SPD*1.0*ACC:<IBAN>*AM:<0.00>*CC:CZK*X-VS:<VS>*MSG:<text>*`, `MSG` bez diakritiky a nejvýš 60 znaků, `*` a `%` se kódují procentem, prázdné atributy se vynechají. EPC: `BCD`, `002`, `1`, `SCT`, BIC, příjemce do 70 znaků, IBAN, `EUR<0.00>`, dva prázdné řádky, zpráva do 140 znaků `VS<vs>`, oddělovač `\n`. Částka je `amountDue`, částečná úhrada ji sníží (QR-006). `qrcode` s korekcí H, 1024 px. Logo přes `sharp`, bílý podklad, strana nejvýš 20 % strany kódu.

- [ ] **Step 1: Napiš testy**

```ts
test('[QR-001] CZK na český účet dá přesně očekávaný řetězec SPAYD', ...)
test('[QR-001] diakritika a hvězdička ve zprávě', ...)
test('[QR-002] EUR s IBAN a BIC dá EPC', ...)
test('[QR-002] EUR bez BIC nedá QR s důvodem', ...)
test('[QR-003] USD nedá QR', ...)
test('[QR-005] uhrazená a vypnutá faktura nedá QR', ...)
test('[QR-006] částka je zbývající, ne celková', ...)
test('[QR-004] kód s logem se dekóduje na stejný obsah', ...) // decodeQr, všechny tvary loga
test('[TST-015] dekódovaný QR souhlasí s fakturou', ...)
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/unit/qr-payload.test.ts tests/backend/qr.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.** Přidej závislosti `qrcode` a `sharp` v `node:24-bookworm-slim`.
- [ ] **Step 4: Ověř:** PASS, `npm run test:mutation` u `qr-payload.ts` aspoň 90 %.
- [ ] **Step 5: Commit** `feat(pdf): add spayd and epc qr payments`

---

### Task 7: PDF jádro a první design

**Files:**
- Create: `src/server/pdf/render.ts`, `src/server/pdf/view.ts`, `src/server/pdf/assets.ts`, `src/server/pdf/fonts.ts`, `src/server/pdf/fonts/*`, `src/server/pdf/labels.ts`, `src/server/pdf/designs/index.ts`, `src/server/pdf/designs/types.ts`, `src/server/pdf/designs/cisty.tsx`, `src/server/pdf/parts.tsx`, `src/server/services/invoice-pdf.ts`, `src/app/(app)/faktury/[id]/pdf/route.ts`, `src/app/(app)/faktury/[id]/nahled/route.ts`, `tests/e2e/docker-pdf.spec.ts`, `tests/fixtures/invoices.ts`
- Modify: `next.config.ts`, `Dockerfile`, `.github/workflows/ci.yml`, `src/server/rate-limit.ts`, `src/lib/texts.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/security-headers.spec.ts`
- Test: `tests/backend/pdf.test.ts`

**Interfaces:**
- Consumes: `planQr`, `qrPng`, `invoiceDocument`, `renderVariables`
- Produces:
  - `type InvoiceView`: hotové formátované řetězce, barvy, obrázky jako `Buffer`, `labels`
  - `buildInvoiceView(doc: InvoiceDocument, opts: { today; draft: boolean }): Promise<InvoiceView>`
  - `renderInvoicePdf(view: InvoiceView): Promise<Buffer>`
  - `invoicePdf(ownerId, id): Promise<{ data: Buffer; fileName: string }>`
  - `type InvoiceDesign = { id: string; name: string; tokens: DesignTokens; Page: ComponentType<{ view: InvoiceView }> }`
  - `DESIGNS`, `isDesignId(id)`, `getDesign(id)`, který pro neznámé ID vrátí `cisty`
  - `parts.tsx`: `<LinesTable>`, `<Parties>`, `<Totals>`, `<PaymentBox>`, `<PageNumber>`, parametrizované tokeny
  - `fileNameFor(template, doc): string`
  - `RATE_RULES.pdfUser = rule('pdfUser', 120, 60)`

Spec: PDF-001, 005, 006, 008, 009, 010, INV-040 až 042, SEC-011, UI-004, AUD-002.

Pravidla:
- `@react-pdf/renderer` do `serverExternalPackages`, fonty a jeho běhové soubory do `outputFileTracingIncludes`. `sharp` a `@img` do runner stage stejně jako `better-sqlite3`.
- `react-pdf` neumí WebP ani SVG, proto `assets.ts` převádí každý obrázek přes `sharp` na PNG, šířka nejvýš 800 px. `sharp` smí načíst jen už uložený sanitizovaný soubor.
- Fonty: statické TTF s licencí OFL, v repozitáři i s licencí, Inter (sans), Source Serif 4 (serif), JetBrains Mono (mono), řezy regular a bold. Musí pokrývat `ř ů ě ł £ €    `.
- `Font.registerHyphenationCallback` vypne anglické dělení. Slovo delší než 30 znaků se rozdělí znak po znaku, aby nepřeteklo.
- Řádek tabulky má `wrap={false}` jen do 600 znaků popisu, delší se smí zalomit. Záhlaví tabulky a „Strana X z Y“ jsou `fixed`.
- Render běží v pořadí za sebou přes frontu v `render.ts`, aby souběžné náhledy neblokovaly server.
- `view.ts` čte vystavený doklad ze snapshotů a logo z `logo_file_id`, koncept z aktuálních dat. Koncept nese vodoznak „Koncept“, číslo prázdné. Popisky jsou v `labels.ts` pro cs a en, nejsou v `TEXTS`, protože patří dokumentu, ne rozhraní.
- Uživatelský vstup je v PDF vždy jen obsah elementu `<Text>`, nikdy se neinterpretuje.
- Route vrací `Content-Disposition` s `filename*`, `nosniff`, kontrolu vlastníka přes `readOwned` vzor, cizí 404, rate limit `pdfUser`. Stažení vystaveného dokladu zapíše audit `invoice.pdf_download`. V globální CSP se změní `frame-ancestors 'none'` na `'self'`, aby šel náhled v iframe.
- Fixture dokumenty pro testy: krátká, dlouhá (300 položek), EUR, angličtina, bez loga, dlouhé názvy.

- [ ] **Step 1: Napiš testy**

```ts
test('[PDF-001] náhled a stažení dají stejný text', ...)
test('[PDF-005] 300 položek: všechny řádky jsou v PDF, záhlaví na každé straně, Strana X z Y', ...)
test('[PDF-005] popis 2000 znaků a slovo 200 znaků bez mezer: text je celý v PDF', ...)
test('[PDF-006] české znaky i zł a € přežijí extrakcí textu', ...)
test('[PDF-009] šablona {cislo}-{zakaznik}.pdf s lomítkem a uvozovkou dá bezpečný název', ...)
test('[INV-040] vystavený doklad obsahuje všechny povinné údaje', ...)
test('[INV-042] patička nemá značku aplikace', ...)
test('[SEC-011] název <b>{{rok}}</b> je v PDF doslova', ...)
test('[CUS-008] změna adresy dodavatele a výměna loga nezmění PDF vystaveného dokladu', ...)
test('[SEC-001] cizí uživatel dostane na PDF i náhled 404', ...)
test('[PDF-001] standalone obraz vyrenderuje PDF s logem SVG', ...) // docker-pdf.spec.ts
```

`tests/e2e/docker-pdf.spec.ts` běží jen s `E2E_DOCKER_IMAGE`: založí účet přes UI, vyplní dodavatele, nahraje logo SVG, vystaví doklad přes formulář a stáhne PDF z kontejneru. Běží až po Task 9, do té doby ji Step 5 ověřuje skriptem, který v kontejneru zavolá `renderInvoicePdf` nad fixture. CI nastaví proměnnou po `docker build`.

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/pdf.test.ts`, FAIL.
- [ ] **Step 3: Implementuj render a `cisty`** podle rozhraní. Zkus nejdřív jeden dokument s českým textem, teprve pak tabulku.
- [ ] **Step 4: Ověř:** `npm test`, PASS.
- [ ] **Step 5: Ověř obraz:** `docker build -t fakturan-ci .` a v kontejneru spusť `node scripts/pdf-smoke.mjs`, který vyrenderuje fixture s logem SVG a skončí kódem 0. Plný test `E2E_DOCKER_IMAGE=fakturan-ci npx playwright test docker-pdf` se zapne v Task 9.
- [ ] **Step 6: Commit** `feat(pdf): render invoices with first design`

---

### Task 8: Dalších 11 designů, barvy a výběr

**Files:**
- Create: `src/server/pdf/designs/{editorial,barevny-pas,tabulkovy,blok,minimal,mono,klasik,geometric,kontrast,bocni-pruh,kompaktni}.tsx`, `src/lib/contrast.ts`, `src/app/(app)/nastaveni/designy/{page,actions}.tsx`, `src/app/(app)/nastaveni/designy/nahled/route.ts`, `src/components/settings/design-picker.tsx`, `tests/pdf-snapshots/*`
- Modify: `src/server/pdf/designs/index.ts`, `src/components/settings-tabs.tsx`, `src/server/services/preferences.ts`, `src/server/services/customers.ts`, `src/lib/texts.ts`
- Test: `tests/backend/pdf-designs.test.ts`, `tests/unit/contrast.test.ts`, `tests/e2e/designs.spec.ts`

**Interfaces:**
- Consumes: `InvoiceDesign`, `parts.tsx`, `expectMatchesSnapshot`
- Produces: `contrastRatio(a: string, b: string): number`, `readableOn(background: string): string`, `samplePreviewDocument(ownerId): InvoiceDocument`

Spec: PDF-002, 003, 004, 007, 008, UI-004, TST-008, TST-014. Přidání designu smí změnit jen vlastní soubor a jeden řádek v `designs/index.ts`, UI seznam čte `DESIGNS`. Barvy jdou výběrem i hexem, kontrast textu pod 4,5:1 ukáže varování a uložení nezablokuje, text na akcentu si barvu vybírá `readableOn`. Výběr v nastavení je seznam designů a jeden živý náhled v iframe, ne dvanáct PDF najednou. Náhled použije poslední vystavený doklad, jinak ukázková data s údaji uživatele. `designId` v preferencích a u zákazníka se ověřuje přes `isDesignId` (přenos z plánu 2). Referenční PNG schvaluje člověk před commitem, proto Step 4.

- [ ] **Step 1: Napiš testy**

```ts
test.each(designs × fixtures)('[PDF-007] %s / %s odpovídá referenci', ...)
test.each(designs)('[PDF-003] %s vykreslí vlastní barvy, logo vlevo, vpravo i bez a QR', ...)
test.each(designs)('[TST-015] %s: QR v PDF se dekóduje', ...)
test('[PDF-002] registr má aspoň 12 designů s unikátním ID', ...)
test('[PDF-008] designs/index.ts nepotřebuje jiný seznam než DESIGNS', ...)
test('[PDF-003] kontrast černé na bílé je 21, nízký kontrast varuje', ...)
test('[PDF-004] výběr designu změní náhled a uloží se', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/pdf-designs.test.ts`, FAIL.
- [ ] **Step 3: Implementuj designy a výběr.** Designy jsou nezávislé a smí běžet paralelně.
- [ ] **Step 4: Vygeneruj reference** přes `UPDATE_PDF_SNAPSHOTS=1`, prohlédni každý design a oprav přetečení a kolize. Implementer přiloží cestu ke kontaktní mřížce všech designů pro kontrolu.
- [ ] **Step 5: Ověř:** `npm test` a `npx playwright test designs`, PASS.
- [ ] **Step 6: Commit** `feat(pdf): add invoice designs and design picker`

---

### Task 9: Formulář faktury

**Files:**
- Create: `src/app/(app)/faktury/nova/page.tsx`, `src/app/(app)/faktury/[id]/upravit/page.tsx`, `src/app/(app)/faktury/actions.ts`, `src/components/invoices/invoice-form.tsx`, `src/components/invoices/line-editor.tsx`, `src/components/invoices/customer-picker.tsx`, `src/components/invoices/catalog-picker.tsx`, `src/components/invoices/tag-input.tsx`, `src/components/invoices/pdf-preview.tsx`, `src/components/invoices/issue-dialog.tsx`
- Modify: `src/lib/texts.ts`, `src/lib/audit-labels.ts`
- Test: `tests/e2e/invoice-form.spec.ts`, `tests/backend/invoice-actions.test.ts`

**Interfaces:**
- Consumes: `saveDraft`, `newDraftDefaults`, `checkIssuable`, `issueInvoice`, `updateIssuedInvoice`, `searchCustomers`, `searchCatalog`, `saveCustomer`, `saveCatalogItem`
- Produces: actions `saveDraftAction`, `issueAction`, `updateIssuedAction`, `saveLineToCatalogAction`

Spec: INV-010 až 019, INV-025, INV-026, NUM-003, NUM-007, FOR-002, UI-009. Po vystavení se zobrazí detail s nabídkou „Odeslat klientovi“. Tlačítko oživí plán 4, do té doby ho `MAIL-001` neplní a ID zůstává v pending.

Pravidla:
- `/faktury/nova` řádek v databázi nezakládá. Koncept vznikne prvním autosave, tedy prvním změněným polem, aby nevznikaly prázdné doklady.
- Autosave po 1,5 s nečinnosti, jeden běžící požadavek, poslední hodnota vyhrává. Stav „Uloženo“ nebo chyba je vidět. Při `stale` se formulář zamkne s odkazem na obnovení.
- Náhled je iframe na `/faktury/[id]/nahled?rev=<revision>`, obnoví se po autosave.
- Změna zákazníka přepíše jen výchozí pole, která uživatel v tomto formuláři nezměnil.
- Měna se ve formuláři volí vždy, u cizí měny se ukáže ruční kurz. Přepínač a ČNB doplní plán 6.
- Položka z ceníku v jiné měně se doplní a ukáže varování, částka se nepřepočítává.
- Řazení položek přetažením i klávesnicí, knihovna `@dnd-kit/sortable`. Součty ve formuláři volají `computeTotals`, stejnou funkci jako server.
- Nad formulářem je souhrn `checkIssuable`, chybějící pole mají odkaz na opravu.
- Stejný formulář upravuje vystavený doklad přes `updateIssuedAction`, bez autosave. Odeslaný doklad ukáže upozornění a po uložení `resendSuggested`.

- [ ] **Step 1: Napiš testy**

```ts
test('[INV-010] vyberu zákazníka, položku z ceníku a vystavím', ...)
test('[INV-011] zákazník založený ve formuláři je vybraný', ...)
test('[INV-012] položky lze přeřadit myší i klávesnicí', ...)
test('[INV-013] řádek jde uložit do ceníku', ...)
test('[INV-014] sleva na doklad se promítne do součtu a PDF', ...)
test('[INV-015] zaokrouhlení na koruny', ...)
test('[INV-016] náhled se změní po úpravě', ...)
test('[INV-017] po znovunačtení je koncept zachovaný', ...)
test('[INV-017] druhá karta dostane srozumitelné odmítnutí', ...)
test('[INV-019] volitelná pole se propíšou do PDF', ...)
test('[INV-020] úprava odeslané faktury upozorní', ...)
test('[INV-025] celý formulář jde dokončit klávesnicí', ...)
test('[INV-026] bez štítků je PDF stejné, štítek jde založit ve formuláři', ...)
test('[SEC-006] akce odmítnou neplatný vstup a cizí ID', ...)
```

- [ ] **Step 2: Ověř selhání:** `npx playwright test invoice-form`, FAIL.
- [ ] **Step 3: Implementuj** formulář a actions.
- [ ] **Step 4: Ověř:** `npm test`, `npx playwright test invoice-form` a `E2E_DOCKER_IMAGE=fakturan-ci npx playwright test docker-pdf` po novém `docker build`, PASS.
- [ ] **Step 5: Commit** `feat(invoices): add invoice form with autosave and preview`

---

### Task 10: Seznam a detail faktury

**Files:**
- Create: `src/app/(app)/faktury/[id]/page.tsx`, `src/app/(app)/faktury/[id]/verze/[versionId]/page.tsx`, `src/app/(app)/faktury/hromadne-pdf/route.ts`, `src/components/invoices/invoice-table.tsx`, `src/components/invoices/invoice-filters.tsx`, `src/components/invoices/invoice-summary.tsx`, `src/components/invoices/invoice-actions.tsx`, `src/components/invoices/version-list.tsx`
- Modify: `src/app/(app)/faktury/page.tsx`, `src/app/(app)/zakaznici/[id]/page.tsx`, `src/server/services/invoices.ts`, `src/lib/texts.ts`, `src/proxy.ts`
- Test: `tests/backend/invoices-list.test.ts`, `tests/e2e/invoices.spec.ts`

**Interfaces:**
- Produces:
  - `parseInvoiceFilter(params): InvoiceFilter`
  - `listInvoices(ownerId, filter): Page<InvoiceRow>`
  - `invoiceSummary(ownerId, filter): { currency; invoicedMinor; paidMinor; overdueMinor }[]`
  - `customerInvoiceStats(ownerId, customerId)`

Spec: INV-004, INV-024, INV-030 až 032, CUS-006, QR-002. `search_text` skládá `foldText` z čísla, zákazníka a názvů položek a udržuje ho služba při každém uložení. Řazení přes `czech` kolaci u textů, stabilní přes `id`. Období filtruje `issue_date`. Filtr je jen v URL, neznámé hodnoty se ignorují. Souhrn se počítá nad celým filtrem, ne stránkou, a nesčítá různé měny. `status` filtr „po splatnosti“ používá `isOverdue` v SQL. Detail ukáže stavy, verze, `entity-history`, důvod chybějícího QR a akce: upravit, duplikovat, stornovat, vrátit storno, označit jako odeslanou, stáhnout PDF, uložit jako šablonu. Hromadně: ZIP PDF přes `fflate` s limitem 200 a `exportUser`, označit jako odeslané. Hromadné odeslání a úhrada přijdou v plánech 4 a 5, INV-024 zůstává v pending. Prázdné stavy a mobil podle UI-007 a UI-009. Na kartě zákazníka přibudou doklady a součty, průměr úhrady přijde v plánu 5.

- [ ] **Step 1: Napiš testy**

```ts
test('[INV-030] filtr podle stavu, zákazníka, období, měny, typu, štítku', ...)
test('[INV-030] hledání „prilezitost“ najde „Příležitost“', ...)
test('[INV-031] řazení podle každého sloupce, stránkování beze ztrát', ...)
test('[INV-031] filtr přežije obnovení stránky', ...)
test('[INV-032] souhrn je pro každou měnu zvlášť a nad celým filtrem', ...)
test('[INV-032] storno a koncept se nezapočítají', ...)
test('[INV-004] detail ukáže stavy a historii', ...)
test('[INV-024] hromadné PDF dá ZIP vybraných dokladů', ...)
test('[TST-009] cizí detail je 404 a list ho nevrátí', ...)
test('faktura od nuly po stažené PDF s dekódovaným QR a kontrolou souladu', ...)
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/invoices-list.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** `npm test` a `npx playwright test invoices`, PASS.
- [ ] **Step 5: Commit** `feat(invoices): add invoice list and detail`

---

### Task 11: Šablony

**Files:**
- Create: `src/server/db/schema/invoice-template.ts`, `drizzle/0017_invoice_template.sql`, `src/server/services/invoice-templates.ts`, `src/app/(app)/faktury/sablony/page.tsx`, `src/app/(app)/faktury/sablony/actions.ts`, `src/components/invoices/template-list.tsx`
- Modify: `src/server/services/users.ts`, `src/components/invoices/invoice-actions.tsx`, `src/lib/texts.ts`
- Test: `tests/backend/invoice-templates.test.ts`, `tests/e2e/templates.spec.ts`

**Interfaces:**
- Consumes: `validateVariables`, `saveDraft`
- Produces: `saveTemplate(actor, raw): { id }`, `deleteTemplate(actor, id)`, `listTemplates(ownerId)`, `templateFromInvoice(actor, invoiceId, name): { id }`, `draftFromTemplate(actor, templateId): { id }`

Spec: TPL-001 až 004. Šablona má `document` JSON ve stejném tvaru jako `DraftInput` bez dat a čísla, `customer_id` je `set null`. `draftFromTemplate` vezme data z preferencí a smazaného nebo archivovaného zákazníka nevybere. Neznámá proměnná je chyba při uložení šablony. Plán 4 šablony znovu použije pro pravidelné faktury.

- [ ] **Step 1: Napiš testy**

```ts
test('[TPL-001] šablona uloží položky, poznámky, jazyk, měnu, design, splatnost', ...)
test('[TPL-002] jedno kliknutí dá koncept s dnešními daty', ...)
test('[TPL-003] uložení faktury jako šablony nepřenese číslo ani stav', ...)
test('[TPL-004] neznámá proměnná {{neco}} je odmítnutá s názvem', ...)
test('[TST-009] izolace šablon', ...)
```

- [ ] **Step 2: Ověř selhání:** `npx vitest run tests/backend/invoice-templates.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** `npm test`, `npx playwright test templates`, `npm run test:coverage-spec`, `npm run lint`, `npm run typecheck`, `npm run format:check`, PASS.
- [ ] **Step 5: Commit** `feat(invoices): add invoice templates`

---

## Přenos do dalších plánů

- **Plán 4:** tlačítko „Odeslat klientovi“ na detailu a po vystavení (MAIL-001), archiv odeslaného PDF (PDF-010), `resendSuggested`, hromadné odeslání, proměnné s obdobím z plánu, šablony v pravidelných fakturách.
- **Plán 5:** `paid_minor`, stavy `partially_paid` a `paid`, návrat stavu INV-023, zákaz storna s platbami, průměr úhrady CUS-006, hromadné „označit jako uhrazené“.
- **Plán 6:** typy `advance` a `credit_note`, přepínač zahraniční faktury, ČNB, FOR-003, FOR-004, FOR-009, FOR-010, doložky.
- **Plán 8:** filtr „vytvořeno jinde“ dostane data z importu, ZIP přes `fflate` se znovu použije v exportech.
- **ARC-005:** první `use cache` s daty účtu stále chybí, zůstává na dashboard v plánu 7.
