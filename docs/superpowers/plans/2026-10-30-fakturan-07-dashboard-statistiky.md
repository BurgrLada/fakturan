# Fakturan 7: Dashboard a statistiky – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uživatel vidí na Přehledu vlastní dashboard z widgetů a na stránce Statistiky (`/prehledy`) přehledy fakturace, úhrad, pohledávek, zákazníků, položek a měn s exportem do CSV a Excelu. Každé číslo vychází jen z dat jeho účtu a souhlasí se součtem dokladů.

**Architecture:** Výpočty mají jediné jádro `src/server/reports/`, které přijímá `Reader`, je bez `server-only` a používá ho služba, widgety i kontrola TST-018. Přepočet do CZK, časové koše a medián jsou SQL funkce registrované na spojení, takže SQL volá stejný kód jako `documentCzkMinor` a `paymentCzkMinor`. Widget je deklarativní JSON se schématem a verzí, překladač ho skládá jen z povolených polí a dotaz vždy začíná `scoped(ownerId)`. Čtení dashboardu je CSS mřížka v server komponentách, knihovna tažení se načte až v režimu úprav. Cache má v klíči ID účtu a razítko dat, takže ji zneplatní i zápis z plánovače.

**Tech Stack:** Next.js 16.4 s Cache Components, Drizzle, better-sqlite3, Zod, `fflate`, Vitest, fast-check, Playwright. Nové závislosti `@tanstack/charts` **[R-1]** a `react-grid-layout` **[R-2]**, obě s přesnou verzí.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`, kap. 14 (DSH-001 až 032), 15 (REP-001 až 009, TAX ne), ARC-005, ARC-006, UI-001 až UI-011, otevřený bod TanStack Charts v kap. 24, CRN-003, FOR-008, ADV-005, ADV-007, TST-018. Přenosy z konců plánů 3 až 6.

## Global Constraints

- Správce balíčků je pnpm. Práce probíhá na `main`. Nic se nepushuje a nic se nenasazuje.
- **Harness přesouvá příkazy nad 180 s na pozadí.** Každý příkaz v popředí proto běží nejvýš 170 s (`timeout 170 …`) a dlouhé běhy se dělí po částech: `pnpm exec vitest run --project unit`, `pnpm exec vitest run --project backend --shard=N/4` a Playwright po jednotlivých souborech. **Nikdy nečekej na úlohu na pozadí.** Běh, který se do limitu nevejde, rozděl jemněji. Když to nejde, zapiš do zprávy úkolu „neověřeno“ s příkazem a nepředstírej úspěch.
- `pnpm build` před Playwrightem, protože fixture spouští `next start`.
- `minimumReleaseAge` se neobchází: žádný `--config` ani změna `pnpm-workspace.yaml`. Obě nové verze prošly 1. 11. 2026 zkušebním `pnpm add --lockfile-only` v prázdném projektu s pnpm 11.28.9. Když pnpm verzi odmítne, použij nejbližší starší, kterou přijme, a zapiš ji do zprávy úkolu.
- **Každou novou závislost ověř v Dockeru v úkolu, který ji přidává:** po vrstvách s `timeout 170`: `--target deps`, `--target build`, celý obraz, pak `E2E_DOCKER_IMAGE=fakturan-ci timeout 170 pnpm exec playwright test docker-scheduler`. Když krok buildu sám přesáhne limit, zapiš „Docker neověřen“ a neběž na pozadí.
- Implementeři neběží souběžně. Úkoly jdou po sobě a každý začíná z čistého stromu po commitu předchozího.
- Plán navazuje na uzavřený plán 6, commit `2303f77`. Před Task 1 ověř, že strom je čistý.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů. Agent staguje jen své soubory.
- Komentáře jen pro neočividné invarianty. **UI texty česky a v `src/lib/texts.ts`** (`TEXTS.reports`, `TEXTS.dashboard`), jen tokeny barev.
- **Migrace navazují po nejvyšší v `drizzle/`,** dnes `0038_advance_final_mode`: `pnpm exec drizzle-kit generate --name <jméno>`, čísla níže platí pro pořadí úkolů, soubor vždy ověř proti `drizzle/`.
- Service kód běží v testech i přes type stripping Node (`tests/helpers/*-worker.mjs`), proto žádné `constructor(readonly x)`, `enum` ani jiná syntaxe vyžadující transformaci. Týká se hlavně `src/lib/sql-functions.ts`, který načítá `createDb`.
- Před kódem v App Routeru přečti příslušný návod v `node_modules/next/dist/docs/` (viz `AGENTS.md`). Pro Task 4 `01-app/03-api-reference/01-directives/use-cache.md`, `01-app/03-api-reference/04-functions/revalidateTag.md`, `01-app/03-api-reference/04-functions/updateTag.md` a `01-app/02-guides/authentication-with-cache-components.md`.
- Název testu obsahuje ID požadavku, `tests/spec-pending.txt` se průběžně zmenšuje a každý úkol sám přesune ID, která v testech pojmenuje. `test:coverage-spec` selže na ID, které je zároveň v pending i v názvu testu. ID splněné jen zčásti a bez testu v pending zůstává. ID s testem, které ještě není splněné celé, jde do `tests/spec-partial.txt` (tři sloupce oddělené tabulátorem: ID, co chybí, plán). Úkoly to mají označené **[částečně]**.
- Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)`. Čtení přehledu nikdy nezapisuje, jedinou výjimkou je založení výchozího dashboardu **[R-19]**.
- **Každý dotaz na data účtu jde přes `scoped(ownerId)`, u spojení tabulek na obou stranách.** `exchange_rate` je instanční a do `USER_OWNED_TABLES` nepatří. Nové tabulky `dashboard_widget` a `dashboard` tam patří v tomto pořadí. Server actions pokrývá `tests/backend/actions-isolation.test.ts`.
- Aktuální čas jen přes `clock`, „dnes“ přes `calendarDateInPrague`. Do `use cache` a jádra přehledů jde `today` jako argument.
- Peníze jsou celá čísla, zaokrouhlení půl od nuly, žádná aritmetika v plovoucí čárce. Do knihovny grafů jde číslo jen pro vykreslení, všechny popisky a tabulky formátuje `formatMoney` z celých čísel.
- `dueSql` je jediný výraz zůstatku. `total - paid` se nikde nepíše. Příjmy jsou vždy `kind = 'payment'` včetně záporných vrácení, řádky `difference` nejsou příjem.
- Testy nikdy nesahají na síť. Vstupy se validují na serveru sdíleným Zod schématem, které nepřijímá neznámé klíče.

## Review Focus

1. **Soulad částek:** zálohy a `credits_minor`, `advance_minor`, `paid_minor`, `difference`, záporná vrácení, opravy v jiném období, zaokrouhlení po dokladech, doklad a platba bez kurzu nesmí tiše zmizet, protože `sum` hodnoty `NULL` ignoruje. Kontrola musí počítat nezávisle na zkoušeném SQL (Task 1, 2).
2. **Hranice účtu a cache:** obě strany každého spojení ve `scoped`, cizí `customerId` ve filtru, klíč a tag každé položky `use cache`, zastaralé číslo po zápisu z plánovače, po novém lístku ČNB a v klientském routeru (Task 1, 4, 5).
3. **Bezpečnost konfigurace:** JSON nikdy nevybírá sloupec, výraz ani řazení volným textem, překladač odmítá neznámé kombinace, import nemění nic před potvrzením a export nenese data účtu (Task 5, 8).
4. **Závislosti:** hydratace v Next 16.4, CSP, tmavý režim, tokeny místo barev, přístupnost tažení klávesnicí, knihovna grafu jen za obalem, build a běh v Dockeru (Task 3, 7).
5. **Co Přehled nesmí ztratit:** karta REM-009 nezmizí ani smazáním, importem ani novým dashboardem, onboarding zůstává, rozbitý widget neshodí stránku a synchronní SQLite nezablokuje proces drahým dotazem (Task 5, 6, 7).

## Rozhodnutí plánu

Uživatel chtěl plán bez čekání, proto je plán rozhodl sám. Na `[R-n]` se odkazují úkoly. Čísla platí jen v tomto plánu.

- **[R-1] Grafy jsou `@tanstack/charts@1.1.0`, přesná verze bez `^`.** Ověřeno 1. 11. 2026: `latest` je 1.1.0 (9. 10. 2026), 1.0.0 vyšla 3. 10. 2026 bez předběžného štítku. Balíček nese `docs/compatibility.md`, kde změna veřejného API vyžaduje novou hlavní verzi, a `docs/stability.md`, kde alfa platí jen pro `0.x`. To vysvětluje rozpor zdrojů ze spec. Peer závislosti pokrývají React 19, vstupy `@tanstack/charts/react` nesou `'use client'`, SVG se renderuje i na serveru a `dist` neobsahuje `eval` ani `new Function`, takže projde dnešním CSP. Měsíčně má přes 2,3 mil. stažení. Slabina je stáří řady 1.x (4 týdny), proto přesná verze, obal **[R-3]** a únikový bod: když v Task 3 selže hydratace, CSP nebo Docker a nejde to vyřešit do konce úkolu, obal dostane `recharts@3.10.1` (stabilní, peer React 19) beze změny rozhraní a důvod jde do zprávy úkolu. Otevřený bod v kap. 24 se uzavře touto větou.
- **[R-2] Mřížka je `react-grid-layout@2.3.0` jen pro úpravy.** Verze 2 je přepsaná do TypeScriptu a v `dist` nemá `findDOMNode`, takže běží na Reactu 19. Čtení dashboardu je obyčejná CSS mřížka v server komponentě, RGL se načte přes `next/dynamic` jen v režimu úprav. DSH-004 je tak pouhé CSS a telefon knihovnu vůbec nenačítá. RGL nemá ovládání klávesnicí, proto režim úprav u každého widgetu nabízí tlačítka posunu a změny velikosti nad čistými funkcemi `src/lib/dashboard-layout.ts` (UI-008). Tato tlačítka jsou plnohodnotná, ne záloha.
- **[R-3] Obal `Chart` je jediné místo s knihovnou.** `src/components/charts/chart.tsx` je klientská komponenta se serializovatelným vstupem `ChartSpec`. Definice grafu vzniká uvnitř obalu, ze serveru jdou jen data. Import `@tanstack/charts` mimo `src/components/charts/` odhalí test. Každý graf má `ariaLabel` a tabulku hodnot v `<details>`, protože knihovna alternativu nechává na aplikaci.
- **[R-4] Barvy grafů jsou tokeny `--chart-1` až `--chart-5`.** Dnešní `--chart-1` (světlost 0,88) má ve světlém režimu slabý kontrast k pozadí. Task 3 hodnoty upraví v `globals.css` tak, aby každá měla proti pozadí v obou režimech aspoň 3:1, a rozšíří `tests/unit/contrast.test.ts`. Série se liší i popiskem, ne jen barvou. DSH-016 ukládá jméno tokenu, nikdy hodnotu barvy.
- **[R-5] Jedna definice výpočtu i v SQL.** `src/lib/sql-functions.ts` (bez `server-only`) má `registerSqlFunctions(sqlite)` a volají ho `createDb` i čtecí spojení v `tests/e2e/fixtures.ts`. Přidává `czech_key`, `fx_czk(currency, amount_minor, rate_micros)`, `date_bucket(date, unit)`, `prague_date(ms)` a agregaci `median_minor`. `fx_czk` volá `toCzkMinor` přes `BigInt`, protože součin částky a kurzu se do 64 bitů nemusí vejít a SQLite by přešla na `REAL`. Převod jde po jednotlivých dokladech a pak se sčítá, stejně jako by to sečetl člověk nad doklady. Výjimka uvnitř funkce by shodila celý dotaz, proto vadný vstup vrací `NULL`.
- **[R-6] Základ období.** Fakturace podle `issue_date`, stejně jako filtr seznamu, takže `invoiceSummary` a přehled jdou porovnat. Příjmy podle `paid_on`. Obrat a limity podle `coalesce(taxable_date, issue_date)` **[R-15]**. Opravná faktura se počítá ke svému datu vystavení, tedy může snížit jiné období než původní faktura.
- **[R-7] Co se počítá.** Fakturováno: stav mimo `NOT_IN_TOTALS`, `type <> 'advance'`, opravy se záporem. `credited` v součtu zůstává. Příjmy: `payment.kind = 'payment'`, `amount_minor` v měně platby, doklad mimo `draft` a `cancelled`, platba zálohy jednou k datu úhrady, i když konečná faktura vznikne jindy nebo vůbec. Pohledávky: `dueSql > 0` nad `AWAITING_PAYMENT`, `type <> 'advance'`. Neuhrazené zálohy: stejná podmínka nad `type = 'advance'`, vlastní řádek `advanceOpenMinor`, nikdy v pohledávkách ani po splatnosti (ADV-007).
- **[R-8] Měna.** Bez filtru měny je vše v CZK: dokumenty a zbývající částky kurzem dokladu, platby `payment.rate_micros`. S filtrem měny se nepřevádí a čísla jsou v této měně, u plateb podle měny platby, u dokladů podle měny dokladu. Souhrn nikdy nesčítá různé měny bez převodu.
- **[R-9] Bez kurzu se nic neztratí.** Platba s `rate_micros = null` dostane kurz v SQL z posledního řádku `exchange_rate` s `list_date` v okně 7 dnů před `paid_on`. Jinak zůstane `NULL`. Každý výsledek proto nese `unconverted: { count; byCurrency: { currency; amountMinor }[] }` a UI u čísla ukáže „N dokladů bez kurzu“ s částkou v původní měně. Čtení nikdy nezapisuje doplněný kurz zpět.
- **[R-10] Položky mají vyrovnávací řádek.** `net_minor` nezná slevu dokladu ani zaokrouhlení. Přehled položek proto končí řádkem „Sleva a zaokrouhlení dokladu“ v hodnotě rozdílu proti fakturaci, takže součet tabulky je shodný s fakturací i v CZK po zaokrouhlení. Položka se seskupuje podle `catalog_item_id`, bez něj podle `name`. Zálohy jsou vyloučené, jinak by se položky započetly dvakrát.
- **[R-11] Stárnutí REP-002.** Stáří je `today - due_date`. Doklad splatný dnes nebo později, případně bez splatnosti, je v pásmu „Ve splatnosti“ mimo čtyři pásma spec, protože `overdueCondition` používá `<`. Součet čtyř pásem je tak přesně `overdueMinor` a popisky pásem zůstávají ze spec. Přesně 30, 60 a 90 dní patří do nižšího pásma.
- **[R-12] Období a porovnání.** Relativní tokeny `this_month`, `this_quarter`, `this_year`, `last_year`, `last_30_days`, `last_12_months`, plus absolutní `{ from; to }`. `resolvePeriod` je čistá funkce nad `today`. Porovnání `previous` u celých měsíců, čtvrtletí a roků vrací předchozí stejný celek, jinak stejný počet dní těsně před obdobím. `year` posouvá o rok, 29. 2. přechází na 28. 2. Prázdné časové koše se doplní nulou, aby graf nelhal o průběhu.
- **[R-13] Excel bez nové závislosti.** `src/lib/xlsx-writer.ts` je malý zapisovač SpreadsheetML nad `fflate`, jen jeden list, řetězce, částky a data. Plán 8 ho rozšíří. Kvůli REP-004 v českém Excelu má CSV UTF-8 BOM, oddělovač `;` a desetinnou čárku. `src/lib/tabular.ts` rozlišuje typ buňky: text se neutralizuje vždy (EXP-008), částka nikdy, jinak by se ze záporné částky stal text. `neutralizeCsvCell` se přesune do `src/lib/tabular.ts`, `audit-read.ts` ho reexportuje a formát auditního CSV se nemění.
- **[R-14] Cache má razítko dat v klíči.** `revalidateTag` mimo požadavek vyhodí `Invariant: static generation store missing` (`next/dist/server/web/spec-extension/revalidate.js`), plánovač, fronta ani avízo tedy tag zneplatnit neumí. Proto `accountStamp(ownerId)` čte mimo cache `max(audit_log.id)` účtu a `max(exchange_rate.fetched_at)`. První se zvýší s každou mutací v téže transakci, protože `mutate` bez auditu neprojde a `id` je `AUTOINCREMENT`. Druhé hlídá nový lístek **[R-9]**. Položky mají tvar `async function name(userId: string, stamp: string, today: string, query: string)` s `cacheTag(accountTag(userId))`, který vyžaduje test v `audit-read.test.ts`. `updateTag` volají server actions dashboardu a statistik. **Odchylka od ARC-005:** ve znění „tag, který mutace invalidují“ je doplněno, že mutace mimo požadavek zneplatňuje razítko. Task 4 tuto větu zapíše do spec. Živý náhled DSH-017 cache obchází.
- **[R-15] Limity REP-005.** Sloupce `preferences.turnover_vat_limit_minor` a `turnover_flat_limit_minor`, oba výchozí 2 000 000,00 Kč, a `turnover_basis` (`taxable`, `paid`). Jsou nastavitelné v Nastavení, Výchozí hodnoty. Obrat je vždy v CZK za kalendářní rok. Při základu `taxable` jde o konečné faktury a opravy se záporem, zálohy vůbec. Při základu `paid` jde o příjmy **[R-7]**, tedy záloha v den úhrady. Prahy 80 a 95 % včetně. Výchozí částky jsou k ověření poradcem a stránka říká, že jde o podklad.
- **[R-16] UI-011 se uzavře tady.** Plán 8 čekal na upřesnění, ale REP-005 definuje prahy. Odvozené upozornění `turnover_limit` jde přes `registerDerivedAlerts`, klíč `limit:<limit>:<rok>:<práh>`, takže při překročení 95 % přijde nové a smazání dokladu ho samo stáhne.
- **[R-17] Předpověď REP-003** je po měsících na 6 měsíců dopředu. Otevřené faktury podle splatnosti, po splatnosti a bez splatnosti spadnou do aktuálního měsíce, vlastní série „po splatnosti“. Pravidelné plány se stavem `active` přes `occurrencesBetween` od `cursorDate`, částka přes `computeTotals` z `document`, splatnost z dokumentu plánu. Cizí měna kurzem `resolveRate`, bez kurzu `unconverted`. Výskyt s existujícím dokladem do plánu nejde, protože ho `cursorDate` přeskočil. Koncept z plánu (`recurring_id` je vyplněné) má vlastní sérii, jinak by zmizel z výhledu. Koncepty přidané ručně se nepočítají (REP-007). Zálohy jen ve své sérii.
- **[R-18] Konfigurace widgetu** je `{ v: 1, kind: 'query' | 'system', title, color, format, … }`. Dotazový má `source`, `metric`, `measure`, `groupBy`, `splitBy`, `filters`, `period`, `compare`, `display`, `cumulative`, `topN`. Systémový má `systemId` a parametry `rows`, `period`. Povolené kombinace popisuje tabulka `SOURCE_FIELDS` v `src/lib/widget-config.ts`. Vlastní kód widgetu je rozšíření a schéma ho nemá kam přijmout. Jiné `kind` je chyba, ne ignorovaný klíč.
- **[R-19] Výchozí dashboard vzniká líně.** `ensureDashboards(actor)` při prvním otevření Přehledu založí dashboard z `DEFAULT_DASHBOARD`. Pokrývá tak i stávající účty a obnovu zálohy bez migrace dat. Částečný unikátní index `dashboard_default_idx` na `user_id` při `is_default = 1` zajistí jeden výchozí i při souběžném otevření dvou panelů. Smazání výchozího přenese příznak na nejstarší zbylý, poslední dashboard smazat nejde.
- **[R-20] Karta REM-009 je připnutý systémový widget `due_alerts`.** Jde přesunout a zvětšit, ne odebrat. `normalizeWidgets` ho doplní každému dashboardu při vytvoření, duplikaci i importu, takže přepnutí dashboardu nemůže upozornění schovat. Onboarding zůstává mimo mřížku.
- **[R-21] Globální filtr DSH-005 je v URL** (`?obdobi=…&mena=…&porovnani=…`). Období přebíjí období widgetu, měna se s filtrem widgetu protíná, a když se vyloučí, widget ukáže prázdný stav. Widget při tom zobrazí skutečné období jako podtitul, aby „Fakturováno letos“ nelhalo. Systémové widgety bez období filtr ignorují. Filtr se neukládá.
- **[R-22] Galerie má 22 položek, 20 z DSH-020 a 2 z přenosů.** Dotazových je 13: fakturováno letos, uhrazeno letos, pohledávky, po splatnosti, tržby po měsících, po čtvrtletích, meziroční porovnání (`compare: 'year'`), top zákazníci, top položky, průměrná doba úhrady, podíl měn, kumulativní obrat (`cumulative`), heatmapa fakturace (`groupBy: 'day'`, `display: 'heatmap'`). Systémových ze spec je 7: `paid_ratio`, `aging`, `due_alerts` (nejbližší splatnosti), `upcoming_recurring`, `forecast`, `unmatched_payments`, `limits`. `paid_ratio` je systémový, protože potřebuje dvě míry nad jedním obdobím. Navíc přibývají `open_advances` (přenos plánu 6) a `automation_status` se stavem automatiky a dalšími termíny (přenos plánu 4).
- **[R-23] Dny do úhrady** mají definici `averagePaymentDays`: stav `paid`, poslední `paid_on` s `credited_minor > 0`, doklad s řádkem `difference` se nepočítá. Výpočet se z `payments.ts` přesune do jádra, karta zákazníka čte totéž.
- **[R-24] Meze dotazu.** `better-sqlite3` je synchronní a dlouhý dotaz zastaví i plánovač (ARC-008). Období nejvýš 10 let, nejvýš 400 časových košů, `topN` nejvýš 50 a zbytek jde do řádku „Ostatní“, aby součet seděl. Náhled má `RATE_RULES.widgetPreviewUser` (120 za minutu). Test přes `EXPLAIN QUERY PLAN` hlídá použití indexů `invoice_user_issue_date_idx` a `payment_user_paid_on_idx`.
- **[R-25] Sdílení nenese data.** Soubor má `{ format: 'fakturan.dashboard', v: 1, name, widgets }`. Export zahodí `filters.customerIds` a `filters.itemIds`, protože ID identifikují zákazníka. Vlastní název widgetu je konfigurace a zůstává. Import nikdy nepřepíše stávající dashboard, vždy založí nový. Soubor do 64 KiB, nejvýš 50 widgetů. Chyba uvádí cestu v JSON a co vadí. Náhled ukáže seznam widgetů a výsledky nad vlastními daty, teprve pak se ukládá.
- **[R-26] Rozložení má revizi.** `saveLayout` dostane `dashboard.revision`, starší revize skončí chybou `E.staleLayout`, aby druhý panel nepřepsal novější rozložení. Audit `dashboard.layout` nese počet widgetů, ne celý JSON.
- **[R-27] Mimo tento plán zůstává:** UI-010 (rychlé hledání), do plánu 9, protože nesouvisí s přehledy a žádný plán ho dosud neměl. TAX jde do plánu 8. Daňový přehled nad jádrem `src/server/reports/` tam vznikne bez další změny. UI-002 a UI-012 v pending zůstávají. ARC-001 a UI-003 se uzavřou v Task 8 strukturními testy, protože nový kód je jejich největší riziko a dnešní kód je splňuje.

---

### Task 1: Jádro výpočtů a kontrola proti dokladům

**Files:**
- Create: `src/lib/sql-functions.ts`, `src/lib/report-period.ts`, `src/server/db/invoice-sql.ts`, `src/server/reports/queries.ts`, `src/server/reports/types.ts`, `src/server/services/reports.ts`, `tests/fixtures/report-scenario.ts`
- Modify: `src/server/db/index.ts`, `src/server/services/invoices.ts`, `src/server/services/payments.ts`, `tests/helpers/consistency.ts`, `tests/e2e/fixtures.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/unit/report-period.test.ts`, `tests/unit/report-period.property.test.ts`, `tests/unit/sql-functions.test.ts`, `tests/backend/reports.test.ts`, `tests/backend/consistency.test.ts`

**Interfaces:**
- Consumes: `toCzkMinor`, `documentCzkMinor`, `paymentCzkMinor`, `scoped`, `Reader`, `NOT_IN_TOTALS`, `AWAITING_PAYMENT`
- Produces:
  - `registerSqlFunctions(sqlite: Database.Database): void`
  - `dueSql`, `fullDue`, `overdueCondition(today)`, `openCondition` v `invoice-sql.ts`, `invoices.ts` je reexportuje
  - `resolvePeriod(period: Period, today): DateRange`, `previousRange(range, mode: 'previous' | 'year'): DateRange`, `bucketKey(date, unit): string`, `bucketsBetween(range, unit): string[]`
  - `reportSummary(q, ownerId, filter: ReportFilter, today): ReportSummary` s `invoicedMinor`, `incomeMinor`, `outstandingMinor`, `overdueMinor`, `advanceOpenMinor`, `unconverted`
  - `invoicedSeries`, `incomeSeries`, `agingBands`, `topCustomers`, `topItems`, `currencyShares`, `paymentDays` nad stejným `ReportFilter`
  - `ReportFilter = { range: DateRange; currency?: Currency; includeExternal: boolean; customerIds?: string[] }`

Spec: REP-002, REP-006, REP-007, REP-008, REP-009, CRN-003, FOR-008, ADV-005 **[částečně]**, ADV-007, TST-018. Viz **[R-5]** až **[R-12]**, **[R-23]**.

Pravidla:
- `queries.ts` a `invoice-sql.ts` nemají `server-only` ani import z `db`. Dostávají `Reader` a smí je načíst Playwright fixture. `reports.ts` je tenká služba nad výchozím `db`.
- Filtr `customerIds` prochází přes kontrolu vlastnictví, vzor `ownedCustomerId`. Cizí ID se zahodí a výsledek je prázdný, ne součet všeho.
- U spojení `payment` s `invoice` musí oba řádky splnit `scoped`. Filtr `includeExternal` se u plateb čte z dokladu.
- Hodnoty `NULL` z `fx_czk` se počítají do `unconverted` ve stejném dotazu, nesčítají se mlčky **[R-9]**.
- `paymentDays` přebere `averagePaymentDays`, signatura v `payments.ts` zůstává jako volání jádra.
- Fixtura `report-scenario.ts` vkládá doklady přes služby, ne přímo. Datum `today` je 2. 11. 2026 a data jsou tato:
  - A: faktura CZK 12 100,00, vystavena 15. 1., splatná 29. 1., uhrazena 1. 2.
  - B: faktura 1 000,00 EUR, kurz 25,000000, vystavena 10. 3. Oprava -100,00 EUR ze dne 2. 4. Platba 900,00 EUR 10. 4., kurz 24,500000.
  - C: záloha CZK 5 000,00 ze 4. 5., uhrazena 11. 5. Konečná faktura 5 000,00 z 12. 5.
  - D: stornovaná 7 777,00 a koncept 8 888,00.
  - E: faktura 3 000,00 z 1. 9., splatná 15. 9., platba 1 000,00 20. 9.
  - F: záloha 2 000,00 z 1. 10., splatná 15. 10., neuhrazená.
  - G: `external` faktura 1 500,00 z 1. 6., uhrazena 10. 6.
- `assertConsistent` dostane kontrolu `reportProblems`: pro každý rok s doklady spočte v JS ze řádků bez použití `queries.ts` fakturaci přes `documentCzkMinor`, příjmy přes `paymentCzkMinor` a zůstatek přes `amountDue` a porovná je s `reportSummary`. E2E spojení volá `registerSqlFunctions`.
- Z partial odeber `TST-018`, `CRN-003`, `FOR-008`, `ADV-007`. `ADV-005` přepiš na „Chybí daňový přehled“, plán 8. Z pending přesuň REP-002, 006, 007, 008, 009.

- [ ] **Step 1: Napiš testy**

```ts
test('[REP-008] scénář 2026: fakturováno 44 100,00 Kč', ...) // 12 100 + 25 000 - 2 500 + 5 000 + 3 000 + 1 500
test('[REP-006] bez importovaných je fakturováno 42 600,00 a příjmy 40 150,00 Kč', ...)
test('[REP-009] příjmy 41 650,00 Kč', ...) // 12 100 + 22 050 + 5 000 + 1 000 + 1 500, 900 EUR × 24,5 = 22 050
test('[REP-007] storno 7 777,00 a koncept 8 888,00 se nikde nepočítají', ...)
test('[CRN-003] oprava -100,00 EUR sníží duben o 2 500,00 Kč a březen zůstane 25 000,00', ...)
test('[ADV-005] úhrada zálohy je příjem v květnu jednou a konečná faktura ho nezvýší', ...)
test('[ADV-005] uhrazená záloha bez konečné faktury je příjem a není fakturováno', ...)
test('[ADV-007] neuhrazená záloha 2 000,00 má vlastní řádek a není v pohledávkách ani po splatnosti', ...)
test('[REP-008] konečná faktura po částečné záloze má v pohledávkách jen doplatek', ...) // 5 000,00 - 2 000,00 = 3 000,00
test('[REP-009] v EUR je fakturováno 900,00 a příjmy 900,00 bez převodu', ...)
test('[REP-009] 0,01 EUR dvakrát při 24,380000 dá 0,48 Kč, zaokrouhluje se po dokladech', ...)
test('[REP-009] -1 234,56 EUR při 25,320000 dá -31 259,06 Kč v SQL i v documentCzkMinor', ...)
test('[REP-009] platba bez kurzu vezme lístek do 7 dnů zpět a jinak je v unconverted s částkou', ...)
test('[FOR-008] doklad bez kurzu se nesečte mlčky a přehled uvede počet i měnu', ...)
test('[REP-002] scénář: 2 000,00 v pásmu 31–60 po 48 dnech', ...) // splatnost 15. 9., dnes 2. 11.
test('[REP-002] dnes 2. 11.: splatnost 3. 10. je 0–30, 2. 10. je 31–60, 3. 9. je 31–60, 2. 9. je 61–90, 4. 8. je 61–90, 3. 8. je 90+', ...)
test('[REP-002] splatnost dnes je ve splatnosti a součet čtyř pásem je overdueMinor', ...)
test('vrácení -1 500,00 v červnu sníží příjmy června a nezmění květen', ...)
test('řádek difference 0,40 Kč není příjem ani neposouvá dny do úhrady', ...)
test('přehled souhlasí s invoiceSummary pro každou měnu a období', ...)
test('medián 100, 200, 400, 1 000 je 300 a 0,01 s 0,02 dá 0,02', ...) // půl od nuly
test('dny do úhrady: 17 a 9 dní dají průměr 13', ...) // A: 15. 1. až 1. 2., G: 1. 6. až 10. 6.
test('31. 12. 2026 i 1. 1. 2027 jsou týden 2026-W53', ...)
test('březen 2026 má předchozí únor 2026 a loňský březen 2025', ...)
test('Q1 2026 má předchozí Q4 2025', ...)
test('10. až 19. 3. 2026 má předchozích 10 dní 28. 2. až 9. 3.', ...)
test('posledních 12 měsíců k 2. 11. 2026 je 3. 11. 2025 až 2. 11. 2026', ...)
test('29. 2. 2028 o rok zpět je 28. 2. 2027', ...)
test('předchozí období nikdy nepřekrývá období a končí den před ním', ...) // fast-check
test('fx_czk dává pro libovolnou částku a kurz totéž co toCzkMinor', ...) // fast-check
test('vadný vstup fx_czk vrátí NULL a nesrazí dotaz', ...)
test('cizí customerId ve filtru vrátí prázdný výsledek', ...)
test('platba cizího účtu spojená s vlastním dokladem se nepočítá', ...)
test('[TST-018] změněná částka platby, doklad bez kurzu ani posunutý souhrn kontrolou neprojde', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/report-period tests/unit/sql-functions.test.ts tests/backend/reports.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** funkce, přesun SQL výrazů, dotazy a kontrolu. Očekávané hodnoty v testech piš jako čísla z komentářů, nepočítej je kódem.
- [ ] **Step 4: Ověř:** stejné testy, pak `tests/backend/consistency.test.ts tests/backend/invoices-list.test.ts tests/backend/payments.test.ts tests/backend/customers.test.ts tests/backend/db.test.ts`, PASS. `pnpm run typecheck`, `timeout 170 pnpm run test:coverage-spec`. Mutace `report-period.ts` přes dočasnou konfiguraci s `vitest.configFile` na jeho testy, aspoň 90 %.
- [ ] **Step 5: Commit** `feat(reports): add report queries matching invoice documents`

---

### Task 2: Limity a předpověď příjmů

**Files:**
- Create: `drizzle/0039_report_preferences.sql`, `src/server/reports/turnover.ts`, `src/server/reports/forecast.ts`, `src/server/services/limit-alerts.ts`
- Modify: `src/server/db/schema/settings.ts`, `src/lib/preferences.ts`, `src/server/services/preferences.ts`, `src/lib/automation.ts`, `src/lib/notification-text.ts`, `src/components/settings/preferences-form.tsx`, `src/components/notifications/notification-bell.tsx`, `src/app/(app)/upozorneni/page.tsx`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/backend/reports-turnover.test.ts`, `tests/backend/reports-forecast.test.ts`, `tests/backend/preferences.test.ts`, `tests/unit/notification-text.test.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `reportSummary`, `occurrencesBetween`, `nextOccurrences`, `ruleOf`, `computeTotals`, `resolveRate`, `registerDerivedAlerts`
- Produces:
  - `turnover(q, ownerId, year, basis): { minor: number; unconverted }`
  - `limitStates(q, ownerId, year): { key: 'vat' | 'flat'; limitMinor; turnoverMinor; percent; level: 'ok' | 'warn' | 'high' | 'over' }[]`
  - `forecast(q, ownerId, today, months = 6): ForecastMonth[]` se sériemi `overdue`, `open`, `planned`, `plannedDrafts`, `advances`
  - preference `turnoverVatLimitMinor`, `turnoverFlatLimitMinor`, `turnoverBasis`

Migrace `--name report_preferences`, `merged` musí sloupce převzít. Spec: REP-003, REP-005, UI-011. Viz **[R-15]** až **[R-17]**.

Pravidla:
- Obrat v CZK přes `fx_czk`, základ `taxable` používá `coalesce(taxable_date, issue_date)`, základ `paid` příjmy z Task 1. Obojí je `type <> 'advance'`, `paid` je platbou i u zálohy.
- Procento je celé číslo v `BigInt`, porovnání prahu bez dělení: `obrat × 100 >= limit × práh`.
- Upozornění v `limit-alerts.ts`, vzor `payment-alerts.ts`, a modul se načítá na obou místech jako ostatní zdroje. Každé čtení zvonku je jeden dotaz, proto jen aktuální rok.
- Předpověď nic nezapisuje ani neplánuje. Výskyty bere `occurrencesBetween` až do konce horizontu, takže týdenní plán má v měsíci víc částek.
- Pole limitů v Nastavení jsou částky v Kč přes stávající `minor` vstup s textem, že jde o podklad. Základ je přepínač.
- Z partial odeber `UI-011`, z pending přesuň REP-003 a REP-005.

- [ ] **Step 1: Napiš testy**

```ts
test('[REP-005] obrat za rok jde podle DUZP a bez něj podle data vystavení', ...)
test('[REP-005] faktura z 3. 1. 2027 s DUZP 31. 12. 2026 patří do roku 2026', ...)
test('[REP-005] oprava obrat snižuje a záloha do něj nevstupuje', ...)
test('[REP-005] přepnutí na datum úhrady započte uhrazenou zálohu k datu platby', ...)
test('[REP-005] 1 599 999,99 je ok, 1 600 000,00 je 80 %, 1 899 999,99 je 80 %, 1 900 000,00 je 95 %, 2 000 000,01 je přes limit', ...)
test('[REP-005] vlastní limit 1 000 000,00 posune práh na 800 000,00', ...)
test('[REP-005] doklad v EUR vstupuje kurzem faktury', ...)
test('[REP-005] limity a základ jdou změnit v Nastavení', ...) // e2e
test('[UI-011] blížící se limit je v centru upozornění a storno dokladu ho stáhne', ...)
test('[UI-011] přechod z 80 na 95 % vytvoří nové upozornění', ...)
test('[REP-003] plán 1 000,00 Kč měsíčně, dnes 2. 11. 2026, dá šest měsíčních částek', ...)
test('[REP-003] po splatnosti 2 000,00 spadne do listopadu ve vlastní sérii', ...)
test('[REP-003] pozastavený plán, plán po konci a plán s vyčerpaným maxCount nic nepřidají', ...)
test('[REP-003] vystavený výskyt se nezapočte dvakrát', ...)
test('[REP-003] koncept z plánu je vlastní série a ruční koncept se nepočítá', ...)
test('[REP-003] plán v EUR bez kurzu je v unconverted', ...)
test('[REP-003] konečná faktura po záloze se počítá jen doplatkem', ...)
test('předpověď ani limity nevidí data cizího účtu', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/reports-turnover.test.ts tests/backend/reports-forecast.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** migraci, výpočty, upozornění a pole nastavení.
- [ ] **Step 4: Ověř:** stejné testy, pak `tests/backend/preferences.test.ts tests/backend/notifications.test.ts tests/unit/notification-text.test.ts`, PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test settings`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(reports): add turnover limits and income forecast`

---

### Task 3: Obal Chart a ověření knihovny

**Files:**
- Create: `src/components/charts/chart.tsx`, `src/components/charts/chart-spec.ts`, `src/components/charts/chart-table.tsx`
- Modify: `package.json`, `pnpm-lock.yaml`, `src/app/globals.css`, `tests/unit/contrast.test.ts`, `docs/superpowers/specs/2026-10-30-fakturan-design.md` (jen řádek kap. 24 a poslední věta ARC-006), `tests/spec-pending.txt`
- Test: `tests/unit/chart-spec.test.ts`, `tests/unit/contrast.test.ts`

**Interfaces:**
- Produces:
  - `ChartSpec = { kind: 'bar' | 'stacked_bar' | 'line' | 'area' | 'donut' | 'heatmap'; series: { key; label; token: ChartToken }[]; rows: { x: string; label: string; values: Record<string, number> }[]; format: ValueFormat; ariaLabel: string; ariaDescription?: string }`
  - `Chart({ spec, height? })`
  - `ChartToken = 'chart-1' | … | 'chart-5'`, `isChartToken(value)`

Spec: ARC-006, UI-005, UI-007, UI-008. Viz **[R-1]**, **[R-3]**, **[R-4]**.

Pravidla:
- `pnpm add --save-exact @tanstack/charts@1.1.0`. Přečti `docs/framework/react/adapter.md`, `docs/guides/ssr-and-hydration.md`, `accessibility.md`, `themes-and-styling.md` a `bundle-size-and-performance.md` v balíčku. Importuj jen přesné podcesty, `donut` z polárního vstupu.
- `ChartSpec` je čistá data bez funkcí. `initialWidth` je pevný, aby server a klient vykreslili stejné SVG.
- Barvy jdou jako `var(--chart-n)`, text a mřížka jako `currentColor`. Popisky os a nápovědy přes `formatMoney` a `formatNumber` z celých čísel.
- **Únikový bod [R-1]:** dočasná route vykreslí všech šest typů v `next start`. Nesmí dát chybu hydratace, porušení CSP ani chybu v konzoli a musí fungovat ve světlém i tmavém režimu. Když to nejde, přejdi na `recharts@3.10.1` beze změny `ChartSpec`. **Před commitem route smaž,** trvalý e2e test vzniká v Task 4 nad `/prehledy`.
- Test ověří, že mimo `src/components/charts/` nikdo knihovnu neimportuje.
- Přesuň z pending ARC-006. Řádek v kap. 24 nahraď rozhodnutím z **[R-1]**.

- [ ] **Step 1: Napiš testy**

```ts
test('[ARC-006] knihovna grafu je importovaná jen v src/components/charts', ...)
test('[ARC-006] ChartSpec jde serializovat a nemá funkce', ...)
test('[UI-008] každý graf vyžaduje ariaLabel a tabulka uvádí všechny hodnoty', ...)
test('[UI-005] tokeny chart-1 až chart-5 mají proti pozadí aspoň 3:1 ve světlém i tmavém režimu', ...)
test('popisek osy 1 234,56 Kč vzniká z celého čísla', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/chart-spec.test.ts tests/unit/contrast.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** obal, tabulku a tokeny, ověř únikový bod a dočasnou route smaž.
- [ ] **Step 4: Ověř:** stejné testy, `pnpm run typecheck`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test security-headers`.
- [ ] **Step 5: Ověř obraz** podle Global Constraints a zapiš výsledek do zprávy úkolu.
- [ ] **Step 6: Commit** `feat(charts): add Chart wrapper over TanStack Charts`

---

### Task 4: Stránka Statistiky, exporty a první cache

**Files:**
- Create: `src/lib/tabular.ts`, `src/lib/xlsx-writer.ts`, `src/lib/report-filter.ts`, `src/server/report-cache.ts`, `src/server/services/report-export.ts`, `src/app/(app)/prehledy/loading.tsx`, `src/app/(app)/prehledy/export/route.ts`, `src/components/reports/report-filter.tsx`, `src/components/reports/report-tabs.tsx`, `src/components/reports/report-table.tsx`, `src/components/reports/limits-card.tsx`, `src/components/reports/unconverted-note.tsx`, `tests/e2e/reports.spec.ts`, `tests/e2e/charts.spec.ts`
- Modify: `src/app/(app)/prehledy/page.tsx`, `src/components/nav.ts`, `src/server/services/reports.ts`, `src/server/services/audit-read.ts`, `src/server/audit/record.ts`, `src/lib/audit-labels.ts`, `src/lib/texts.ts`, `tests/e2e/shell.spec.ts`, `docs/superpowers/specs/2026-10-30-fakturan-design.md` (jen ARC-005), `tests/spec-pending.txt`
- Test: `tests/unit/tabular.test.ts`, `tests/unit/xlsx-writer.test.ts`, `tests/unit/report-filter.test.ts`, `tests/backend/report-export.test.ts`, `tests/backend/report-cache.test.ts`, `tests/backend/audit-read.test.ts`, `tests/e2e/reports.spec.ts`, `tests/e2e/charts.spec.ts`

**Interfaces:**
- Consumes: `reportSummary`, `agingBands`, `forecast`, `limitStates`, `Chart`, `accountTag`, `exportUser`
- Produces:
  - `parseReportFilter(params, today): ReportFilter & { tab: ReportTab; compare: CompareMode }`
  - `accountStamp(ownerId): string` v `services/reports.ts`, bez závislosti na Next
  - `cachedReport(userId, stamp, today, query): Promise<ReportBundle>`, první položka `use cache` s daty účtu
  - `buildSheet(report: ReportTab, bundle): Sheet`, `Sheet = { name; columns; rows: Cell[][] }`
  - `toCsv(sheet): string`, `toXlsx(sheet): Uint8Array`
  - `neutralizeCsvCell` v `tabular.ts`

Spec: REP-001, REP-002, REP-003, REP-004, ARC-005, UI-005, UI-007, UI-008, UI-009. Viz **[R-8]**, **[R-9]**, **[R-13]**, **[R-14]**.

Pravidla:
- Navigace zůstává „Statistiky“ na `/prehledy`, `planned: false`. Záložky v URL: `fakturace`, `uhrady`, `pohledavky`, `zakaznici`, `polozky`, `meny`, `limity`, `predpoved`. Parametry `od`, `do`, `obdobi`, `porovnani`, `mena`, `importovane`. Neplatná hodnota se zahodí, vzor `parseInvoiceFilter`.
- Statický shell, data v `Suspense` podle ARC-005. Komponenta přečte session, `accountStamp` a `today` mimo cache a volá `cachedReport`. `query` je kanonický JSON filtru. Cache má `cacheLife('hours')`.
- `report-cache.ts` je jediné místo s `use cache` a importem `next/cache`. Jádro zůstává bez Next (ARC-001).
- Pohledávky ukazují pásma, řádek neuhrazených záloh a odkaz do seznamu faktur. Limity ukazují obě hranice, základ a větu o podkladu. Položky mají vyrovnávací řádek **[R-10]**.
- Prázdný stav vede na novou fakturu. Tabulky na telefonu scrollují uvnitř kontejneru.
- Export je `POST` s kontrolou origin, `RATE_RULES.exportUser` a auditem `report.export`, vzor `nastaveni/historie/export/route.ts`. Filtr se čte z formuláře. Název souboru `statistiky-<zalozka>-<od>-<do>.csv` je z pevných hodnot. Export počítá přímo přes službu, ne přes cache.
- `tests/e2e/charts.spec.ts` ověřuje typy grafů z Task 3 nad skutečnou stránkou.
- Do ARC-005 přidej větu z **[R-14]**. `audit-read.test.ts` dál hlídá tvar položky a test nesmí být oslabený.
- Přesuň z pending REP-001, REP-004 a ARC-005. REP-002 a REP-003 už mají testy z dřívějška, e2e je jen doplní.

- [ ] **Step 1: Napiš testy**

```ts
test('[REP-001] Statistiky ukazují všech šest přehledů a filtr období s porovnáním', ...) // e2e
test('[REP-001] porovnání s minulým rokem ukáže hodnotu i rozdíl', ...) // e2e
test('[REP-004] CSV má BOM, středník, desetinnou čárku a částku -2 500,00 jako číslo', ...)
test('[REP-004] XLSX po rozbalení obsahuje list, typy buněk a shodné hodnoty', ...)
test('[REP-004] text =1+1, +cmd, -2+3 a @SUM se neutralizuje v CSV i XLSX, záporná částka ne', ...)
test('[REP-004] export každého přehledu jde stáhnout', ...) // e2e
test('[REP-004] cizí origin dostane 403 a překročený limit 429', ...)
test('[ARC-005] accountStamp se změní po mutaci z webu i z plánovače', ...)
test('[ARC-005] mutace účtu A nezmění razítko účtu B', ...)
test('[ARC-005] nový lístek ČNB změní razítko všem účtům', ...)
test('[ARC-005] dva účty se stejným obdobím vidí každý své číslo', ...) // e2e, next start
test('[ARC-005] platba se v Statistikách projeví hned po návratu ze stránky faktury', ...) // e2e, hlídá i klientský router
test('[UI-005] graf je čitelný ve světlém i tmavém režimu bez chyby v konzoli', ...) // e2e
test('[UI-008] záložky a filtr jdou ovládat klávesnicí a graf má tabulku hodnot', ...) // e2e
test('[UI-007] na šířce 390 px stránka nepřetéká', ...) // e2e
test('[UI-009] účet bez dokladů vidí prázdný stav s akcí', ...) // e2e
test('[REP-002] pohledávky ukazují pásma a vlastní řádek záloh', ...) // e2e
test('neplatné parametry filtru nespadnou a použijí výchozí', ...)
test('statistiky po přepnutí na EUR neukazují CZK a nesčítají měny', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/tabular.test.ts tests/unit/xlsx-writer.test.ts tests/backend/report-cache.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** filtr, cache, stránku a export.
- [ ] **Step 4: Ověř:** stejné testy, pak `tests/backend/report-export.test.ts tests/backend/audit-read.test.ts tests/unit/report-filter.test.ts`, PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test reports`, `timeout 170 pnpm exec playwright test charts`, `timeout 170 pnpm exec playwright test shell`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(reports): add statistics page with exports and cache`

---

### Task 5: Model dashboardu a překladač widgetů

**Files:**
- Create: `drizzle/0040_dashboard.sql`, `src/server/db/schema/dashboard.ts`, `src/lib/widget-config.ts`, `src/lib/dashboard-defaults.ts`, `src/lib/dashboard-layout.ts`, `src/server/reports/widget-query.ts`, `src/server/services/dashboards.ts`, `src/server/services/widgets.ts`
- Modify: `src/server/db/schema/index.ts`, `src/server/services/users.ts`, `src/server/audit/record.ts`, `src/server/rate-limit.ts`, `src/lib/audit-labels.ts`, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/unit/widget-config.test.ts`, `tests/unit/dashboard-layout.test.ts`, `tests/unit/dashboard-layout.property.test.ts`, `tests/backend/widget-query.test.ts`, `tests/backend/dashboards.test.ts`, `tests/backend/users.test.ts`

**Interfaces:**
- Consumes: jádro Task 1, `resolvePeriod`, `previousRange`, `bucketsBetween`, `scoped`, `mutate`
- Produces:
  - `widgetConfigSchema`, `parseWidgetConfig(raw): WidgetConfig`, `WIDGET_CONFIG_VERSION`, `SOURCE_FIELDS`
  - `runWidget(q, ownerId, config, context: { today; globalFilter? }): WidgetResult`
  - `WidgetResult = { kind; series; rows; total; compare?; range; unconverted }`
  - `ensureDashboards(actor): Dashboard[]`, `listDashboards(ownerId)`, `getDashboard(ownerId, id)`
  - `createDashboard`, `renameDashboard`, `duplicateDashboard`, `deleteDashboard`, `setDefaultDashboard`
  - `addWidget`, `updateWidget`, `removeWidget`, `saveLayout(actor, { id; revision; items })`
  - `normalizeWidgets(widgets): WidgetDraft[]`, `moveWidget`, `resizeWidget`, `compactLayout`
  - `WIDGET_GALLERY`, `DEFAULT_DASHBOARD`
  - `RATE_RULES.widgetPreviewUser = rule('widgetPreviewUser', 120, 60)`

`dashboard`: `id`, `user_id`, `name`, `is_default`, `position`, `revision`, `created_at`, `updated_at`. `dashboard_widget`: `id`, `dashboard_id` s kaskádou, `user_id`, `config` (JSON), `x`, `y`, `w`, `h`, `created_at`, `updated_at`. Mřížka má 12 sloupců. Migrace `--name dashboard`.

Spec: DSH-002 **[částečně]**, DSH-003, DSH-010 až 013, DSH-015, DSH-018, TST-009. Viz **[R-12]**, **[R-18]**, **[R-19]**, **[R-20]**, **[R-24]**.

Pravidla:
- `widgetConfigSchema` je `z.strictObject` na každé úrovni, `kind` je diskriminátor a `superRefine` kontroluje tabulku `SOURCE_FIELDS`: zdroj, metrika, seskupení a filtry musí být povolené, `median` a `days_to_pay` jen tam, kde dávají smysl, `heatmap` vyžaduje `groupBy: 'day'`, `cumulative` jen `line` a `area`, `stacked_bar` vyžaduje `splitBy`.
- `widget-query.ts` má pro každý zdroj mapu výčet → výraz Drizzle. Žádná hodnota z JSON se nestane názvem sloupce ani částí `sql.raw`. Hodnoty filtrů jsou parametry.
- Zdroje: `invoices`, `lines`, `payments`, `customers`. Metriky: `sum`, `count`, `avg`, `median`, `min`, `max`, `days_to_pay`. Míry dokladů: `invoiced`, `outstanding`, `overdue`. Podmínky měr jsou shodné s **[R-7]** a čísla shodná s jádrem Task 1, test porovnává.
- Seskupení `day`, `week`, `month`, `quarter`, `year` přes `date_bucket`, `customer`, `item`, `currency`, `status`, `type`. Časové koše doplní `bucketsBetween`. U `topN` řádek „Ostatní“ **[R-24]**.
- Filtry: `status`, `customerIds`, `currency`, `type`, `includeExternal`, `period`. Výchozí `includeExternal` je `true` (REP-006). Statusy nikdy nepustí `draft` ani `cancelled` do částek.
- Výsledek `compare` spočte stejný dotaz nad `previousRange`. Zdroj `customers` používá `prague_date(created_at)`.
- Systémové widgety má `runWidget` v registru `systemId → funkce`, kterou plní Task 6. V tomto úkolu vyhodí pro neregistrované ID `ServiceError`.
- `USER_OWNED_TABLES` dostane `dashboardWidget` a za ním `dashboard`. Test schématu v `users.test.ts` chybějící tabulku odhalí.
- `ensureDashboards` vloží přes `onConflictDoNothing` nad `dashboard_default_idx`. Kdo prohrál souběh, jen přečte. Nedělá audit bez změny.
- Přesuň z pending DSH-003, DSH-010 až 013, DSH-015, DSH-018. `DSH-002` jde do partial s důvodem „chybí UI“, plán 7. `TST-009` přepiš na „Matice nemá roli administrátora ani entity plánu 8“, plán 8.

- [ ] **Step 1: Napiš testy**

```ts
test('[DSH-018] neznámý klíč, kind nebo verze je odmítnutá s cestou v JSON', ...)
test('[DSH-018] groupBy "1; DROP TABLE invoice" neprojde schématem', ...)
test('[DSH-018] schéma nezná pole pro kód, SQL ani vlastní výraz', ...)
test('[DSH-018] každý dotaz má podmínku účtu i bez filtrů', ...) // kontrola vygenerovaného SQL a výsledek nad dvěma účty
test('[DSH-010] každý zdroj dává výsledek nad scénářem z Task 1', ...)
test('[DSH-011] součet 44 100,00, počet 6, medián, minimum, maximum a dny do úhrady souhlasí', ...) // počet: A, B, oprava, C, E, G
test('[DSH-012] seskupení podle měsíce má 12 košů včetně prázdných a součet 44 100,00', ...)
test('[DSH-012] seskupení podle zákazníka, položky, měny, stavu a typu dává stejný součet', ...)
test('[DSH-013] letos, posledních 12 měsíců, absolutní období, stav, měna a typ filtrují správně', ...)
test('[DSH-013] vyloučení importovaných dá 42 600,00', ...)
test('[DSH-015] porovnání vrátí hodnotu předchozího období a rozdíl', ...)
test('[DSH-015] meziroční porovnání jde po měsících', ...)
test('[DSH-003] nový účet dostane jeden výchozí dashboard i při dvou souběžných voláních', ...)
test('[DSH-002] dashboard jde založit, přejmenovat, duplikovat a smazat', ...)
test('[DSH-002] smazání výchozího přenese příznak a poslední smazat nejde', ...)
test('widget s období 11 let nebo denními koši nad 400 je odmítnutý', ...)
test('topN 3 má řádek Ostatní a součet se nezmění', ...)
test('dotazy používají indexy podle EXPLAIN QUERY PLAN', ...)
test('saveLayout se starou revizí nic nezmění', ...)
test('posun widgetu mimo mřížku je omezený a nikdy se nepřekrývají', ...) // fast-check
test('karta due_alerts nejde odebrat a normalizeWidgets ji doplní', ...)
test('[TST-009] cizí dashboard i widget nejde číst, měnit ani smazat', ...) // assertIsolated
test('[TST-009] filtr s cizím customerId nevrátí žádné částky', ...)
test('[ADM-006] smazání účtu odstraní dashboardy a widgety', ...)
test('[AUD-001] změny dashboardu a widgetu jsou v auditu', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/widget-config.test.ts tests/unit/dashboard-layout tests/backend/widget-query.test.ts tests/backend/dashboards.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, překladač a službu.
- [ ] **Step 4: Ověř:** stejné testy, pak `tests/backend/users.test.ts tests/backend/actions-isolation.test.ts tests/backend/audit.test.ts tests/backend/scoped.test.ts`, PASS, `pnpm run typecheck`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(dashboard): add dashboard model and widget query compiler`

---

### Task 6: Přehled z widgetů

**Files:**
- Create: `src/server/reports/system-widgets.ts`, `src/components/dashboard/dashboard-grid.tsx`, `src/components/dashboard/dashboard-filter.tsx`, `src/components/dashboard/dashboard-switcher.tsx`, `src/components/dashboard/widget-card.tsx`, `src/components/dashboard/widget-body.tsx`, `src/components/dashboard/widget-error.tsx`, `src/components/dashboard/widget-number.tsx`, `src/components/dashboard/system/*.tsx`, `src/lib/dashboard-filter.ts`, `tests/e2e/dashboard.spec.ts`
- Modify: `src/app/(app)/page.tsx`, `src/server/report-cache.ts`, `src/components/overview/due-alerts.tsx`, `src/server/reports/widget-query.ts`, `src/lib/texts.ts`, `tests/e2e/reminders.spec.ts`, `tests/e2e/shell.spec.ts`, `tests/e2e/onboarding.spec.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/unit/dashboard-filter.test.ts`, `tests/backend/system-widgets.test.ts`, `tests/backend/dashboards.test.ts`, `tests/e2e/dashboard.spec.ts`, `tests/e2e/reminders.spec.ts`

**Interfaces:**
- Consumes: `runWidget`, `ensureDashboards`, `dueAlerts`, `listNotices`, `noticeCounts`, `listRecurring`, `automationImpact`, `getAutomation`, `forecast`, `limitStates`, `agingBands`, `Chart`
- Produces:
  - `registerSystemWidgets` v `system-widgets.ts`, ID z **[R-22]**
  - `cachedWidget(userId, stamp, today, query): Promise<WidgetResult>`
  - `parseDashboardFilter(params, today): GlobalFilter`
  - `DashboardGrid({ dashboard, filter })`, `WidgetCard`

Spec: DSH-004, DSH-005, DSH-014, DSH-020, REM-009, UI-005, UI-007, UI-009. Viz **[R-2]**, **[R-20]** až **[R-22]**.

Pravidla:
- Přehled: nadpis, onboarding jako dnes, přepínač dashboardů, filtr, mřížka. `EmptyState` se odebere, texty `overview.empty*` a `overview.action` se smažou, prázdný stav má každý widget zvlášť a odkazuje na další akci.
- `DashboardGrid` je server komponenta s CSS mřížkou o 12 sloupcích. Od `md` používá `x`, `y`, `w`, `h`, pod ní jeden sloupec seřazený podle `y` a `x`.
- Každý widget má vlastní `Suspense` a chybovou hranici. Poškozený uložený JSON nebo výjimka ukáže `widget-error` a jde do `reportFailure`, ostatní widgety běží.
- `DueAlerts` dostane limit řádků z parametru widgetu. Komponenta i dotaz zůstávají, `tests/e2e/reminders.spec.ts` musí projít beze změny záměru.
- `unmatched_payments` používá `listNotices`, `open_advances` součet `advanceOpenMinor`, `automation_status` stav hlavního vypínače a další termíny bez údajů o zákaznících navíc, `upcoming_recurring` `listRecurring` s `nextIssueDate`.
- Číslo a číslo s porovnáním jsou textové, procento rozdílu se počítá v celých číslech a u nulového základu se neukazuje. Tabulka používá `Table`, grafy `Chart`. `unconverted` se ukazuje u všech zobrazení.
- Přesuň z pending DSH-004, DSH-005, DSH-014, DSH-020. `DSH-001` zůstává v pending, protože zatím nemá test.

- [ ] **Step 1: Napiš testy**

```ts
test('[DSH-020] galerie obsahuje všech 20 názvů ze spec a každý widget vrátí výsledek', ...)
test('[DSH-014] všech devět zobrazení se vykreslí z jednoho výsledku', ...) // e2e
test('[DSH-005] globální filtr změní období i měnu a widget ukáže skutečné období', ...) // e2e
test('[DSH-005] parametry filtru se po neplatné hodnotě zahodí', ...)
test('[DSH-004] na šířce 390 px jsou widgety pod sebou a RGL se nenačte', ...) // e2e
test('[REM-009] výchozí Přehled ukazuje po splatnosti a blížící se splatnost', ...) // e2e
test('[REM-009] karta je na novém i duplikovaném dashboardu a nejde odebrat', ...)
test('[UI-009] nový účet vidí výchozí dashboard s prázdnými stavy a akcí', ...) // e2e
test('[UI-005] Přehled nemá chybu v konzoli ve světlém ani tmavém režimu', ...) // e2e
test('stejná čísla jako Statistiky pro fakturováno, příjmy a pohledávky', ...) // e2e nad scénářem
test('poškozený config v databázi shodí jen svůj widget', ...) // e2e
test('widget záloh ukazuje advanceOpenMinor a pohledávky ho nepočítají', ...)
test('nespárované platby widget ukazuje jen vlastní avíza', ...)
test('stav automatiky ukáže pauzu hlavního vypínače', ...)
test('cachedWidget je oddělený podle účtu', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/dashboard-filter.test.ts tests/backend/system-widgets.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** systémové widgety a čtení Přehledu.
- [ ] **Step 4: Ověř:** stejné testy, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test dashboard`, pak zvlášť `reminders`, `shell`, `onboarding`, `smoke`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(dashboard): show widgets on overview`

---

### Task 7: Úpravy dashboardu a konfigurátor

**Files:**
- Create: `src/app/(app)/dashboardy/actions.ts`, `src/app/(app)/dashboardy/[id]/upravit/page.tsx`, `src/app/(app)/dashboardy/[id]/widget/[widgetId]/page.tsx`, `src/components/dashboard/dashboard-editor.tsx`, `src/components/dashboard/grid-editor.tsx`, `src/components/dashboard/layout-buttons.tsx`, `src/components/dashboard/widget-configurator.tsx`, `src/components/dashboard/widget-gallery.tsx`, `src/components/dashboard/widget-preview.tsx`, `src/components/dashboard/dashboard-dialogs.tsx`, `tests/e2e/dashboard-edit.spec.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `src/app/globals.css`, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/backend/dashboards.test.ts`, `tests/backend/actions-isolation.test.ts`, `tests/e2e/dashboard-edit.spec.ts`

**Interfaces:**
- Consumes: služby Task 5, `runWidget`, `moveWidget`, `resizeWidget`, `widgetPreviewUser`, `Chart`
- Produces:
  - actions `createDashboardAction`, `renameDashboardAction`, `duplicateDashboardAction`, `deleteDashboardAction`, `setDefaultDashboardAction`, `saveLayoutAction`, `addWidgetAction`, `updateWidgetAction`, `removeWidgetAction`, `previewWidgetAction`
  - `GridEditor({ dashboard, widgets })`

Spec: DSH-001, DSH-002, DSH-016, DSH-017, UI-003, UI-008. Viz **[R-2]**, **[R-4]**, **[R-20]**, **[R-26]**.

Pravidla:
- `pnpm add --save-exact react-grid-layout@2.3.0`. `GridEditor` jde přes `next/dynamic` s `ssr: false`, šířka přes `useContainerWidth`. Styl knihovny importuj a její barvy přepiš tokeny, ať neporuší UI-003.
- Režim úprav je jen od šířky `md`, na telefonu Přehled nabídne jen čtení.
- Rozložení se ukládá tlačítkem Uložit, s varováním při odchodu. Každé tlačítko posunu mění stejný stav jako tažení a hlásí změnu přes `aria-live` **[R-2]**.
- Karta `due_alerts` nemá akci odebrat **[R-20]**.
- Konfigurátor nabízí jen volby povolené `SOURCE_FIELDS`, po změně zdroje neplatné volby zahodí. Náhled s prodlevou 300 ms a `ticket` proti pozdní odpovědi, vzor `customerTicket`. `previewWidgetAction` jede bez `cache`, s rate limitem a jen nad daty přihlášeného účtu. Barva je volba tokenu, formát čísla výčet.
- Akce dashboardu po zápisu volají `updateTag(accountTag(userId))` a `revalidatePath('/')`. Akce vrací `Reply`, vzor `platby/actions.ts`.
- Přesuň z pending DSH-001, DSH-016 a DSH-017. `DSH-002` odeber z partial.

- [ ] **Step 1: Napiš testy**

```ts
test('[DSH-001] widget jde přetáhnout, zvětšit a po obnovení zůstane na místě', ...) // e2e
test('[DSH-001] stará revize rozložení je odmítnutá', ...)
test('[UI-008] rozložení jde změnit jen klávesnicí a změna se oznámí', ...) // e2e
test('[DSH-002] druhý dashboard jde přejmenovat, duplikovat, nastavit výchozí a smazat', ...) // e2e
test('[DSH-016] název, barva, popisky a formát čísla se projeví', ...) // e2e
test('[DSH-016] barva je token a hodnota mimo výčet je odmítnutá', ...)
test('[DSH-017] změna metriky se ukáže v náhledu bez uložení', ...) // e2e
test('[DSH-017] pozdní odpověď staršího náhledu se zahodí', ...) // e2e
test('[DSH-017] překročený limit náhledu vrátí chybu a nespadne', ...)
test('konfigurátor nenabídne neplatnou kombinaci', ...) // e2e
test('[REM-009] karta REM-009 nemá v úpravách akci odebrat', ...) // e2e
test('[TST-009] akce dashboardu odmítnou cizí ID a neplatnou session', ...)
test('[UI-007] na telefonu chybí vstup do úprav a Přehled jde číst', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/actions-isolation.test.ts tests/backend/dashboards.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** akce, editor a konfigurátor.
- [ ] **Step 4: Ověř:** stejné testy, `pnpm run typecheck`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test dashboard-edit`, `timeout 170 pnpm exec playwright test dashboard.spec`, `timeout 170 pnpm exec playwright test security-headers`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Ověř obraz** podle Global Constraints a zapiš výsledek do zprávy úkolu.
- [ ] **Step 6: Commit** `feat(dashboard): add grid editor and widget configurator`

---

### Task 8: Sdílení JSON a uzavření plánu

**Files:**
- Create: `src/lib/dashboard-share.ts`, `src/app/(app)/dashboardy/[id]/export/route.ts`, `src/app/(app)/dashboardy/[id]/widget/[widgetId]/export/route.ts`, `src/components/dashboard/import-dialog.tsx`, `tests/fixtures/dashboards/platny.json`, `tests/fixtures/dashboards/neplatne/*.json`, `tests/e2e/dashboard-share.spec.ts`, `tests/unit/source-rules.test.ts`
- Modify: `src/server/services/dashboards.ts`, `src/app/(app)/dashboardy/actions.ts`, `src/components/dashboard/dashboard-editor.tsx`, `src/lib/texts.ts`, `tests/e2e/onboarding.spec.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/unit/dashboard-share.test.ts`, `tests/unit/source-rules.test.ts`, `tests/backend/dashboards.test.ts`, `tests/e2e/dashboard-share.spec.ts`, `tests/e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: `widgetConfigSchema`, `normalizeWidgets`, `addWidget`, `runWidget`, `exportUser`
- Produces:
  - `exportDashboard(ownerId, id): DashboardFile`, `exportWidget(ownerId, dashboardId, widgetId): DashboardFile`
  - `parseDashboardFile(text: string): { ok: true; file: DashboardFile } | { ok: false; path: string; message: string }`
  - `previewImport(actor, text): ImportPreview`, `importDashboard(actor, text): { id: string }`
  - actions `previewImportAction`, `importDashboardAction`

Spec: DSH-030, DSH-031, DSH-032, ARC-001, UI-003, SET-002, TST-001, TST-002, TST-009. Viz **[R-20]**, **[R-25]**, **[R-27]**.

Pravidla:
- `parseDashboardFile` je čistá. Kontroluje velikost před `JSON.parse`, `format`, verzi, počet widgetů a každý widget přes `widgetConfigSchema`. Chyba Zod se přeloží na česky psanou zprávu s cestou, například `widgets[3].groupBy`. Vyšší verze má vlastní hlášku.
- `previewImport` nic nezapisuje a vrací název, seznam widgetů a výsledky `runWidget`. `importDashboard` soubor znovu ověří, serverová kontrola neběží jen v náhledu. Vzniká nový dashboard, název dostane příponu při kolizi a `normalizeWidgets` doplní `due_alerts`. Soubor s ID filtrů cizího účtu projde, filtr se zahodí a náhled to řekne **[R-25]**.
- Widget z importu nese `kind` jen podle schématu, neznámý `systemId` je chyba.
- Export je `POST`, s kontrolou origin a `exportUser`, stejně jako v Task 4. Soubor neobsahuje `id`, `user_id`, čísla ani výsledky.
- `tests/unit/source-rules.test.ts` nese strukturní pravidla: `[ARC-001]` služby a `src/server/reports` neimportují `next/*`, `[UI-003]` `src/components` a `src/app` nemají natvrdo barvy ani třídy palety Tailwindu. Výjimka je `src/components/settings/design-picker.tsx`, kde jde o tokeny faktury (UI-004).
- `[SET-002]` e2e: nový účet bez údajů dodavatele vidí na Přehledu onboarding a při vystavení výčet chybějících polí. Pak ID z partial odeber.
- Přesuň z pending DSH-030 až 032, ARC-001, UI-003. Pending po plánu obsahuje jen EXP, IMP, TAX, TST-019, TST-020, UI-002, UI-010 a UI-012.
- V kap. 14 ani 15 spec neměň nic mimo řádky, které určují Task 3 a 4.

- [ ] **Step 1: Napiš testy**

```ts
test('[DSH-030] export dashboardu a widgetu je JSON bez ID, účtu, zákazníků a čísel', ...)
test('[DSH-030] export zahodí customerIds a itemIds', ...)
test('[DSH-031] rozbitý JSON, cizí formát, vyšší verze, 51 widgetů a soubor nad 64 KiB mají konkrétní chybu', ...)
test('[DSH-031] neplatný widget uvede cestu widgets[3].groupBy a nic nezmění', ...)
test('[DSH-031] neznámý systemId a pole s kódem jsou odmítnuté', ...)
test('[DSH-032] náhled nezapíše nic a ukáže widgety nad vlastními daty', ...)
test('[DSH-032] soubor nenese data a import založí nový dashboard', ...)
test('[DSH-032] po importu je na dashboardu karta due_alerts', ...)
test('[DSH-032] export z účtu A a import do účtu B ukáže jen data B', ...) // e2e
test('přizpůsobení dashboardu a import JSON od začátku do konce', ...) // e2e, kritický tok TST-004
test('[ARC-001] služby a jádro přehledů neimportují next', ...)
test('[UI-003] komponenty nemají natvrdo barvy', ...)
test('[SET-002] nový účet vidí v UI, co doplnit před vystavením', ...) // e2e
test('[TST-009] import ani export neprojde s cizím ID', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/dashboard-share.test.ts tests/unit/source-rules.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** sdílení a oprav nálezy strukturních testů v kódu.
- [ ] **Step 4: Ověř po částech:** `timeout 170 pnpm exec vitest run --project unit`, pak `timeout 170 pnpm exec vitest run --project backend --shard=N/4` pro N = 1 až 4, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`.
- [ ] **Step 5: Ověř e2e po souborech:** `timeout 170 pnpm build` a pro každý soubor v `tests/e2e` zvlášť `timeout 170 pnpm exec playwright test <soubor>`, kromě `docker-*`. Kontrola `assertConsistent` s přehledy běží po každém toku.
- [ ] **Step 6: Ověř obraz** podle Global Constraints.
- [ ] **Step 7: Uzavři:** uprav `tests/spec-pending.txt` a `tests/spec-partial.txt`, `timeout 170 pnpm run test:coverage-spec`, PASS. Mutace `report-period.ts`, `dashboard-layout.ts`, `xlsx-writer.ts`, `tabular.ts` přes dočasnou konfiguraci, každý aspoň 90 %.
- [ ] **Step 8: Commit** `feat(dashboard): add JSON sharing and close plan 7`

---

## Sebekontrola proti spec

| Oblast | Úkol | Poznámka |
|---|---|---|
| DSH-001, 002 | 5, 7 | Model, tažení **[R-2]**, **[R-26]** |
| DSH-003 | 5 | Líně **[R-19]** |
| DSH-004, 005 | 6 | CSS mřížka, filtr v URL **[R-21]** |
| DSH-010 až 013, 015, 018 | 5 | Překladač **[R-18]**, meze **[R-24]** |
| DSH-014, 020 | 6 | Galerie **[R-22]** |
| DSH-016, 017 | 7 | Tokeny **[R-4]** |
| DSH-030 až 032 | 8 | **[R-25]** |
| REP-001, 004 | 4 | **[R-13]** |
| REP-002, 006 až 009 | 1, 4 | **[R-6]** až **[R-11]** |
| REP-003, 005 | 2, 4 | **[R-15]** až **[R-17]** |
| ARC-005 | 4, 6 | Razítko a tag, odchylka **[R-14]** |
| ARC-006, kap. 24 | 3 | **[R-1]**, **[R-3]** |
| ARC-001, UI-003 | 8 | Strukturní testy **[R-27]** |
| UI-001, 006 | všechny | Tokeny a `TEXTS` |
| UI-004 | 8 | Výjimka `design-picker` |
| UI-005, 007, 008, 009 | 3, 4, 6, 7 | Tmavý režim, telefon, klávesnice, prázdné stavy |
| UI-010 | – | Plán 9 **[R-27]** |
| UI-011 | 2 | Limity, uzavřeno **[R-16]** |
| CRN-003, FOR-008, ADV-007, TST-018 | 1 | Odeberou se z partial |
| ADV-005 | 1 | Partial zůstává kvůli TAX, plán 8 |
| TST-009 | 5, 7, 8 | Partial zůstává kvůli plánu 8 |
| SET-002 | 8 | Partial mířil na plán 7 |
| Přenos z plánu 3 a 4 (ARC-005) | 4 | První `use cache` s daty účtu |
| Přenos z plánu 4 | 6 | `dueAlerts` jako widget, termíny, stav automatiky, REM-009 **[R-20]** |
| Přenos z plánu 5 | 1, 6 | `listNotices`, `kind = 'payment'`, `difference` |
| Přenos z plánu 6 | 1, 2, 6 | `documentCzkMinor`, `paymentCzkMinor`, `rate_micros = null`, limity, `advanceOpenMinor`, `dueSql` |

## Přenos do dalších plánů

- **Plán 8:** TAX staví na `src/server/reports/queries.ts`, příjmy a znaménka vrácení jsou hotové, zbývá rok zálohy a výstupy. `xlsx-writer.ts` a `tabular.ts` rozšířit pro EXP-001 a IMP místo nové knihovny. Záloha účtu a IMP-010 musí nést `dashboard`, `dashboard_widget` a nové preference. Import musí zachovat `exchange_rate_micros`, jinak doklady skončí v `unconverted`. Filtr `includeExternal` dostane reálná data až z importu. UI-011 je hotové, bod z přenosů plánů 4 a 5 odpadá. `TST-009` a `ADV-005` uzavřít.
- **Plán 9:** UI-010, UI-012 a UI-002. Sledovat velikost `use cache` v paměti (`cacheMaxMemorySize`). Přidat statistiky a dashboard do dokumentace.
- **Daňový poradce:** výchozí limity 2 000 000,00 Kč pro DPH a paušální daň, obrat podle DUZP a základ podle úhrady **[R-15]**. Do uzavření zůstávají v UI jako podklad.
- **Ruční ověření:** soubor XLSX otevřít jednou ve skutečném Excelu a LibreOffice **[R-13]**, testy kontrolují jen rozbalený obsah.
- **Známá rizika:** řada TanStack Charts 1.x je stará měsíc. Na GitHubu jsou otevřené chyby tisku (šířka grafu po změně velikosti) a tooltipu vlastního těla **[R-1]**, tisk grafů proto není v rozsahu tohoto plánu. Přechod na novější verzi je ruční změna přesné verze. Razítko se změní každou mutací účtu, včetně nesouvisejících, takže účet s častým zápisem má nižší zásah cache, což je cena za jistotu **[R-14]**. Zápis mimo `mutate` razítko nezmění, dnes se to týká jen provozních tabulek bez vlivu na přehledy. Kdyby přibyl účetní zápis mimo `mutate`, přehled by zůstal zastaralý do další mutace. Přepočet plateb bez kurzu čte lístek do 7 dnů, starší díra zůstane v `unconverted` **[R-9]**. Registrované SQL funkce běží na každém řádku v JS, u desítek tisíc dokladů je potřeba změřit **[R-24]**.
