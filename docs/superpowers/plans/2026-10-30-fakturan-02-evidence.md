# Fakturan 2: Evidence – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uživatel si nastaví dodavatele, účty a výchozí hodnoty, vede zákazníky a ceník a má číselné řady, takže plán 3 může vystavovat faktury bez dalšího nastavování.

**Architecture:** Každá entita má službu v `src/server/services` nad `mutate` a `scoped`, server actions jen validují a volají službu. Sdílené Zod schéma je ve stejné složce jako služba. Externí ARES a VIES jsou za jedním modulem s timeoutem, jejich výpadek nic neblokuje.

**Tech Stack:** Next.js 16.4, Drizzle, better-sqlite3, Zod, shadcn/ui, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`

## Global Constraints

- Práce probíhá na `main`. Nic se nepushuje.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů.
- Komentáře jen pro neočividné invarianty, UI texty česky a v `src/lib/texts.ts`, jen tokeny barev.
- Název testu obsahuje ID požadavku, `tests/spec-pending.txt` se průběžně zmenšuje.
- Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)` se záznamem `scope: 'user'` a `ownerId`.
- Každý dotaz na data účtu jde přes `scoped(ownerId)`. Každá nová tabulka s vlastníkem patří do `USER_OWNED_TABLES`, jinak spadne strukturální test.
- Každý typ entity má test `assertIsolated` včetně `update` a `remove`.
- Vstupy se validují na serveru sdíleným Zod schématem (SEC-006).
- Peníze jako celé číslo v nejmenší jednotce, aktuální čas přes `clock`.
- `USER_OWNED_TABLES` je seřazené: tabulka s nekaskádovým cizím klíčem je před tabulkou, na kterou odkazuje.

## Review Focus

1. Dvě současná přidělení čísla z jedné řady: každé dostane jiné číslo a počítadlo nepřeskočí (Task 5).
2. Změna data přes konec roku při resetu ročně: `{RRRR}-{NNN}` začne od 1 a rok se bere z data dokladu, ne z `clock` (Task 5).
3. ARES a VIES nedostupné, pomalé nebo vrací nesmysl: formulář jde dál vyplnit a uložit, chyba je srozumitelná (Task 2, Task 6).
4. Nahrané SVG se skriptem nebo soubor s falešnou příponou: odmítnutí nebo sanitace, a cizí uživatel soubor nedostane ani se znalostí ID (Task 1).
5. Smazání účtu uživatele s logem, zákazníky a řadami: nezůstane řádek ani soubor na disku (Task 1, Task 7).

---

### Task 1: Soubory a logo

**Files:**
- Create: `src/server/db/schema/file.ts`, `src/server/files/store.ts`, `src/server/files/validate.ts`, `src/server/services/files.ts`, `src/app/(app)/soubory/[id]/route.ts`
- Modify: `src/server/services/users.ts`, `src/server/services/instance-status.ts`
- Test: `tests/backend/files.test.ts`

**Interfaces:**
- Produces:
  - `storeFile(actor, kind: FileKind, data: Buffer, name: string): { id: string }`
  - `readOwnedFile(actor, id): { data: Buffer; mimeType: string; name: string }`
  - `deleteFile(actor, id): void`
  - `type FileKind = 'logo' | 'qr_logo' | 'signature'`

Spec: SEC-005, SET-013, SET-014. Soubory jsou v `<DATA_DIR>/files/<userId>/<id>`, název z uživatelského vstupu se na disku nepoužívá. Typ se pozná z obsahu, ne z přípony. Limit 2 MB. Povoleno PNG, JPEG, WebP, SVG; SVG se sanitizuje přes `dompurify` s `jsdom`. Route vrací `Content-Disposition`, `X-Content-Type-Options: nosniff` a `Content-Security-Policy: sandbox` a jen vlastníkovi, jinak 404. `purgeAccount` smaže celou složku uživatele až po úspěšné transakci.

- [ ] **Step 1: Napiš testy**

```ts
test('[SEC-005] soubor s příponou .png a obsahem HTML je odmítnut', ...)
test('[SEC-005] SVG se skriptem a on* atributy je po uložení bez nich', ...)
test('[SEC-005] soubor nad 2 MB je odmítnut', ...)
test('[SEC-005] cizí uživatel dostane 404 i se správným ID', ...)
test('[ADM-006] smazání účtu odstraní soubory z disku', ...)
```

- [ ] **Step 2: Spusť, očekávej FAIL**

Run: `npx vitest run tests/backend/files.test.ts`

- [ ] **Step 3: Implementuj, spusť, očekávej PASS, commit**

```bash
git add -A
git commit -m "feat(files): add validated owner-scoped file storage"
```

### Task 2: Profil dodavatele a ARES

**Files:**
- Create: `src/server/db/schema/supplier.ts`, `src/server/services/supplier.ts`, `src/server/external/ares.ts`, `src/app/(app)/nastaveni/dodavatel/page.tsx`, `src/app/(app)/nastaveni/dodavatel/actions.ts`, `src/components/settings/supplier-form.tsx`
- Modify: `src/components/settings-tabs.tsx`
- Test: `tests/backend/supplier.test.ts`, `tests/backend/ares.test.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**
- Produces:
  - `getSupplier(ownerId): SupplierProfile | null`, `saveSupplier(actor, input: SupplierInput): void`
  - `missingSupplierFields(ownerId): string[]` pro SET-002
  - `lookupAres(ico: string): Promise<AresResult | null>`

Spec: SET-010 až SET-014, SET-002 (kontrola, vynucení v plánu 3). Povinné: jméno, ulice, město, PSČ, stát, IČO. IČO se ověřuje kontrolní číslicí. Texty „Nejsem plátce DPH.“ a „I am not a VAT payer.“ jsou výchozí a upravitelné. ARES REST `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}`, timeout 5 s, fetch je injektovatelný kvůli testům.

- [ ] **Step 1: Napiš testy**

```ts
test('[SET-010] profil se uloží a audituje', ...)
test('[SET-011] identifikovaná osoba vyžaduje DIČ', ...)
test('[SET-012] výchozí text o neplátcovství jde upravit v obou jazycích', ...)
test('[SET-002] missingSupplierFields vrátí chybějící údaje', ...)
test('[CUS-004] ARES timeout vrátí null', ...)
test('[SET-010] izolace profilu', () => assertIsolated(...))
```

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(settings): add supplier profile with ares lookup"
```

### Task 3: Bankovní účty

**Files:**
- Create: `src/server/db/schema/bank-account.ts`, `src/server/services/bank-accounts.ts`, `src/lib/iban.ts`, `src/app/(app)/nastaveni/ucty/page.tsx`, `src/app/(app)/nastaveni/ucty/actions.ts`, `src/components/settings/bank-accounts.tsx`
- Test: `tests/unit/iban.test.ts`, `tests/backend/bank-accounts.test.ts`

**Interfaces:**
- Produces:
  - `listBankAccounts(ownerId)`, `saveBankAccount(actor, input)`, `hideBankAccount(actor, id)`, `deleteBankAccount(actor, id)`
  - `setDefaultForCurrency(actor, currency, accountId)`, `defaultAccountFor(ownerId, currency): BankAccount | null`
  - `czechAccountToIban(number: string, bankCode: string, prefix?: string): string`, `isValidIban(value: string): boolean`

Spec: SET-020 až SET-022. Měna je z FOR-002: CZK, EUR, USD, GBP, CHF, PLN. Výchozí účet na měnu je unikátní `(userId, currency)`. České číslo se převede na IBAN, u zahraničního se IBAN zadá. Kontrola smazání proti fakturám přijde v plánu 3, tady je pro ni funkce `isAccountUsed` vracející `false`.

- [ ] **Step 1: Napiš testy**

```ts
test('[SET-020] číslo 1234567890/2010 se převede na platný IBAN', ...)
test('[SET-021] každá měna má nejvýš jeden výchozí účet', ...)
test('[SET-021] defaultAccountFor vrátí účet podle měny', ...)
test('[SET-020] izolace účtů', () => assertIsolated(...))
```

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(settings): add bank accounts per currency"
```

### Task 4: Výchozí hodnoty a onboarding

**Files:**
- Create: `src/server/db/schema/settings.ts`, `src/server/services/preferences.ts`, `src/app/(app)/nastaveni/vychozi/page.tsx`, `src/app/(app)/nastaveni/vychozi/actions.ts`, `src/app/(app)/pruvodce/page.tsx`, `src/components/settings/onboarding.tsx`
- Modify: `src/app/(app)/page.tsx`
- Test: `tests/backend/preferences.test.ts`, `tests/e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: `saveSupplier`, `saveBankAccount`, `lookupAres`, `storeFile`.
- Produces: `getPreferences(ownerId): Preferences`, `savePreferences(actor, input)`, `completeOnboarding(actor)`, `isOnboarded(ownerId): boolean`.

Spec: SET-001, SET-030 až SET-034. Výchozí hodnoty, když uživatel nic nenastavil: splatnost 14 dní, jazyk `cs`, měna CZK, design `cisty`, jednotka `ks`, způsob platby převod, logo a QR zapnuté. Řádek se nezakládá předem, `getPreferences` slučuje uložené s výchozími. Průvodce má kroky dodavatel, účet, řada, logo, jazyk a design, jde přeskočit a Přehled ho nabídne, dokud není dokončený.

- [ ] **Step 1: Napiš testy**

```ts
test('[SET-030] nový účet dostane výchozí hodnoty bez řádku v databázi', ...)
test('[SET-033] datum vystavení jde nastavit na poslední den minulého měsíce', ...)
test('[SET-034] neplatný formát data je odmítnut', ...)
```

E2E: `[SET-001] průvodce vyplní dodavatele z ARES a jde přeskočit` s nahrazeným ARES přes proměnnou `ARES_BASE_URL`, kterou přidej do `.env.example` a spec 19.5.

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(settings): add preferences and onboarding"
```

### Task 5: Číselné řady

**Files:**
- Create: `src/server/db/schema/number-series.ts`, `src/lib/number-format.ts`, `src/server/services/number-series.ts`, `src/app/(app)/nastaveni/rady/page.tsx`, `src/app/(app)/nastaveni/rady/actions.ts`, `src/components/settings/number-series.tsx`
- Test: `tests/unit/number-format.test.ts`, `tests/backend/number-series.test.ts`

**Interfaces:**
- Produces:
  - `formatNumber(template: string, date: CalendarDate, n: number): string`
  - `validateTemplate(template: string): string | null`
  - `variableSymbolFrom(number: string): string`
  - `allocateNumber(tx, ownerId, seriesId, date: CalendarDate): { number: string; n: number }`, volá se uvnitř `mutate` v plánu 3
  - `listSeries`, `saveSeries`, `setNextNumber`, `ensureDefaultSeries(actor)`

Spec: NUM-001 až NUM-008. Tokeny `{RRRR}`, `{RR}`, `{MM}`, `{DD}`, `{Q}`, `{N}` až `{NNNNNN}`, šablona musí obsahovat právě jedno `{N…}`. Reset ročně, čtvrtletně, měsíčně, nikdy. Formulář nabízí předvolby z NUM-008. Počítadlo je v tabulce `(seriesId, periodKey, next)`, `periodKey` se odvodí z data dokladu. `document_type`: `invoice`, `advance`, `credit_note`. Výchozí řada na typ se založí poprvé při čtení: `{RRRR}-{NNN}`, záloha `Z{RRRR}-{NNN}`, oprava `D{RRRR}-{NNN}`, reset ročně. VS odstraní nečíslice a vezme posledních 10 číslic.

- [ ] **Step 1: Napiš testy**

```ts
test('[NUM-001] {RRRR}-{NNN} pro 40. fakturu 2026 je 2026-040', ...)
test('[NUM-001] šablona bez {N} nebo se dvěma je neplatná', ...)
test('[NUM-001] {NN} po 99 dá 100, nezkrátí se', ...)
test('[NUM-001] {Q} dá čtvrtletí a {DD} den z data dokladu', ...)
test('[NUM-008] každá předvolba dá očekávaný příklad', ...)
test('[NUM-002] čtvrtletní reset začne v dubnu od 1', ...)
test('[NUM-002] roční reset začne v novém roce od 1 podle data dokladu', ...)
test('[NUM-002] řada s resetem nikdy nepřeteče přes konec roku', ...)
test('[NUM-004] další číslo pod již použitým je odmítnuto', ...)
test('[NUM-005] 50 souběžných přidělení dá 50 různých čísel bez mezery', ...)
test('[NUM-006] náhled formátu', ...)
test('[NUM-007] 2026-040 dá VS 2026040 a delší číslo se omezí na 10 číslic', ...)
```

Souběh testuj přes několik procesů nad stejným souborem databáze (`worker_threads`), v jednom vlákně by nic neprokázal.

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(numbering): add configurable number series"
```

### Task 6: Zákazníci

**Files:**
- Create: `src/server/db/schema/customer.ts`, `src/server/services/customers.ts`, `src/server/external/vies.ts`, `src/app/(app)/zakaznici/page.tsx` (nahradit), `src/app/(app)/zakaznici/[id]/page.tsx`, `src/app/(app)/zakaznici/actions.ts`, `src/components/customers/*`
- Modify: `src/components/nav.ts`
- Test: `tests/backend/customers.test.ts`, `tests/backend/vies.test.ts`, `tests/e2e/customers.spec.ts`

**Interfaces:**
- Consumes: `lookupAres`.
- Produces:
  - `listCustomers(ownerId, filter): Page<Customer>`, `getCustomer(ownerId, id)`, `searchCustomers(ownerId, q, limit)`
  - `saveCustomer(actor, input): { id: string; duplicateOfIco: string | null }`
  - `archiveCustomer`, `restoreCustomer`, `deleteCustomer`
  - `verifyVat(actor, id): Promise<VatStatus>`

Spec: CUS-001 až CUS-005, CUS-007, CUS-009, EntityHistory z AUD-009. CUS-006 (statistiky) a CUS-008 (kopie na faktuře) dokončí plán 3, karta zatím ukáže údaje a historii. Filtr „s dluhem“ se přidá v plánu 3. Výjimky zákazníka (splatnost, jazyk, měna, design, upomínky) jsou sloupce s `null` = podle nastavení. VIES přes `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{cc}/vat/{number}`, timeout 5 s, základní URL přes `VIES_BASE_URL`. Filtry v URL. `deleteCustomer` zatím bez kontroly dokladů, plán 3 doplní.

- [ ] **Step 1: Napiš testy**

```ts
test('[CUS-001] seznam stránkuje, hledá a filtruje', ...)
test('[CUS-003] výjimka zákazníka přebije výchozí splatnost', ...)
test('[CUS-005] výpadek VIES nebrání uložení', ...)
test('[CUS-005] ověření uloží datum', ...)
test('[CUS-007] archivovaný zákazník není ve výchozím seznamu', ...)
test('[CUS-009] duplicitní IČO vrátí upozornění a uloží se', ...)
test('[SEC-006] neplatný vstup server action je odmítnut', ...)
test('[SEC-002] cizí zákazník není dostupný přes server action', ...)
test('[CUS-001] izolace zákazníků', () => assertIsolated(...))
```

E2E: `[CUS-004] nový zákazník předvyplněný z ARES`, `[CUS-001] hledání a filtr přežijí obnovení stránky`.

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS**

- [ ] **Step 3: Odstraň z `tests/spec-pending.txt` pokrytá ID včetně SEC-006. Commit**

```bash
git add -A
git commit -m "feat(customers): add customer records with ares and vies"
```

### Task 7: Ceník a jednotky

**Files:**
- Create: `src/server/db/schema/catalog.ts`, `src/server/services/catalog.ts`, `src/app/(app)/cenik/page.tsx` (nahradit), `src/app/(app)/cenik/actions.ts`, `src/components/catalog/*`
- Modify: `src/components/nav.ts`, `src/lib/texts.ts`
- Test: `tests/backend/catalog.test.ts`, `tests/e2e/catalog.spec.ts`

**Interfaces:**
- Produces:
  - `listCatalog(ownerId, filter): Page<CatalogItem>`, `searchCatalog(ownerId, q, limit)`, `saveCatalogItem(actor, input)`, `archiveCatalogItem`, `recordCatalogUse(tx, ownerId, id)`
  - `listUnits(ownerId)`, `saveUnit(actor, name)`, `deleteUnit(actor, id)`

Spec: CAT-001 až CAT-004. Cena je celé číslo v nejmenší jednotce, formulář pracuje s desetinnou čárkou. Výchozí jednotky se založí při prvním čtení: hod., ks, den, měsíc, projekt. Řazení „podle použití“ je `useCount desc`. CAT-003 se doplní testem v plánu 3.

- [ ] **Step 1: Napiš testy**

```ts
test('[CAT-001] položka se uloží a cena je v haléřích', ...)
test('[CAT-002] hledání a řazení podle použití', ...)
test('[CAT-004] uživatel přidá vlastní jednotku', ...)
test('[CAT-001] izolace ceníku', () => assertIsolated(...))
```

E2E: `[CAT-001] nová položka s cenou 1 234,50 Kč se zobrazí správně`.

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS**

- [ ] **Step 3: Celá sada a commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run test:coverage-spec && npm run build`
Expected: vše projde.

```bash
git add -A
git commit -m "feat(catalog): add price list and units"
```

---

## Přenos do plánu 3

- Unikátní index na fakturu `(uživatel, číslo)`, `isNumberTaken`, přeskočení ručně obsazených čísel v `allocateNumber`, volba řady u faktury (NUM-003) a ruční přepis VS (NUM-007).
- `isAccountUsed` musí číst faktury (SET-022), `deleteCustomer` odmítne zákazníka s doklady (CUS-007), `designId` se ověří proti seznamu designů, CAT-003 a CUS-006, CUS-008.
- SET-002: blokace vystavení při chybějících údajích dodavatele.
- Celkové částky: `MAX_PRICE_MINOR × množství` může přesáhnout `MAX_SAFE_INTEGER`, omezit nebo použít BigInt.
- `defaultAccountFor` může vrátit `null`, vystavení na to musí upozornit (FOR-005).
- Výchozí jednotky se ukládají až s prvním zápisem.
- Plán 3 začíná zavedením nástrojů TST-012 až TST-020.
