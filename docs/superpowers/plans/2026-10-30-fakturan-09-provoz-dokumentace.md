# Fakturan 9: Bezpečnost obnovy, souhrny, HTML e-maily, provoz a dokumentace – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Obnova zálohy už žádným archivem neshodí ani nevyčerpá instanci a velký účet jde zálohovat i obnovit. Uživatel dostane volitelný měsíční nebo čtvrtletní souhrn, lednovou připomínku k daním a upozornění na limit DPH. Klient dostává HTML e-mail v jednom ze sedmi vzhledů s QR v příloze CID. Aplikace má rychlé hledání Ctrl+K, úplné mutační testy jádra, provozní monitoring, ukázkovou instanci a dokumentaci. Posledním úkolem je záložka Nápověda.

**Architecture:** Obnova přestane držet řádky v paměti. Řádek se ověří, přemapuje na místě a zapíše do mezisouboru své tabulky, commit čte mezisoubory po řádcích uvnitř jediné `mutate`. Hlídač haldy v `eachLine` odmítne archiv dřív, než proces dojde k limitu **[R-1]** až **[R-4]**. Souhrny pro vlastníka jsou nová úloha `user.report` vedle denního přehledu a čtou jen jádro `src/server/reports/` **[R-15]**. HTML e-mail skládá `src/server/mail/html/` z tabulek a tokenů na jednom místě. QR vzniká ze stejné funkce jako v PDF a archivuje se spolu s HTML, takže opakované doručení pošle tytéž bajty **[R-17]** až **[R-19]**.

**Tech Stack:** Next.js 16.4 (Cache Components), Drizzle, better-sqlite3, Zod, `fflate`, `nodemailer`, `@base-ui/react`, Vitest, fast-check, Playwright, Stryker 10. Žádná nová produkční závislost. HTML e-mailu se skládá bez šablonovací knihovny **[R-17]**.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`. Všechna ID z `tests/spec-pending.txt` (MAIL-009, MAIL-010, REM-010, REM-011, REM-012, UI-002, UI-010, UI-012) a z `tests/spec-partial.txt` s plánem 9 (TST-013, IMP-005). Dále IMP-010, IMP-011, EXP-006, ARC-005, ARC-007, ADM-008, MON-003, OPS-004, SEC-001, SEC-002, SEC-005, SEC-011, MAIL-006, MAIL-007, TST-004, TST-016, TST-017, TST-019, kap. 19.3, 19.5, 23 bod 9 a 24. Přenosy z `.superpowers/sdd/prenosy-plan-7.txt`, `.superpowers/sdd/prenosy-plan-8.txt` (s `plan8-final-review.md` a `plan8-re-review-final.md`) a z oddílů „Přenos do dalších plánů“ plánů 1 až 8. Poznámky uživatele z pauzy v `.superpowers/sdd/RESTART.md`, části 1 až 5, jsou závazné. Plán nesmí odporovat `.superpowers/sdd/rulings-do-teď.txt`.

## Global Constraints

- Správce balíčků je pnpm, práce probíhá na `main` od `706214f`. **Nic se nepushuje a nic se nenasazuje,** ani ukázková instance **[R-31]**. Nasazení dělá uživatel ručně a auto-deploy v Coolify není.
- **Provedení po blocích:** jeden implementer na blok, po bloku recenze, opravy uvnitř bloku. Implementeři neběží souběžně a každý úkol začíná z čistého stromu po commitu předchozího.
- **Každý příkaz v popředí běží nejvýš 170 s** (`timeout 170 …`). Na úlohu na pozadí se nikdy nečeká. Brány:
  - `timeout 170 pnpm exec vitest run --project unit`;
  - backend `timeout 170 pnpm exec vitest run --project backend --shard=N/4 --exclude tests/backend/pdf-designs.test.ts` pro N od 1 do 4, od Task 13 `--shard=N/6`. Shard, který se do limitu nevejde, se pustí po souborech podle `pnpm exec vitest list --project backend --shard=N/4 --filesOnly`;
  - `pdf-designs` po částech: `timeout 170 pnpm exec vitest run tests/backend/pdf-designs.test.ts -t "<describe>"` pro `registr designů`, `vizuální regrese`, `barvy vystaveného dokladu` a `náhled designu`;
  - `timeout 170 pnpm build` vždy před Playwrightem. Playwright jde po souborech: `timeout 170 pnpm exec playwright test <soubor>`;
  - Docker po vrstvách: `timeout 170 docker build --target deps .`, `--target build`, celý obraz `-t fakturan-ci`, pak `E2E_DOCKER_IMAGE=fakturan-ci timeout 170 pnpm exec playwright test docker-scheduler`. Krok, který se nevejde, se zapíše jako „Docker neověřen“ s příkazem;
  - `timeout 170 pnpm typecheck`, `timeout 170 pnpm lint`, `timeout 170 pnpm format:check` a `timeout 170 pnpm run test:coverage-spec` před každým commitem.
- Běh, který se nevejde ani po rozdělení, jde do zprávy úkolu jako „neověřeno“ s příkazem. Úspěch se nepředstírá.
- **Po úkolu nezůstane žádný proces:** `pgrep -af 'next|vitest|playwright|stryker'` a `docker ps`. Na cizí procesy se nesahá.
- `minimumReleaseAge` se neobchází: žádný `--config`, žádná změna `pnpm-workspace.yaml`. Plán nepřidává produkční závislost.
- **Token GlitchTipu se nikdy nevypisuje,** necommituje a nevkládá do testů ani zpráv. Testy nesahají na síť.
- Commity jsou Conventional Commits, jen předmět, bez těla a trailerů. Agent staguje jen své soubory.
- Komentáře píše jen pro neočividné invarianty, anglicky.
- **UI texty jsou česky v `src/lib/texts.ts`,** včetně Nápovědy (`TEXTS.help`) a textů e-mailů pro vlastníka.
- V `src/components` a `src/app` se používají jen tokeny barev. Barvy HTML e-mailu žijí v jediném modulu `src/server/mail/html/tokens.ts` **[R-17]**.
- **Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)`** se synchronním tělem. Plánovač a fronta používají `source: 'scheduler'`, obnova `source: 'import'`.
- **Každý dotaz na data účtu jde přes `scoped(ownerId)`,** u spojení na obou stranách. Nové tabulky patří do `USER_OWNED_TABLES` a do `BACKUP_TABLES`.
- Aktuální čas se bere jen z `clock`, „dnes“ přes `calendarDateInPrague`.
- Peníze jsou celá čísla zaokrouhlená půl od nuly. Desetinné částky z cizích souborů se čtou jako řetězce, nikdy přes `Number` ani `parseFloat`.
- `dueSql` (a `amountDue` v JS) je jediný výraz zůstatku.
- **Migrace navazují po nejvyšší v `drizzle/`,** dnes `0045_import_payment_code`: `pnpm exec drizzle-kit generate --name <jméno>`, číslo vždy ověř proti `drizzle/`.
- Service kód běží i přes type stripping Node (`tests/helpers/*-worker.mjs`), takže žádné `enum` ani `constructor(readonly x)`.
- Před kódem v App Routeru přečti návod v `node_modules/next/dist/docs/` (viz `AGENTS.md`), pro route handlery `01-app/03-api-reference/03-file-conventions/route.md` a pro cache `…/01-directives/use-cache.md`.
- **Název testu obsahuje ID požadavku.** Úkol sám přesouvá ID mezi `tests/spec-pending.txt` a `tests/spec-partial.txt` (ID, co chybí, plán, oddělené tabulátorem). ID splněné zčásti a s testem jde do partial, ID bez testu zůstává v pending.
- Každá nová automatika jde do `AUTOMATIONS` a do `armed` v `tests/backend/silence.test.ts` (TST-016). Každá nová entita jde do matice `tests/helpers/isolation.ts` (TST-009).

## Review Focus

1. **Zlomyslný archiv a paměť:** archiv uvnitř všech stávajících limitů (178 řádků, ~988 000 kontejnerů, 254 MiB dat) nesmí dostat haldu nad práh hlídače a po odmítnutí nesmí zůstat mezisoubor ani blob. Legitimní účet o 300 000 řádcích projde (Task 1).
2. **Vložení do HTML e-mailu:** jméno zákazníka, číslo dokladu, úvod, podpis i text zprávy s `<`, `"`, `</td>`, `javascript:` a `{{…}}` se dostanou do HTML jen escapované. Ve zprávě není žádný vzdálený obrázek ani odkaz, jen `cid:`. SVG logo se pošle jako PNG (Task 9, 10).
3. **Souhrny bez duplicit a bez nečekaných zpráv:** restart, přechod času, doběh, pozastavení, vypnutý přepínač i obnovený účet dají právě jednu zprávu, nebo žádnou. Zpráva jde jen vlastníkovi, nikdy klientovi ani na stálé kopie (Task 7, 8).
4. **Rychlé hledání:** `%`, `_` a `\` se hledají doslova a cizí účet se stejným jménem zákazníka nic nevrátí. Dotaz kratší než 2 znaky nejde na server a překročení limitu nic neprozradí (Task 11).
5. **Reset ukázky:** noční reset smaže a znovu naplní jen ukázkový účet a ostatní účty instance zůstanou netknuté. V režimu ukázky nejde odeslat žádný e-mail ani se připojit k SMTP nebo IMAP (Task 17).

## Rozhodnutí plánu

Na `[R-n]` se odkazují úkoly a čísla platí jen v tomto plánu. Rozhodnutí respektují rulingy plánů 7 a 8.

- **[R-1] Mezisoubory po tabulkách.** První průchod `scanArchive` ověří manifest, hashe a Zod všech řádků a sbírá jen ID do `Map<string, string[]>`. Druhý průchod řádek ověří, přemapuje a ztiší (`silenced`) a hned ho připíše do `restore-<id>/rows/<tabulka>.jsonl` přes `writeSync` po blocích 1 MiB. Pole řádků nevzniká. Commit v jediné `mutate` čte mezisoubory synchronně (`openSync`, `readSync` po 1 MiB, rozdělení po `\n`) a vkládá po 50 řádcích. Selhání nebo `recoverRestore` smaže celou složku `restore-<id>/` včetně mezisouborů. V paměti zůstává jen mapa ID, nejvýš 300 000 položek.
- **[R-2] Přemapování na místě.** `remapIds` přepisuje hodnoty v naparsovaném objektu a vrací tentýž objekt. `replaceIds` mění pole a objekty na místě, bez `Object.fromEntries` a bez `map`. Sloupce `owner` a `omit` se z objektu mažou přes `delete`.
- **[R-3] Hlídač paměti v `eachLine`.** Po každých 1 000 řádcích nebo 4 MiB bajtů se volá `guard.check()`. Ten čte `process.memoryUsage()` a sčítá `heapUsed + arrayBuffers`. Archiv se odmítne textem `E.memory`, když nárůst od začátku obnovy přesáhne **640 MiB**, nebo když `heapUsed` přesáhne **60 %** `v8.getHeapStatistics().heap_size_limit`. Sonda je parametr (`MemoryProbe`), takže test podstrčí rostoucí čísla. Produkční kód nemá testovací háček. Stejný hlídač běží v úloze zálohy (`snapshot`), a ta při překročení skončí `E.notRestorable`.
- **[R-4] Stropy uzlů jsou jen levný předfiltr.** Řádky už v paměti nezůstávají, proto `maxNodes` stoupá na **25 000 000**. Legitimní účet o 300 000 řádcích má ~19,3 M uzlů (N-2). `maxContainers` 1 000 000, `maxLineContainers` 20 000 a `maxLineDepth` 40 zůstávají. `restorableProblem` dostane i `lineDepth` (N-3). `maxLines` a `dataTotalBytes` zůstávají na 300 000 a 256 MiB, protože commit je jedna synchronní transakce. Celá položka `data/*.jsonl` (do 200 MiB) se dál drží jako bajty mimo haldu. Počítá se do `arrayBuffers` hlídače, viz Známá rizika.
- **[R-5] Manifest v2 se streamovaným seznamem souborů.** Archiv verze 2 má hned za `manifest.json` položku `files.jsonl`, kde každý řádek je `{ "id", "size", "sha256" }`. Manifest nese hashe `data/*`, `audit.jsonl` a `files.jsonl`, ne každý soubor. Strop položek stoupá z 28 000 na **200 000**, manifest má nejvýš 1 MiB. Strop 28 000 tak přestává být známým omezením (ruling plánu 8). Archiv v1 se čte dál starou cestou. Záloha píše vždy v2.
- **[R-6] Jedna nová verze zálohy pro celý plán.** `BACKUP_VERSION` je 2. Každý úkol plánu 9, který přidá sloupec nebo tabulku, aktualizuje `tests/fixtures/backup/columns-v2.json` a krok `BACKUP_UPGRADES[1]`, který doplní výchozí hodnoty nových sloupců. Mezi úkoly nic vydané není. `columns-v1.json` zůstává kvůli testu upgradu.
- **[R-7] Stažení souborů proudem.** `openOwnedFile` otevře popisovač dřív, než zapíše audit, a route čte proud z něj. Řeší to N-1 i m-7 u exportu. Druhy s `attachment` (`import_pdf`, `audit_archive`, `sent_html`) mají limit `fileDownloadUser` 30 za hodinu a audit `file.download` s druhem a velikostí. Obrázky `inline` (logo, QR logo, podpis, logo e-mailu) se neauditují ani neomezují, protože je stránka načítá při každém zobrazení. `readOwnedFile` zůstává jen pro malé interní čtení (přílohy pošty do 25 MiB).
- **[R-8] Spravedlnost těžké dráhy (m-1).** `claimNext(worker, "heavy")` vybírá z čekajících těžkých úloh nejdřív účet, jehož poslední těžká úloha začala nejdávno. Účet bez historie má přednost. Uvnitř účtu platí `runAt` a `createdAt`. Export `pdf_zip` podle filtru má strop **2 000 dokladů** v `EXPORT_LIMITS.pdfZipDocuments`. Nad ním vrátí 422 s počtem.
- **[R-9] Odmítnutí stropem nespotřebuje limit (N-3 bloku C).** Kontrola stropů běží před `enforceRateLimit`. Limit se čerpá jen za skutečně založenou úlohu.
- **[R-10] T2b, předpověď a převedená záloha.**
  - Koncept konečné faktury navázaný na zálohu dává v předpovědi `max(0, total − celek zálohy)`, ne `total − advance_minor`.
  - Záloha sama jde do řady `advances` svou dlužnou částkou. Úhrada zálohy tak přesune peníze z jedné řady do druhé a nikdy je nezdvojí.
- **[R-11] Denní koše běžícího období.** `alignPrevious(current, previous, anchor)`: když je srovnávací rozsah zkrácený (`comparisonRange` ≠ `previousRange`), páruje se od začátku (`anchor = 'start'`), jinak od konce jako dosud (ruling plánu 7 I-3).
- **[R-12] IMP-005, ruční PDF k importovanému dokladu.**
  - `POST /faktury/[id]/priloha` čte syrové tělo jako import (vzor `readCapped`), nejvýš 25 MiB, a obsah musí začínat `%PDF-`. Použije limit `importUser`.
  - Nahradí `invoice.import_pdf_file_id` a starý blob smaže v téže `mutate`. Audit je `invoice.import_pdf`.
  - Jen doklad s `external = 1`, jinak 409.
- **[R-13] Falešné „Záloha nenalezena“ (m-4).** `PaidDepositsAmount` bez `NonTaxedDeposit` znamená uhrazenou část, ne zálohu. Import ho bere jako odhadnutou platbu bez varování `advanceMissing`. Varování zůstává jen u `NonTaxedDeposit` s ID, které se nenašlo.
- **[R-14] Tabulkový import parsuje jednou (m-5).** `import-tabular.ts` přečte list jednou do sloupcového tvaru jen s mapovanými sloupci. Náhled mapování čte prvních 20 řádků proudem. Změřená špička heapu pro CSV 25 MB jde do zprávy úkolu, cíl je nejvýš 4× velikost souboru.
- **[R-15] E-maily pro vlastníka.** Souhrn (REM-010), daňová připomínka (REM-011) a limit DPH (REM-012) jsou prostý text. Jdou jen na `user.email`, bez stálých kopií. Běží i při pozastavení automatik, stejně jako denní přehled (ruling R-27 plánu 4). Jedna úloha `user.report` s `payload = { report: 'summary' | 'tax' | 'limit', period }`. Plánuje ji tick v čase odesílání účtu (`isDailyDue`). Klíče: `summary:<userId>:<YYYY-MM | YYYY-Qn>`, `tax:<userId>:<rok>`, `limit:<userId>:<rok>:<práh>`. Job se stejným klíčem znamená, že se nic znovu neplánuje. Migrace přidá do `automation_settings`: `period_summary` (`'off' | 'monthly' | 'quarterly'`, výchozí `'off'`), `tax_reminder` (výchozí `false`), `limit_mail` (výchozí `false`). Obnova je vypne (IMP-010, `silenced`).
- **[R-16] Obsah a termíny.**
  - **Souhrn** chodí první den nového období za období skončené: 1. 12. za listopad, 1. 1. za 4. čtvrtletí. Doběhne nejvýš do 3. dne období, pak se období vynechá.
    - Obsahuje fakturováno (`reportSummary`), přijato (`incomeTotal`), pohledávky k dnešku, faktury po splatnosti (počet a částka z `dueAlerts`) a výhled na další období.
    - Výhled je součet všech řad `forecast` za měsíce dalšího období.
    - Částky jsou v CZK. Nepřepočtené jdou na samostatný řádek s počtem.
  - **Daňová připomínka** chodí 10. 1. (do 31. 1. jako doběh) za předchozí rok.
    - Obsahuje příjmy podle úhrady (`taxOverview`, základ `paid`), počet a částku neuhrazených k 31. 12. (`unpaidAsOf`), upozornění `TEXTS.tax.disclaimer` a odkaz `${BETTER_AUTH_URL}/prehledy/dane?rok=<rok>`.
  - **Limit DPH:** denní kontrola pro klíč `vat`, jen když je hlídání limitu zapnuté (`turnover_vat_watch`).
    - Prahy jsou `LIMIT_WARN_PERCENT` a `LIMIT_HIGH_PERCENT` z `src/lib/turnover-limits.ts`. Ověřeno: limit, prahy i `effectiveLimit` jsou na jednom místě podle R-15 plánu 7 a nastavená hodnota přebíjí zákonnou.
    - Pošle se jen nejvyšší překročený práh, který ještě nešel. Paušální daň e-mail nemá, spec ho nežádá.
- **[R-17] HTML e-mail bez knihovny.** Vzhledy jsou v `src/server/mail/html/layouts.ts`: `b1`, `b2`, `b3`, `b4`, `b5`, `a` a `c` podle `docs/superpowers/mockups/email-sablony.html`. Kostra je z tabulek s inline styly a maximální šířkou 600 px. Barvy, písma a rozestupy jsou jen v `tokens.ts`. Každý text jde přes `escapeHtml` (`&`, `<`, `>`, `"`, `'`). Text zprávy se dělí na odstavce podle prázdného řádku a uvnitř `<br>`. Odkazy se automaticky nevytvářejí. Žádný `<script>`, `<style>` s `@import`, `<link>`, vzdálený obrázek ani sledovací parametr (MAIL-007, SEC-011). Textová alternativa je přesně `email_log.body`, tedy to, co ukazuje historie.
- **[R-18] Akcent a QR.** Akcent je vlastní barva dokladu (`appearance.colors.accent`), když je platný hex, jinak akcent designu, jinak `null`. `null` dává neutrální `NEUTRAL_BAND`. Barvu přebírá jen pás B4 a linka C. Text na pásu má barvu `readableOn(accent)`. QR mají vzhledy `b2`, `b3` a `b5`, a jen u zpráv `invoice`, `advance` a `reminder`. Částka je `amountDue`. QR vzniká z `documentQrPng(doc, title, readImage)`, kterou sdílí i `buildInvoiceView`, takže je stejný jako v PDF. Koncept a zpráva bez QR plánu QR nemají. QR jde jako příloha `cid:qr@fakturan`, logo jako `cid:logo@fakturan` (PNG, nejvýš 600 × 200 px).
- **[R-19] Nastavení vzhledu a archiv.**
  - Nová tabulka `mail_look`: `user_id` PK, `layout`, výchozí `'b4'`, `intro` a `signature`, text nejvýš 2 000 znaků nebo `NULL`, `logo_mode` (`'supplier' | 'custom' | 'none'`, výchozí `'supplier'`), `logo_file_id` jako ref na `file`, `updated_at`.
  - `FILE_KINDS` dostane `mail_logo`, `sent_html` a `sent_image`. `email_log` dostane `html_file_id` a `html_images` (JSON `{ cid, fileId }[]`, v registru zálohy `json-ids`).
  - Úvod je odstavec nad textem zprávy, podpis pod ním. Prázdný podpis znamená jméno dodavatele.
  - Bez loga se v hlavičce ukáže jméno dodavatele.
  - HTML se postaví jednou při první přípravě zprávy a archivuje jako `sent_html`, QR a logo jako `sent_image`, stejně jako `sent_pdf`. Další pokus čte jen archiv, takže pozdější změna vzhledu nebo loga nezmění zprávu ve frontě. Historie nabídne stažení HTML jako přílohu.
  - Automatické zprávy používají tentýž vzhled.
- **[R-20] Rychlé hledání (UI-010).** Ctrl+K, na macOS ⌘K, nebo tlačítko v postranním panelu otevře dialog `@base-ui/react`. Server action `quickSearch(q)` volá `searchAll(ownerId, q, 5)`. Vrátí faktury podle čísla, zákazníka a položek (`invoice.search_text`), zákazníky (`searchCustomers`), položky ceníku (`searchCatalog`) a pravidelné plány podle názvu. Statické položky (sekce navigace, záložky Nastavení, kapitoly Nápovědy) se filtrují v prohlížeči přes `foldText`. Dotaz musí mít aspoň 2 znaky, prodleva je 150 ms. Limit `searchUser` je 120 za minutu a při překročení vrací prázdno s hláškou.
- **[R-21] UI-002.** Preset `b5aa4wfToO` zapsal do `components.json` hodnoty `style: base-mira`, `baseColor: olive`, `iconLibrary: lucide`, `menuColor: default` a `menuAccent: subtle`. Test je pevně drží. Implementer jednou ověří shodu v kopii projektu ve scratchpadu (`pnpm exec shadcn init --preset b5aa4wfToO`) a výsledek dá do zprávy. Rozdíl neopravuje bez ohlášení.
- **[R-22] ARC-005 strukturně a měřením.**
  - Test projde `src/` a u každé funkce s `"use cache"` vyžaduje `cacheTag(accountTag(…))`, ID uživatele a razítko v parametrech.
  - `cacheMaxMemorySize` se nastaví výslovně v `next.config.ts` podle měření: aspoň výchozích 50 MB, a pokud měření ukáže víc, tak dvojnásobek změřené špičky.
- **[R-23] Fixture Playwrightu bez `detached`.**
  - `next start` se spouští jako `process.execPath node_modules/next/dist/bin/next start`, bez `pnpm` a bez `detached`. PID je tak přímo server.
  - PID se zapíše do `os.tmpdir()/fakturan-e2e-pids/<pid>`.
  - `globalTeardown` a obsluha `SIGINT` a `SIGTERM` workeru ukončí jen zapsané PID, jejichž `/proc/<pid>/cmdline` obsahuje `next` a `/proc/<pid>/environ` nese `DATA_DIR` s prefixem `fakturan-e2e-`. Cizí proces se nikdy neukončí.
- **[R-24] Backend po šesti shardech a `pdf-designs` mimo shardy.** Konfigurace Vitestu se nemění. Mění se příkazy v `README.md` (Vývoj), v `ci.yml` a v Global Constraints tohoto plánu.
- **[R-25] Stryker po souborech.** `scripts/mutation.ts <soubor>[:<od>-<do>]` vytvoří dočasnou konfiguraci v `.stryker-tmp/` s jedním `mutate` a s testy podle mapy `stryker.map.json` (soubor → testovací soubory). Výsledek zapíše jako JSON do `reports/mutation/` (do `.gitignore`). `scripts/mutation-summary.ts` vypíše tabulku a skončí kódem 1 pod 90 %. Ekvivalentní mutant smí mít `// Stryker disable next-line <mutator>: <důvod>`, jen s důvodem, a počet jde do zprávy. Soubor nad 170 s se dělí po rozsazích řádků.
- **[R-26] Rozsah 90 %.** Jádro podle spec: peníze, řady, párování a plánovač. To jsou soubory dnešního `stryker.config.json` a navíc `src/server/jobs/queue.ts`, `src/server/scheduler/lease.ts`, `src/server/scheduler/tick.ts` a `src/server/services/number-series.ts`. Moduly plánu 8 v konfiguraci zůstávají a cílem je i pro ně 90 %. Když modul plánu 8 90 % nedosáhne, TST-013 zůstane v partial s přesnými čísly. Jádro musí 90 % dosáhnout vždy.
- **[R-27] Provozní kontrola.**
  - `opsCheck(now)` běží jako tick úloha jednou za hodinu a hlásí přes `reportFailure`, každou podmínku nejvýš jednou denně (paměť procesu). Podmínky: volné místo na `DATA_DIR` pod 2 GiB nebo pod 10 % (`statfsSync`); poslední lístek ČNB starší než 3 pracovní dny; těžká úloha `running` déle než 30 minut; selhaná poslední noční záloha.
  - Stav instance (ADM-008) ukáže velikost `files/`, volné místo, datum posledního lístku a délku těžké fronty.
- **[R-28] Retence archivů.** `sent_pdf`, `sent_isdoc` a `sent_html` se nemažou, protože tvoří historii odeslání (MAIL-006) a účetní doklad se uchovává 10 let. Kvóta na účet nevzniká. Velikost hlídá R-27 a README radí kopie záloh mimo svazek.
- **[R-29] `notification.read` se neaudituje.** Je to stav zobrazení, ne data účtu, a AUD-001 se týká změn dat. Zapíše se do kap. 18 jako upřesnění.
- **[R-30] Řady faktur a záloh se nemění.** Výchozí `{RRRR}-{NNN}` a `Z{RRRR}-{NNN}` dávají stejný VS, párování to řeší podle typu a částky (plán 5). Nápověda to vysvětlí. Změna výchozí řady by rozbila zvyk stávajících účtů.
- **[R-31] Ukázková instance.** Do spec přibude **OPS-007** (Task 17) a proměnné `DEMO_MODE`, `DEMO_EMAIL` a `DEMO_PASSWORD` v kap. 19.5. S `DEMO_MODE=1`: registrace je vypnutá; přihlášení ukazuje přihlašovací údaje ukázky; účet ukázky nejde smazat a nejde mu změnit heslo ani e-mail; `resolveTransport` vrací `null` pro všechny účty, takže nic neodejde; nastavení pošty a schránky avíz nejde uložit; noční tick ve 3:30 Prague smaže účet ukázky stejnou cestou jako `deleteUser` a znovu ho založí a naplní přes `seedDemo(now)`. Data jsou smyšlená (Zkušební s. r. o. a vymyšlená IČO s platným součtem) za 18 měsíců zpět. Obsahují faktury v CZK i EUR, zálohu s konečnou fakturou, opravnou fakturu, platby, upomínku, pravidelný plán a dashboard. `seedDemo` zapisuje jen přes služby a `mutate`. Do obrazu jde `scripts/demo-seed.mjs` jako bundle esbuild, vzorem je `pdf-smoke`.
- **[R-32] Nápověda.**
  - Route `/napoveda`, položka navigace `help` s ikonou `CircleHelp` před Nastavením.
  - Obsah je v `TEXTS.help` jako kapitoly a FAQ (aspoň 12 otázek). Kapitoly jsou ve stejném pořadí jako navigace.
  - Text vychází z hotového chování a odkazuje na stránky aplikace relativními odkazy. Daňové kapitoly nesou `TEXTS.tax.disclaimer`.
  - Kapitoly jdou najít přes Ctrl+K.

---

## Blok A: Bezpečnost obnovy zálohy (povinný první blok)

### Task 1: Obnova přes mezisoubory, přemapování na místě a hlídač paměti

**Files:**
- Create: `src/server/backup/spool.ts`, `src/server/backup/memory-guard.ts`
- Modify: `src/server/backup/restore-read.ts`, `src/server/backup/remap.ts`, `src/server/backup/snapshot.ts`, `src/server/services/account-restore.ts`, `src/server/services/account-backup.ts`, `src/lib/backup-format.ts`, `src/lib/texts.ts`, `README.md` (Záloha a obnova jednoho účtu), `tests/spec-partial.txt`
- Test: `tests/backend/restore-hostile.test.ts`, `tests/backend/account-restore.test.ts`, `tests/backend/account-backup.test.ts`, `tests/backend/backup-roundtrip.test.ts`, `tests/unit/memory-guard.test.ts`

**Interfaces:**
- Consumes: `scanArchive`, `eachLine`, `validRows`, `remapIds`, `buildIdMap`, `silenced`, `insertValues`, `tempDir`, `removeTempDir`, `jsonNodesOfBytes`, `restorableProblem`
- Produces:
  - `type MemoryProbe = () => { heapUsed: number; arrayBuffers: number; heapLimit: number }`
  - `createMemoryGuard(probe?: MemoryProbe, limits?: { growthBytes: number; heapShare: number }): { check(): void }`, které vyhodí `RestoreRejected(E.memory)`
  - `MEMORY_LIMITS = { growthBytes: 640 * MiB, heapShare: 0.6, everyLines: 1000, everyBytes: 4 * MiB }`
  - `spoolWriter(dir: string, table: string): { append(row: ArchiveRow): void; close(): number }`, `eachSpooled(dir: string, table: string, take: (row: ArchiveRow) => void): number`
  - `remapIds(row, table, idMap): ArchiveRow` vrací tentýž objekt
  - `ArchiveHandlers.row?(table: BackupTable, row: ArchiveRow): void` místo `rows(table, rows[])`
  - `scanArchive(path, handlers, limits?, guard?)`
  - `NodeStats` + `lineDepth: number`, `RESTORE_LIMITS.maxNodes = 25_000_000`

Spec: IMP-010, IMP-011, SEC-005, TST-017, EXP-006. Viz **[R-1]** až **[R-4]**. Řeší C-1, N-2, N-3 a m-6 z plánu 8.

Pravidla:
- `validRows` zmizí. `eachLine` volá `guard.check()` podle `MEMORY_LIMITS.everyLines` a `everyBytes`. Řádek se po `take` nedrží.
- Mapa ID z prvního průchodu je jediná struktura úměrná archivu. `prepare` vrací jen čítače a cestu ke složce.
- `commit` volá `eachSpooled` v pořadí `BACKUP_TABLES` a vkládá po 50 řádcích. Kontrola prázdnoty, `defer_foreign_keys` a `accountDataProblems` zůstávají beze změny.
- Úloha zálohy počítá `lineDepth` v `lineFile` a `restorableProblem` ji porovná s `maxLineDepth`.
- Komentář u `RESTORE_LIMITS` a README popíšou skutečnou mez: mezisoubory, hlídač, 300 000 řádků a 256 MiB. Věta „around half a GiB“ zmizí.

- [ ] **Step 1: Napiš testy**

```ts
test('[SEC-005] hlídač odmítne obnovu, když nárůst paměti přesáhne 640 MiB', ...)
  // sonda vrací heapUsed 100 MiB, pak 741 MiB → RestoreRejected(E.memory), účet prázdný, složka restore-<id> neexistuje
test('[SEC-005] hlídač odmítne obnovu nad 60 % limitu haldy', ...)
  // heapLimit 1 000 MiB, heapUsed 601 MiB → E.memory
test('[IMP-011] nejhorší archiv z re-review v měřítku 1/10 drží nárůst pod 128 MiB', ...)
  // 18 řádků po ~1,4 MiB, 98 830 kontejnerů, 25 MiB dat; maximum z sondy během obnovy < 128 * MiB
test('[IMP-010] obnova vloží řádky z mezisouborů a výsledek je kanonicky shodný', ...)
test('[TST-017] pád uvnitř commitu nechá účet prázdný a mezisoubory zmizí', ...)
test('[IMP-010] remapIds vrací tentýž objekt a json-ids přepíše na místě', ...)
  // expect(remapIds(row, table, map)).toBe(row); expect(row.document.lines[0].catalogItemId).toBe(newId)
test('[EXP-006] účet o 300 000 řádcích v poměru 1:3:1 je obnovitelný', ...)
  // restorableProblem(entries, counts, RESTORE_LIMITS, 2_400, 0, { nodes: 19_300_000, containers: 590_000, lineContainers: 6, lineDepth: 4 }) === null
test('[EXP-006] záloha s řádkem hloubky 41 skončí hláškou předem', ...)
  // lineDepth: 41 → E.notRestorable
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/restore-hostile.test.ts tests/unit/memory-guard.test.ts`, FAIL na chybějícím `createMemoryGuard`.
- [ ] **Step 3: Implementuj** `memory-guard.ts`, `spool.ts`, `eachLine` s hlídačem, přemapování na místě a `prepare` a `commit` nad mezisoubory.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/account-restore.test.ts`, `tests/backend/backup-roundtrip.test.ts`, `tests/backend/silence.test.ts`, backend po shardech, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test backup-restore`, `timeout 170 pnpm run test:coverage-spec`. Do zprávy dej změřenou špičku sondy pro archiv 1/10 a pro legitimní seed `seedRichAccount` s 30 fakturami.
- [ ] **Step 5: Commit** `fix(backup): spool restored rows per table and guard restore memory`

---

### Task 2: Archiv v2 se streamovaným seznamem souborů

**Files:**
- Create: `tests/fixtures/backup/columns-v2.json`
- Modify: `src/lib/backup-format.ts`, `src/server/backup/restore-read.ts`, `src/server/backup/snapshot.ts`, `src/server/backup/tables.ts`, `src/server/services/account-backup.ts`, `src/lib/texts.ts`, `README.md`, `tests/helpers/backup-compare.ts`
- Test: `tests/backend/backup-registry.test.ts`, `tests/backend/restore-hostile.test.ts`, `tests/backend/backup-roundtrip.test.ts`, `tests/backend/migrations-upgrade.test.ts`

**Interfaces:**
- Consumes: `eachLine`, `createMemoryGuard`, `BACKUP_UPGRADES`, `backupManifestSchema`
- Produces:
  - `BACKUP_VERSION = 2`, `FILES_INDEX_ENTRY = "files.jsonl"`, `fileIndexLineSchema = z.strictObject({ id, size, sha256 })`
  - `RESTORE_LIMITS.entries = 200_000`, `RESTORE_LIMITS.manifestBytes = 1 * MiB`
  - `BACKUP_UPGRADES[1]`, zatím identita, další úkoly ho doplní **[R-6]**

Spec: EXP-006, IMP-010, TST-019, SEC-005. Viz **[R-5]**, **[R-6]**.

Pravidla:
- Pořadí položek v2: `manifest.json`, `files.jsonl`, `data/*.jsonl`, `audit.jsonl`, `files/<id>`. Položka `files/<id>` mimo index, duplicitní id v indexu nebo chybějící soubor z indexu jsou chyba.
- Přeskočený adresář a vnořený archiv se počítají jako položka mimo manifest a jsou chyba. Řeší to m-7 obnovy z plánu 8.
- Index se čte přes `eachLine` s `retained = false` a ID souborů jdou do mapy ID. Hash indexu je v manifestu.
- Archiv v1 projde starou větví čtení a `BACKUP_UPGRADES[1]`.
- Hláška nad stropem v záloze uvede 200 000 souborů. README a známá omezení zahodí strop 28 000.

- [ ] **Step 1: Napiš testy**

```ts
test('[EXP-006] záloha v2 má files.jsonl hned za manifestem a manifest nese jeho hash', ...)
test('[EXP-006] otisk sloupců v2 sedí s registrem a změna bez nové verze spadne', ...)
test('[TST-019] archiv v1 se obnoví do účtu přes BACKUP_UPGRADES[1]', ...)
test('[SEC-005] soubor mimo files.jsonl, duplicitní id i chybějící soubor jsou odmítnuté', ...)
test('[SEC-005] prázdný adresář v ZIPu je položka mimo manifest', ...)
test('[IMP-010] účet s 30 000 soubory se zálohuje i obnoví', ...)  // malé bloby po 16 B
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/backup-registry.test.ts tests/backend/restore-hostile.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** zápis a čtení v2 a otisk `columns-v2.json`.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/migrations-upgrade.test.ts`, backend po shardech, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test backup-restore`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(backup): stream the file index in backup archive v2`

---

### Task 3: Stahování proudem, limit a audit, spravedlnost těžké dráhy

**Files:**
- Modify: `src/server/services/files.ts`, `src/app/(app)/soubory/[id]/route.ts`, `src/server/services/exports.ts`, `src/app/(app)/nastaveni/export/[id]/route.ts`, `src/server/rate-limit.ts`, `src/server/jobs/queue.ts`, `src/lib/export-filter.ts`, `src/server/services/export-run.ts`, `src/lib/audit-labels.ts`, `src/lib/texts.ts`, `tests/spec-partial.txt`
- Test: `tests/backend/files.test.ts`, `tests/backend/exports.test.ts`, `tests/backend/heavy-jobs.test.ts`, `tests/backend/rate-limit.test.ts`

**Interfaces:**
- Consumes: `readOwnedFile`, `openExport`, `enforceRateLimit`, `claimNext`, `HEAVY_JOB_KINDS`
- Produces:
  - `openOwnedFile(actor: Actor, id: string): { fd: number; size: number; mimeType: string; name: string; kind: FileKind }`, kde volající zavře `fd` proudem
  - `openExport(actor, id)` vrací `{ fd, size, mimeType, fileName }` místo `path`
  - `RATE_RULES.fileDownloadUser = rule("fileDownloadUser", 30, 3600)`, akce auditu `file.download`
  - `EXPORT_LIMITS = { pdfZipDocuments: 2_000 }`, `createExport(actor, input, limits = EXPORT_LIMITS)`

Spec: SEC-001, SEC-005, AUD-002, ARC-007, EXP-007, IMP-010. Viz **[R-7]** až **[R-9]**. Řeší N-1, m-1 a m-7 z plánu 8 a N-3 bloku C.

Pravidla:
- Route otevře popisovač, zapíše audit a vrátí `Readable.toWeb(createReadStream("", { fd, autoClose: true }))` s `Content-Length` ze `fstatSync`. Chyba po otevření popisovač zavře.
- `claimNext` řadí těžké úlohy podle `(select max(updated_at) from job j2 where j2.user_id = job.user_id and j2.kind in HEAVY and j2.status <> 'pending')` vzestupně s `NULL` první. Lehká dráha se nemění.
- Strop `pdf_zip` se počítá přes `count(*)` s filtrem úlohy před založením. Hláška uvede počet a strop.

- [ ] **Step 1: Napiš testy**

```ts
test('[SEC-005] historie 50 MiB se stáhne proudem a readBlob se nevolá', ...)
test('[SEC-001] 31. stažení historie za hodinu vrátí 429 a zapíše audit', ...)
test('[AUD-002] stažení import_pdf zapíše file.download s druhem a velikostí', ...)
test('[SEC-002] cizí soubor je 404 a nezapíše audit ani limit', ...)
test('[EXP-007] export smazaný úklidem po otevření se dočte celý', ...)
test('[ARC-007] tři exporty účtu A a import účtu B se vystřídají A, B, A, A', ...)
test('[EXP-007] pdf_zip nad 2 000 doklady vrátí 422 a úloha nevznikne', ...)
test('[SEC-001] odmítnutí stropem tří rozpracovaných exportů limit nespotřebuje', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/files.test.ts tests/backend/heavy-jobs.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/actions-isolation.test.ts`, backend po shardech, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test export` a `backup-restore`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `fix(files): stream downloads with limits and share the heavy lane fairly`

---

## Blok B: Správnost přehledů a importu

### Task 4: Předpověď bez dvojí zálohy, denní koše a kurzy bez N+1

**Files:**
- Modify: `src/server/reports/forecast.ts`, `src/server/reports/align.ts`, `src/server/reports/bundle.ts`, `src/server/reports/widget-query.ts`
- Test: `tests/backend/reports-forecast.test.ts`, `tests/backend/report-export.test.ts`, `tests/backend/widget-query.test.ts`

**Interfaces:**
- Consumes: `forecast`, `resolveRate`, `alignPrevious`, `spanSeries`, `comparisonRange`
- Produces:
  - `alignPrevious(current: Series, previous: Series, anchor: 'start' | 'end' = 'end'): number[]`
  - `forecast` se stejnou signaturou. Uvnitř je `rateMemo: Map<string, number | null>` s klíčem `<měna>:<datum>`

Spec: REP-003, REP-008, DSH-015, REP-001, ADV-007. Viz **[R-10]**, **[R-11]**. Řeší T2b a přenosy plánu 7 (denní koše, N+1).

Pravidla:
- Celek zálohy se pro koncept načte jedním dotazem přes `scoped(ownerId)` na obou stranách (`invoice` a jeho `related_invoice_id`).
- `anchor = 'start'` se volí v místě, kde vzniká `comparisonRange`. Stejný výsledek musí dát stránka Statistiky, widget i export.

- [ ] **Step 1: Napiš testy**

```ts
test('[REP-003] neuhrazená záloha 70 000,00 a její koncept dají 70 000,00, ne 140 000,00', ...)
  // advances 7_000_000, plannedDrafts 0
test('[REP-003] záloha uhrazená 30 000,00 dá 40 000,00 a koncept 0', ...)
test('[REP-003] koncept 100 000,00 po neuhrazené záloze 70 000,00 dá 70 000,00 + 30 000,00', ...)
test('[REP-003] po úhradě celé zálohy zůstane jen doplatek 30 000,00 v plannedDrafts', ...)
test('[REP-003] 200 konceptů v EUR se stejným datem zavolá resolveRate jednou', ...)
test('[DSH-015] běžící listopad 1.–6. se denně páruje s 1.–6. října', ...)
  // current [1,2,3,4,5,6], previous říjen den d = 10*d → [10,20,30,40,50,60]
test('[DSH-015] ukončený měsíc se dál páruje od konce a součet sedí se souhrnem', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/reports-forecast.test.ts`, FAIL na 14 000 000.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/reports.test.ts`, `tests/backend/system-widgets.test.ts`, `tests/backend/consistency.test.ts`, `timeout 170 pnpm exec playwright test reports` a `dashboard`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `fix(reports): count a converted advance once and pair running days from the start`

---

### Task 5: Ruční PDF k importovanému dokladu a přenosy importu

**Files:**
- Create: `src/app/(app)/faktury/[id]/priloha/route.ts`, `src/components/invoices/import-pdf-upload.tsx`
- Modify: `src/server/services/files.ts` (`attachImportPdf`), `src/server/services/import-analyze.ts`, `src/server/services/import-tabular.ts`, `src/lib/safe-input/csv.ts` jen je-li potřeba, `src/components/invoices/*` (detail), `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/spec-partial.txt`
- Test: `tests/backend/external-invoices.test.ts`, `tests/backend/import-upload.test.ts`, `tests/backend/export-isdoc.test.ts`, `tests/backend/import-tabular.test.ts`, `tests/e2e/import-isdoc.spec.ts`

**Interfaces:**
- Consumes: `readCapped`, `writeBlob`, `removeBlob`, `invoice.importPdfFileId`, `parseCsv`, `readXlsx`, `applyMapping`
- Produces:
  - `attachImportPdf(actor: Actor, invoiceId: string, data: Buffer, name: string): { fileId: string }`
  - akce auditu `invoice.import_pdf`
  - `readSheetOnce(bytes, mapping): ColumnarSheet`, kde `ColumnarSheet = { headers: string[]; columns: string[][]; rows: number }`

Spec: IMP-005, IMP-001, IMP-012, SEC-001, SEC-002, SEC-005. Viz **[R-12]** až **[R-14]**. Řeší m-4 a m-5 z plánu 8.

Pravidla:
- Detail importovaného dokladu ukáže „Přiložit PDF“, a když PDF existuje, „Nahradit PDF“. Stažení jde přes `soubory/[id]` podle R-7.
- Z partial odeber `IMP-005`.

- [ ] **Step 1: Napiš testy**

```ts
test('[IMP-005] k importovanému dokladu jde přiložit PDF a nahrazení smaže starý blob', ...)
test('[IMP-005] vlastní doklad PDF nepřijme a vrátí 409', ...)
test('[SEC-005] soubor bez %PDF- je 415 a 25 MiB + 1 B je 413, na disku nic nezůstane', ...)
test('[SEC-002] cizí doklad je 404 a nic nezapíše', ...)
test('[IMP-012] uhrazený doklad po exportu a importu nehlásí „Záloha nenalezena“', ...)
  // warnings neobsahují TEXTS.importing.rows.advanceMissing, status 'paid', 1 platba date_estimated
test('[IMP-012] NonTaxedDeposit s neznámým ID dál varuje', ...)
test('[IMP-001] CSV se parsuje jednou pro mapování i řádky', ...)  // spy parseCsv: 1 volání na dávku
test('[IMP-005] e2e přiložení PDF na detailu importovaného dokladu', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/external-invoices.test.ts tests/backend/export-isdoc.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.** Změř špičku haldy pro CSV 25 MB s krátkými buňkami a dej ji do zprávy podle **[R-14]**.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/import-isdoc.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test import-isdoc` a `import-csv`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(import): attach a PDF to imported documents and parse sheets once`

---

### Task 6: Odložené drobnosti plánů 7 a 8

**Files:**
- Modify: `src/components/dashboard/grid-editor.tsx`, `src/lib/dashboard-defaults.ts`, `src/server/reports/widget-query.ts`, `src/server/reports/system-widgets.ts`, `src/server/rate-limit.ts`, `src/server/jobs/worker.ts`, `src/server/services/import-parse.ts`, `src/lib/safe-input/pdf-embedded.ts`, `src/lib/safe-input/zip.ts`, `src/lib/import-document.ts` (kódy zemí), `src/server/services/tax-report.ts`, `src/app/(app)/prehledy/dane/export/route.ts`, `src/components/overview/*` (limity), `src/lib/texts.ts`, `tests/e2e/dashboard.spec.ts`, `tests/backend/reports.test.ts`
- Test: `tests/e2e/dashboard-edit.spec.ts`, `tests/unit/safe-zip.test.ts`, `tests/backend/tax-export.test.ts`, `tests/backend/rate-limit.test.ts`, `tests/backend/system-widgets.test.ts`, `tests/unit/source-rules.test.ts`

**Interfaces:**
- Consumes: `setLeaveGuard`, `mayLeave`, `checkRateLimit`, `reportFailure`
- Produces:
  - `checkRateLimit` odmítne `cost` mimo `1..rule.limit` přes `RangeError`
  - `renderTaxPdf(overview, { rowLimit })` místo `setTaxPdfRowLimitForTests` (N-4)
  - `TEXTS.jobs`, `TEXTS.importing.internal`, `TEXTS.importing.pdf` pro dnešní řetězce v `worker.ts`, `import-parse.ts` a `pdf-embedded.ts` (m-12)

Spec: DSH-001, DSH-004, UI-006, SEC-001, SEC-005, TAX-003, IMP-003. Přenosy z `prenosy-plan-7.txt` a `prenosy-plan-8.txt`.

Pravidla. Úkol uzavře tyto drobnosti, ostatní jdou do Známých omezení v Task 18: **Editor dashboardu:** `popstate` a navigace zpět s neuloženými změnami se zeptá přes `setLeaveGuard`. **Dashboard:** prázdné řádky v `dashboard-defaults.ts:71,84` pryč; `config.period!` ve `widget-query.ts` nahradí zúžení typu; poškozený widget hlásí `reportFailure` jednou za klíč widgetu a proces; `SystemBody` hlásí výjimku; systémové runnery čtou přes `q`. **Limity:** `turnoverLimits.title` buď použít, nebo smazat. Hint se skládá v `texts.ts`. **Testy:** test „koncept se nepočítá“ koncept opravdu založí; test ADV-007 dostane přesný název; kontrola URL v `dashboard.spec.ts` DSH-004 musí umět selhat; e2e bere „dnes“ přes `calendarDateInPrague(new Date())`. **ZIP:** hláška `zip_corrupt` u uložené položky s descriptorem radí uložit archiv s kompresí. `UK` se převádí na `GB`. `XI` zůstává `XI` a varuje. **Daňový export:** souborové pole formuláře vrátí 400 (N-5).

- [ ] **Step 1: Napiš testy**

```ts
test('[DSH-001] Zpět v prohlížeči s neuloženými změnami se zeptá a Zrušit nechá editor otevřený', ...) // e2e
test('[DSH-004] úzká obrazovka skládá widgety pod sebe podle souřadnic, ne podle URL', ...) // e2e
test('[SEC-001] cost 0 a cost nad limit vyhodí RangeError', ...)
test('[TAX-003] souborové pole v daňovém exportu vrátí 400', ...)
test('[SEC-005] uložená položka s descriptorem radí uložit archiv s kompresí', ...)
test('[IMP-003] kód země UK se uloží jako GB', ...)
test('[UI-006] worker, import-parse a pdf-embedded nemají české řetězce mimo texts.ts', ...)
test('[DSH-020] poškozený widget nahlásí chybu jednou za klíč', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/safe-zip.test.ts tests/backend/tax-export.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, unit, backend po shardech, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test dashboard-edit` a `dashboard`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `fix: close deferred minors of plans 7 and 8`

---

## Blok C: E-maily pro vlastníka

### Task 7: Pravidelný souhrn (REM-010)

**Files:**
- Create: `drizzle/<n>_owner_reports.sql`, `src/server/services/owner-reports.ts`, `src/lib/owner-reports.ts`
- Modify: `src/server/db/schema/automation.ts`, `src/server/db/schema/job.ts`, `src/lib/automation.ts`, `src/server/services/automation.ts`, `src/server/scheduler/start.ts`, `src/server/jobs/registry.ts`, `src/server/services/account-restore.ts` (`silenced`), `src/server/backup/tables.ts`, `src/lib/backup-format.ts` (`BACKUP_UPGRADES[1]`), `tests/fixtures/backup/columns-v2.json`, `src/components/settings/automation-panel.tsx`, `src/app/(app)/nastaveni/automatizace/actions.ts`, `src/lib/texts.ts`, `tests/backend/silence.test.ts`, `tests/spec-pending.txt`
- Test: `tests/unit/owner-reports.test.ts`, `tests/backend/owner-reports.test.ts`, `tests/backend/silence.test.ts`, `tests/e2e/automation.spec.ts`

**Interfaces:**
- Consumes: `isDailyDue`, `calendarDateInPrague`, `reportSummary`, `incomeTotal`, `dueAlerts`, `forecast`, `resolveTransport`, `enqueue`, `RetryLater`, `reportFailure`
- Produces:
  - `PERIOD_SUMMARIES = ['off', 'monthly', 'quarterly'] as const`
  - `JOB_KINDS` + `user.report`
  - `finishedPeriod(today: CalendarDate, mode: 'monthly' | 'quarterly'): { key: string; range: DateRange; next: DateRange; dayOfPeriod: number }` v `src/lib/owner-reports.ts`
  - `planOwnerReports(now: Date): void`, tick úloha `ownerReportPlanTask`
  - `deliverOwnerReport(row: Job): Promise<void>`
  - `periodSummary(ownerId: string, range: DateRange, next: DateRange, today: CalendarDate): PeriodSummary`, `summaryText(ownerId, summary): string`
  - `automation_settings.period_summary`, `.tax_reminder`, `.limit_mail`

Spec: REM-010, TST-016, MAIL-004, IMP-010. Viz **[R-15]**, **[R-16]**.

Pravidla:
- Plánování i odeslání jdou přes `mutate` s `source: 'scheduler'` a auditem `mail.owner_report` s druhem a obdobím, bez částek. Odeslání ověří přepínač znovu.
- Fixture souhrnu (dnes 1. 12. 2026, čas odesílání 9:00): faktura A 12 100,00 vystavená 3. 11. a uhrazená 10. 11; faktura B 5 000,00 vystavená 5. 11., splatná 19. 11., neuhrazená; měsíční plán 2 000,00 se dnem vystavení 15.
- Z pending odeber `REM-010`.

- [ ] **Step 1: Napiš testy**

```ts
test('[REM-010] finishedPeriod: 1. 12. 2026 měsíčně dá 2026-11, 1. 1. 2027 čtvrtletně dá 2026-Q4', ...)
test('[REM-010] souhrn za listopad: fakturováno 17 100,00 Kč, přijato 12 100,00 Kč, pohledávky 5 000,00 Kč', ...)
test('[REM-010] po splatnosti 1 faktura 5 000,00 Kč a výhled na prosinec 7 000,00 Kč', ...)
test('[REM-010] zpráva jde jen na e-mail účtu, bez stálých kopií a bez přílohy', ...)
test('[REM-010] druhý tick téhož dne ani restart nepošle druhý souhrn', ...)
test('[REM-010] zapnutí 2. 12. ještě pošle listopad, 4. 12. už ne', ...)
test('[REM-010] čtvrtletní souhrn v listopadu nic nepošle', ...)
test('[TST-016] vypnutý souhrn nepošle nic ani po doběhu', ...)
test('[IMP-010] obnova nastaví period_summary off', ...)
test('[REM-010] přepínač v Automatizaci má výchozí Vypnuto a uloží Čtvrtletně', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/owner-reports.test.ts tests/backend/owner-reports.test.ts`, FAIL.
- [ ] **Step 3: Vygeneruj migraci a implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/due-alerts.test.ts`, `tests/backend/backup-registry.test.ts`, backend po shardech, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test automation`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(reminders): send an optional monthly or quarterly summary to the owner`

---

### Task 8: Lednová připomínka k daním a e-mail o limitu DPH

**Files:**
- Modify: `src/server/services/owner-reports.ts`, `src/lib/owner-reports.ts`, `src/server/services/limit-alerts.ts`, `src/components/settings/automation-panel.tsx`, `src/app/(app)/nastaveni/automatizace/actions.ts`, `src/lib/texts.ts`, `tests/backend/silence.test.ts`, `tests/spec-pending.txt`
- Test: `tests/backend/owner-reports.test.ts`, `tests/unit/turnover-limits.test.ts`, `tests/unit/source-rules.test.ts`

**Interfaces:**
- Consumes: `taxOverview`, `unpaidAsOf`, `limitStates`, `LIMIT_WARN_PERCENT`, `LIMIT_HIGH_PERCENT`, `effectiveLimit`, `env.BETTER_AUTH_URL`
- Produces:
  - `taxReminderDue(today: CalendarDate): { year: number } | null`, které vrací rok jen mezi 10. a 31. 1.
  - `limitMailThreshold(level: LimitLevel): 80 | 95 | null`, kde `over` dává 95
  - `taxReminderText(ownerId, year): string`, `limitMailText(ownerId, state): string`

Spec: REM-011, REM-012, REP-005, TAX-004, TST-016. Viz **[R-15]**, **[R-16]**.

Pravidla:
- Limit DPH: `limit:<userId>:<rok>:80` a `:95`. Při skoku přes oba prahy jde jen 95, protože 80 se zapíše jako odbavené bez zprávy. Snížení obratu zprávu nevrací.
- Strukturní test: literál `200_000_000`, `80` nebo `95` jako práh limitu se mimo `src/lib/turnover-limits.ts` v `src/server` ani `src/lib` neobjeví.
- Z pending odeber `REM-011` a `REM-012`.

- [ ] **Step 1: Napiš testy**

```ts
test('[REM-011] 10. 1. 2027 přijde přehled za 2026 s příjmy, neuhrazenými k 31. 12. a odkazem', ...)
  // text obsahuje „Neuhrazené k 31. 12. 2026: 1 faktura, 5 000,00 Kč“ a „/prehledy/dane?rok=2026“
test('[REM-011] připomínka nese upozornění TEXTS.tax.disclaimer', ...)
test('[REM-011] 9. 1. nic, 31. 1. doběh, 1. 2. nic a druhý běh v roce nic', ...)
test('[REM-012] obrat 1 600 000,00 Kč pošle 80 %, 1 900 000,00 Kč pošle 95 %', ...)
test('[REM-012] skok z 0 na 1 950 000,00 Kč pošle jen 95 %', ...)
test('[REM-012] vypnuté hlídání limitu nebo limit_mail nepošle nic', ...)
test('[REM-012] vlastní limit 1 000 000,00 Kč posune práh 80 % na 800 000,00 Kč', ...)
test('[REM-012] prahy a limit jsou jen v turnover-limits.ts', ...)
test('[TST-016] vypnutá připomínka i limit nepošlou nic ani po doběhu', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/owner-reports.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/reports-turnover.test.ts`, `tests/backend/tax-report.test.ts`, `tests/backend/silence.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test automation`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(reminders): add the January tax reminder and VAT limit e-mails`

---

## Blok D: HTML e-maily klientovi

### Task 9: Vykreslení sedmi vzhledů s QR v příloze

**Files:**
- Create: `src/server/mail/html/escape.ts`, `src/server/mail/html/tokens.ts`, `src/server/mail/html/layouts.ts`, `src/server/mail/html/render.ts`
- Modify: `src/server/pdf/view.ts` (vyčlenit `documentQrPng`), `src/server/pdf/qr.ts` jen je-li potřeba, `src/lib/texts.ts`
- Test: `tests/unit/mail-html-escape.test.ts`, `tests/backend/mail-html.test.ts`, `tests/backend/pdf.test.ts`

**Interfaces:**
- Consumes: `planQr`, `documentQrInput`, `qrPng`, `amountDue`, `readableOn`, `isHexColor`, `getDesign`, `formatMoney`, `imageToPng`
- Produces:
  - `MAIL_LAYOUTS = ['b1', 'b2', 'b3', 'b4', 'b5', 'a', 'c'] as const`, `MailLayout`, `DEFAULT_MAIL_LAYOUT = 'b4'`, `LAYOUTS_WITH_QR = ['b2', 'b3', 'b5']`
  - `escapeHtml(text: string): string`, `paragraphs(text: string): string`
  - `documentQrPng(doc: InvoiceDocument, title: string, readImage: (id: string) => Buffer | null): Promise<{ png: Buffer; payload: string } | null>`
  - `emailAccent(doc: InvoiceDocument): string | null`
  - `renderEmailHtml(input: EmailHtmlInput): { html: string; images: { cid: string; png: Buffer }[] }`
  - `EmailHtmlInput = { layout; kind: MessageKind; language; body: string; intro: string | null; signature: string | null; supplierName; supplierIco: string | null; logo: Buffer | null; accent: string | null; summary: { number; amountDue; currency; dueDate; variableSymbol; account } | null; qr: Buffer | null }`

Spec: MAIL-009, MAIL-007, SEC-011, TST-015, UI-004. Viz **[R-17]**, **[R-18]**.

Pravidla:
- Vzhledy přesně podle mockupu: pořadí bloků, kde je částka a kde QR. Text „Doporučuju“ ani popisky z katalogu do zprávy nepatří. Popisky jsou z `TEXTS.mailHtml` v jazyce faktury (`cs`, `en`).
- Bez značky Fakturanu a bez textu „Fakturan“ v HTML.
- `buildInvoiceView` volá `documentQrPng`, takže PDF i e-mail mají stejný obsah QR.

- [ ] **Step 1: Napiš testy**

```ts
test('[SEC-011] escapeHtml převede & < > " \' a nic jiného nemění', ...)
  // escapeHtml('<script>alert("x")</script>') === '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
test('[SEC-011] jméno, číslo, úvod, podpis a text s </td> se v HTML neobjeví jako značka', ...)
test('[MAIL-007] každé src v HTML začíná cid: a v HTML není http(s):// mimo text zprávy', ...)
test('[MAIL-009] všech 7 vzhledů dá HTML s tabulkou šířky 600 a bez slova Fakturan', ...)
test('[MAIL-009] B4 s akcentem #2f5d62 má pás #2f5d62 a text #ffffff', ...)
test('[MAIL-009] B4 s akcentem #f5d000 má text #000000', ...)
test('[MAIL-009] bez platného akcentu je pás NEUTRAL_BAND', ...)
test('[MAIL-009] C bere akcent do linky, B1 zůstává neutrální', ...)
test('[TST-015] QR z cid:qr@fakturan dekóduje stejný payload jako QR v PDF', ...)
test('[MAIL-009] B1, B4, A, C a potvrzení platby QR nemají ani při dluhu', ...)
test('[MAIL-009] koncept ani uhrazená faktura QR nemají', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/mail-html-escape.test.ts tests/backend/mail-html.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** escape, tokeny, vzhledy a `documentQrPng`.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/pdf.test.ts`, `tests/backend/qr.test.ts`, `pdf-designs` po částech, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(mail): render HTML e-mails in seven layouts with an embedded QR`

---

### Task 10: Vzhled v Nastavení, vlastní úvod, podpis a logo a odeslání HTML

**Files:**
- Create: `drizzle/<n>_mail_look.sql`, `src/server/db/schema/mail-look.ts`, `src/server/services/mail-look.ts`, `src/lib/mail-look.ts`, `src/app/(app)/nastaveni/posta/vzhled/page.tsx`, `src/app/(app)/nastaveni/posta/vzhled/actions.ts`, `src/app/(app)/nastaveni/posta/vzhled/nahled/route.ts`, `src/components/settings/mail-look-form.tsx`, `tests/e2e/mail-look.spec.ts`
- Modify: `src/server/db/schema/mail.ts` (`html_file_id`), `src/server/db/schema/file.ts`, `src/server/db/schema/index.ts`, `src/server/services/users.ts` (`USER_OWNED_TABLES`), `src/server/mail/transport.ts` (`html`, inline přílohy s `cid`), `src/server/services/mail-delivery.ts` (`prepare`), `src/server/services/files.ts` (`archiveSentHtml`), `src/app/(app)/soubory/[id]/route.ts` (`sent_html`, `mail_logo`), `src/server/backup/tables.ts`, `src/server/backup/restore-read.ts` (`MIMES_BY_KIND`), `src/lib/backup-format.ts`, `tests/fixtures/backup/columns-v2.json`, `src/components/invoices/*` (historie odeslání), `src/app/(app)/nastaveni/posta/page.tsx` (odkaz), `src/lib/texts.ts`, `tests/helpers/isolation.ts`, `tests/backend/actions-isolation.test.ts`, `tests/spec-pending.txt`
- Test: `tests/backend/mail-look.test.ts`, `tests/backend/mail-delivery.test.ts`, `tests/backend/invoice-mail.test.ts`, `tests/backend/backup-registry.test.ts`, `tests/backend/account-restore.test.ts`, `tests/e2e/mail-look.spec.ts`, `tests/e2e/send.spec.ts`

**Interfaces:**
- Consumes: `renderEmailHtml`, `documentQrPng`, `emailAccent`, `invoiceDocument`, `archiveSent`, `validateImage` (vzor logo dodavatele), `imageToPng`
- Produces:
  - tabulka `mail_look`, `FILE_KINDS` + `mail_logo`, `sent_html`, `sent_image`, `email_log.html_file_id`, `email_log.html_images`
  - `mailLookSchema` (Zod, `intro` a `signature` do 2 000 znaků, neznámé klíče odmítnuté)
  - `getMailLook(ownerId): MailLook`, `saveMailLook(actor, input)`, `setMailLogo(actor, data, name)`, `clearMailLogo(actor)`
  - `MailMessage` + `html?: string`, `MailAttachment` + `cid?: string`
  - `archivedHtml(log): Promise<{ html: string; images: MailAttachment[] }>`

Spec: MAIL-009, MAIL-010, MAIL-006, MAIL-007, SEC-002, SEC-005, SEC-011, IMP-010, TST-005, EXP-006. Viz **[R-17]** až **[R-19]**. Ruší R-22 plánu 4 (pošta jen prostý text).

Pravidla:
- Náhled `GET …/vzhled/nahled?layout=<id>` vrátí HTML s ukázkovými daty účtu a obrázky jako `data:`. Hlavičky: `Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'`, `nosniff`, `no-store`. Stránka ho ukazuje v `<iframe sandbox>`.
- Výběr ukazuje všech 7 vzhledů s popisem z mockupu. Výchozí je B4.
- Logo: výchozí je logo dodavatele, jde nahrát vlastní (PNG, JPEG, WebP, SVG po sanitaci, převod na PNG) nebo vypnout.
- Odeslání: `prepare` k textu přidá `html` a inline obrázky z archivu. Archiv vznikne při první přípravě a další pokus ho jen čte.
- Text dialogu odeslání dál upravuje `body` a HTML ho obalí.
- Historie odeslání nabídne „Stáhnout HTML“.
- Obnova převezme `mail_look` i logo a archivy `sent_html`.
- Z pending odeber `MAIL-009` a `MAIL-010`.

- [ ] **Step 1: Napiš testy**

```ts
test('[MAIL-009] SMTP dostane multipart/alternative s textem shodným s historií a HTML', ...)
test('[MAIL-009] výchozí vzhled je B4 a změna na B2 přidá QR jako inline přílohu cid', ...)
test('[MAIL-006] opakované doručení pošle stejné HTML a QR jako první pokus, i po změně loga', ...)
test('[MAIL-006] změna vzhledu po zařazení nezmění zprávu ve frontě', ...)
test('[MAIL-010] vlastní úvod a podpis jsou nad a pod textem, prázdný podpis je jméno dodavatele', ...)
test('[MAIL-010] vypnuté logo ukáže v hlavičce jméno dodavatele ve všech 7 vzhledech', ...)
test('[MAIL-010] úvod nad 2 000 znaků a neznámý klíč jsou odmítnuté', ...)
test('[SEC-005] SVG logo se sanitizuje a pošle jako PNG', ...)
test('[SEC-002] cizí vzhled ani logo nejde číst ani přepsat', ...)
test('[MAIL-009] upomínka nese QR na zbývající částku, potvrzení platby QR nemá', ...)
test('[EXP-006] mail_look, mail_logo, sent_html a sent_image jsou v záloze a obnova přemapuje html_images', ...)
test('[MAIL-010] výběr vzhledu, náhled a vlastní podpis v Nastavení', ...) // e2e
test('[MAIL-009] odeslaná faktura dorazí s HTML a textovou verzí', ...) // e2e send.spec.ts
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/mail-look.test.ts tests/backend/mail-delivery.test.ts`, FAIL.
- [ ] **Step 3: Vygeneruj migraci a implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/silence.test.ts`, `tests/backend/users.test.ts`, backend po shardech, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test mail-look`, `send` a `email-templates`, Docker po vrstvách (sharp v běhovém obrazu), `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(mail): choose the HTML e-mail layout with own intro, signature and logo`

---

## Blok E: Rozhraní a kvalita

### Task 11: Rychlé hledání Ctrl+K (UI-010)

**Files:**
- Create: `src/server/services/quick-search.ts`, `src/app/(app)/hledani-actions.ts`, `src/components/quick-search.tsx`, `src/lib/quick-search.ts`, `tests/e2e/quick-search.spec.ts`
- Modify: `src/components/app-shell.tsx`, `src/app/(app)/layout.tsx`, `src/server/rate-limit.ts`, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/spec-pending.txt`
- Test: `tests/backend/quick-search.test.ts`, `tests/unit/quick-search.test.ts`, `tests/e2e/quick-search.spec.ts`

**Interfaces:**
- Consumes: `searchCustomers`, `searchCatalog`, `escapeLike`, `foldText`, `invoice.searchText`, `NAV_ITEMS`, `enforceRateLimit`
- Produces:
  - `searchAll(ownerId: string, q: string, perGroup = 5): SearchHit[]`
  - `SearchHit = { group: 'invoice' | 'customer' | 'catalog' | 'recurring'; id: string; label: string; detail: string; href: string }`
  - `staticHits(q: string, role: string | null): SearchHit[]` v `src/lib/quick-search.ts` (navigace, záložky Nastavení a později kapitoly Nápovědy)
  - `quickSearch(q: string): Promise<{ hits: SearchHit[]; limited: boolean }>`, `RATE_RULES.searchUser = rule("searchUser", 120, 60)`

Spec: UI-010, UI-008, SEC-001, SEC-002, SEC-006. Viz **[R-20]**.

Pravidla:
- Dialog má roli `dialog`, pole `combobox` s `aria-activedescendant` a výsledky po skupinách s nadpisy. Šipky, Enter a Esc fungují a fokus se vrací na spouštěč.
- Funguje i na telefonu přes tlačítko.
- Faktury hledají ve `search_text` přes `LIKE … ESCAPE '\\'` a podle čísla. Koncepty mají popisek „Koncept“. Archivovaný zákazník je označený.
- Z pending odeber `UI-010`.

- [ ] **Step 1: Napiš testy**

```ts
test('[UI-010] najde fakturu podle čísla 2026-0001, jména zákazníka i názvu položky', ...)
test('[UI-010] 50%_\\ se hledá doslova a nic nevrátí', ...)
test('[SEC-002] cizí účet se stejným jménem zákazníka nic nevrátí', ...)
test('[UI-010] každá skupina vrátí nejvýš 5 výsledků', ...)
test('[SEC-001] 121. hledání za minutu vrátí limited true a prázdný seznam', ...)
test('[UI-010] staticHits najde „pošta“ v záložkách Nastavení bez diakritiky', ...)
test('[UI-010] Ctrl+K otevře hledání, šipka a Enter otevřou fakturu, Esc vrátí fokus', ...) // e2e
test('[UI-007] na telefonu se hledání otevře tlačítkem v hlavičce', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/quick-search.test.ts tests/unit/quick-search.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test quick-search` a `shell`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(ui): add quick search on Ctrl+K`

---

### Task 12: UI-002, ARC-005 a měření výkonu

**Files:**
- Create: `scripts/perf-measure.ts`, `tests/unit/ui-preset.test.ts`
- Modify: `next.config.ts` (`cacheMaxMemorySize`), `src/server/services/notifications.ts` (zvonek, je-li měření nad prahem), `tests/unit/source-rules.test.ts`, `tests/unit/next-config.test.ts`, `tests/spec-pending.txt`
- Test: `tests/unit/ui-preset.test.ts`, `tests/unit/source-rules.test.ts`, `tests/backend/report-cache.test.ts`, `tests/backend/notifications.test.ts`

**Interfaces:**
- Consumes: `cachedReport`, `cachedWidget`, `cachedTax`, `accountTag`, `accountStamp`, `unreadCount`, `hasUnread`
- Produces:
  - `scripts/perf-measure.ts [--documents 30000]`, který seeduje dočasnou SQLite a vypíše tabulku: počet dotazů a čas zvonku, `forecast`, `accountStamp` (`max(audit_log.id)`), `reportSummary` nad SQL funkcemi, `listInvoices` a velikost položek cache
  - `bellState(ownerId): { unread: number; alerts: number }` nejvýš dvěma dotazy (nepřečtená upozornění a odvozená upozornění), které zvonek volá místo `unreadCount` a `hasUnread`

Spec: UI-002, ARC-005, UI-011. Viz **[R-21]**, **[R-22]**. Přenos plánu 7: zvonek 3–4 dotazy, `max(audit_log.id)`, `cacheMaxMemorySize`, SQL funkce u desítek tisíc dokladů.

Pravidla:
- Měření běží nad 30 000 doklady a 60 000 platbami, každý krok do 170 s. Výsledky jdou do zprávy úkolu a do README (Provoz, „Výkon“).
- Krok nad 500 ms dostane index nebo úpravu dotazu v tomto úkolu, jinak jde do Známých omezení s číslem.
- Z pending odeber `UI-002`.

- [ ] **Step 1: Napiš testy**

```ts
test('[UI-002] components.json drží preset b5aa4wfToO: base-mira, olive, lucide, default, subtle', ...)
test('[ARC-005] každá funkce s "use cache" má cacheTag(accountTag(userId)) a razítko v parametrech', ...)
test('[ARC-005] cacheMaxMemorySize je v next.config.ts nastavená výslovně a aspoň 50 MB', ...)
test('[ARC-005] accountStamp nad 100 000 záznamy auditu použije index', ...)  // EXPLAIN QUERY PLAN obsahuje USING INDEX
test('[UI-011] zvonek přečte stav nejvýš dvěma dotazy', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/ui-preset.test.ts tests/unit/source-rules.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** testy a skript, změř a podle měření uprav konfiguraci a dotazy.
- [ ] **Step 4: Ověř:** testy úkolu, `timeout 170 node scripts/perf-measure.ts --documents 30000`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test reports`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `perf: pin the UI preset, cache keys and measured hot paths`

---

### Task 13: Testovací infrastruktura

**Files:**
- Create: `tests/e2e/global-teardown.ts`, `tests/e2e/process-registry.ts`
- Modify: `tests/e2e/fixtures.ts`, `playwright.config.ts`, `tests/e2e/onboarding.spec.ts`, `.github/workflows/ci.yml`, `README.md` (Vývoj), `tests/e2e/*` (dnešní datum přes `calendarDateInPrague`)
- Test: `tests/unit/process-registry.test.ts`, `tests/e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: `freshApp`, `waitForReady`
- Produces:
  - `recordProcess(pid: number): void`, `forgetProcess(pid: number): void`
  - `reapRecorded(dir: string, isOurs: (pid: number) => boolean): number[]`
  - `isFakturanNext(pid: number): boolean`, která čte `/proc/<pid>/cmdline` a `environ`

Spec: TST-004, TST-011, SET-001. Viz **[R-23]**, **[R-24]**. Přenosy plánu 6 (detached `next start`) a plánu 7 (shard přes 170 s, e2e dnes).

Pravidla:
- `freshApp` spouští `process.execPath` s `node_modules/next/dist/bin/next start`, bez `detached` a bez `pnpm`, a ukončí ho `child.kill('SIGTERM')`. Po 5 s pošle `SIGKILL`.
- Onboarding test ověří nadpis kroku 4 „Logo“, přeskočení a to, že Nastavení dodavatele po přeskočení nemá logo.
- `ci.yml` spouští backend po šesti shardech s vyloučeným `pdf-designs` a `pdf-designs` po čtyřech `-t`.

- [ ] **Step 1: Napiš testy**

```ts
test('[TST-004] reapRecorded ukončí jen zapsané procesy, které jsou náš next', ...)
test('[TST-004] cizí PID v registru se neukončí a zápis se smaže', ...)
test('[SET-001] krok 4 Logo jde přeskočit a dodavatel zůstane bez loga', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/process-registry.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test onboarding` a `smoke`. Pak `pgrep -af 'next start|next-server'` nesmí ukázat žádný proces z běhu. Proveď backend `--shard=N/6` pro N od 1 do 6 a změř časy do zprávy, každý pod 170 s. Nakonec `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `test(e2e): run next start without detached processes and split backend shards`

---

## Blok F: Mutační testy (TST-013)

### Task 14: Stryker po souborech a jádro na 90 %

**Files:**
- Create: `scripts/mutation.ts`, `scripts/mutation-summary.ts`, `stryker.map.json`
- Modify: `stryker.config.json`, `.gitignore` (`/reports/`), `package.json` (skripty `test:mutation:file`, `test:mutation:summary`), testy jádra podle přeživších mutantů, `tests/spec-partial.txt`
- Test: `tests/unit/*` a `tests/backend/*` jádra, `tests/unit/mutation-map.test.ts`

**Interfaces:**
- Consumes: `stryker.config.json`
- Produces:
  - `pnpm run test:mutation:file -- <soubor>[:<od>-<do>]`, který zapíše `reports/mutation/<soubor>.json`
  - `pnpm run test:mutation:summary`, které vypíše tabulku a skončí kódem 1 pod 90 %
  - `stryker.map.json: Record<string, string[]>` pro každý soubor z `mutate`

Spec: TST-013. Viz **[R-25]**, **[R-26]**.

Pravidla:
- `mutate` doplní `src/server/jobs/queue.ts`, `src/server/scheduler/lease.ts`, `src/server/scheduler/tick.ts` a `src/server/services/number-series.ts`.
- Jádro je `money`, `number-format`, `number-series`, `invoice-totals`, `qr-payload`, `payments`, `payment-matching`, `bank-notices/*`, `recurrence`, `czech-holidays`, `fx`, `cnb-rates`, `queue`, `lease` a `tick`. Každý soubor musí mít ≥ 90 %.
- Testy pro přeživší mutanty dostanou ID požadavku, který chrání (NUM, PAY, BNK, REC, ARC-007 a podobně).
- Do zprávy jde tabulka skóre a počet výjimek `Stryker disable` s důvody.

- [ ] **Step 1: Napiš test** `[TST-013] každý soubor v mutate má záznam ve stryker.map.json a mapované testy existují`.
- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/mutation-map.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** skripty a mapu, pak pro každý soubor jádra `timeout 170 pnpm run test:mutation:file -- <soubor>` a doplň testy, dokud soubor nemá ≥ 90 %.
- [ ] **Step 4: Ověř:** `timeout 170 pnpm run test:mutation:summary` pro jádro, unit, backend po shardech, `timeout 170 pnpm run test:coverage-spec`. Ověř `pgrep -af stryker`.
- [ ] **Step 5: Commit** `test(mutation): run Stryker per file and lift the core to 90 %`

---

### Task 15: Mutační skóre vstupů, ISDOC, obnovy a daní

**Files:**
- Modify: testy `tests/unit/safe-*.test.ts`, `tests/unit/xlsx-reader.test.ts`, `tests/unit/pdf-embedded.test.ts`, `tests/unit/decimal.property.test.ts`, `tests/unit/isdoc-parse.test.ts`, `tests/unit/isdoc-rules.test.ts`, `tests/backend/restore-hostile.test.ts`, `tests/backend/tax-report.test.ts`, `stryker.map.json`, `tests/spec-partial.txt`
- Test: stejné soubory

**Interfaces:**
- Consumes: `scripts/mutation.ts`, `stryker.map.json`
- Produces: skóre ≥ 90 % pro `src/lib/safe-input/*.ts`, `src/server/isdoc/parse.ts`, `src/server/isdoc/rules.ts`, `src/server/backup/remap.ts` a `src/server/reports/tax.ts`

Spec: TST-013, SEC-005, TST-015, TAX-001. Viz **[R-25]**, **[R-26]**.

Pravidla:
- Výchozí skóre z partial: decimal 86,30, csv 69,19, inflate 68,00, limits 69,35, xml 70,56, zip 71,35, pdf-embedded 56,65, xlsx-reader 74,00, isdoc parse 66,49, rules 71,22, remap 79,35, tax 73,47.
- Mapované testy zahrnou i backendové testy ISDOC.
- Když všechny soubory dosáhnou ≥ 90 %, odeber `TST-013` z partial. Jinak tam zůstane s přesnými čísly jen pro moduly plánu 8 a důvodem.

- [ ] **Step 1: Napiš testy** pro přeživší mutanty, s ID chráněného požadavku (SEC-005, IMP-003, TST-015, TAX-001, IMP-010).
- [ ] **Step 2: Ověř:** `timeout 170 pnpm run test:mutation:file -- <soubor>` před a po. Nové testy musí zabít dříve přeživší mutanty.
- [ ] **Step 3: Implementuj** jen testy. Změna produkčního kódu je povolená jen tam, kde odstraní nedosažitelnou větev, a zpráva ji jmenuje.
- [ ] **Step 4: Ověř:** `timeout 170 pnpm run test:mutation:summary`, unit, backend po shardech, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `test(mutation): lift input, ISDOC, restore and tax modules to 90 %`

---

## Blok G: Provoz a ukázka

### Task 16: Monitoring provozu a stav instance

**Files:**
- Create: `src/server/scheduler/ops-check.ts`
- Modify: `src/server/scheduler/start.ts`, `src/server/services/instance-status.ts`, `src/components/admin/*` (stav instance), `src/lib/texts.ts`, `docs/superpowers/specs/2026-10-30-fakturan-design.md` (kap. 18, **[R-29]**)
- Test: `tests/backend/ops-check.test.ts`, `tests/backend/admin-actions.test.ts`

**Interfaces:**
- Consumes: `reportFailure`, `registerTickTask`, `schedulerState`, `statfsSync`, `exchangeRate`, `job`
- Produces:
  - `opsCheck(now: Date, probe?: { statfs(path: string): { bavail: bigint; blocks: bigint; bsize: bigint } }): OpsFinding[]`
  - `reportedToday: Map<OpsFinding['key'], CalendarDate>` v paměti procesu. Po restartu může jedno hlášení přijít znovu, schéma se nemění
  - `OpsFinding = { key: 'disk' | 'fx' | 'heavy' | 'backup'; detail: Record<string, number | string> }`
  - `getInstanceStatus` + `filesBytes`, `freeBytes`, `fxLastDate`, `heavyQueued`, `heavyRunningSince`

Spec: ADM-008, MON-003, MON-004, OPS-004, OPS-005, FOR-004. Viz **[R-27]** až **[R-29]**. Přenosy plánů 4, 6 a 8 (místo na svazku, `fx.fetch` na produkci, retence).

Pravidla:
- Hlášení nese jen klíč a čísla, žádné cesty uživatelů, ID účtů ani obsah. `beforeSend` se nemění.
- `freeBytes` při `bavail = 0` a `blocks > 0` hlásí `disk` (přenos plánu 4, statfs).
- Velikost `files/` se počítá rekurzivním `statSync` nejvýš jednou za hodinu a v cache procesu. Stránka stavu instance nečeká na přepočet.

- [ ] **Step 1: Napiš testy**

```ts
test('[MON-003] volné místo 1,5 GiB nahlásí disk jednou za den', ...)
test('[MON-003] lístek ČNB z pondělí je ve čtvrtek starý, v úterý ne', ...)
test('[MON-003] těžká úloha běžící 31 minut nahlásí heavy', ...)
test('[MON-004] hlášení neobsahuje ID účtu, cestu ani e-mail', ...)
test('[ADM-008] stav instance ukáže velikost souborů, volné místo, poslední lístek a frontu', ...)
test('[OPS-004] health zůstává ok i při nálezu opsCheck', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/ops-check.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/scheduler.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test admin`, Docker po vrstvách a `docker-scheduler`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(ops): report disk, rates, heavy jobs and backups to monitoring`

---

### Task 17: Ukázková instance

**Files:**
- Create: `src/server/demo/seed.ts`, `src/server/demo/mode.ts`, `src/server/scheduler/demo-reset.ts`, `scripts/demo-seed-entry.ts`, `tests/backend/demo.test.ts`, `tests/e2e/demo.spec.ts`
- Modify: `src/server/env.ts`, `.env.example`, `src/server/services/mail-settings.ts` (`resolveTransport`), `src/server/services/bank-mailbox.ts`, `src/server/services/users.ts`, `src/server/auth/*` (registrace), `src/app/(auth)/*` (přihlášení), `src/server/scheduler/start.ts`, `Dockerfile` (bundle `demo-seed.mjs`), `README.md` (Ukázka), `docs/superpowers/specs/2026-10-30-fakturan-design.md` (OPS-007 a kap. 19.5), `src/lib/texts.ts`
- Test: `tests/backend/demo.test.ts`, `tests/e2e/demo.spec.ts`, `tests/unit/ops-files.test.ts`

**Interfaces:**
- Consumes: služby faktur, plateb, záloh, oprav, plánů, dashboardů, `clock`, `calendarDateInPrague` a interní cesta smazání účtu, kterou používá `deleteUser` v `users.ts`
- Produces:
  - `env.DEMO_MODE: boolean`, `env.DEMO_EMAIL`, `env.DEMO_PASSWORD` (povinné, když `DEMO_MODE`)
  - `isDemo(): boolean`, `isDemoAccount(userId: string): boolean`
  - `seedDemo(now: Date): Promise<{ userId: string; invoices: number }>`, idempotentní
  - `demoResetTask` ve 3:30 Prague
  - `node scripts/demo-seed.mjs` v obrazu

Spec: OPS-007 (nové), OPS-003, SEC-001, SEC-002, MAIL-004, TST-016. Viz **[R-31]**.

Pravidla:
- Zápis do spec, kap. 19.3: „**OPS-007** Volitelný režim ukázky (`DEMO_MODE`): jeden účet se smyšlenými daty, registrace a odesílání pošty vypnuté, účet se každou noc vrátí do výchozího stavu.“ Do kap. 19.5 přibudou tři proměnné.
- Data jsou smyšlená, IČO z `tests/fixtures` se seznamem smyšlených. Reálný doklad ani vzorek z `~/Downloads` se nikdy nepoužije (IMP-013).
- Reset smaže jen řádky `isDemoAccount` přes stejnou cestu jako smazání účtu, bez dotyku cizích účtů. Test to dokáže dvěma účty.
- README dostane oddíl „Ukázka“:
  - místo pro odkaz na ukázku (`https://…`, doplní uživatel);
  - přihlašovací údaje se berou z proměnných;
  - postup nasazení v Coolify: stejný obraz, vlastní svazek, `DEMO_MODE=1`, bez SMTP, `SENTRY_ENVIRONMENT=demo`, ruční nasazení;
  - jak spustit `node scripts/demo-seed.mjs` napoprvé.
- **Nic se nenasazuje.**

- [ ] **Step 1: Napiš testy**

```ts
test('[OPS-007] seedDemo založí 18 měsíců dat a assertConsistent projde', ...)
test('[OPS-007] druhé spuštění seedDemo nic nezdvojí', ...)
test('[OPS-007] noční reset vrátí ukázku a cizí účet nechá netknutý', ...)
test('[OPS-007] v režimu ukázky resolveTransport vrací null a nic neodejde', ...)
test('[OPS-007] registrace, změna hesla a smazání účtu ukázky jsou odmítnuté', ...)
test('[OPS-003] DEMO_MODE bez DEMO_PASSWORD aplikaci nespustí', ...)
test('[TST-016] reset ani seed nepošlou žádnou zprávu', ...)
test('[OPS-007] přihlášení ukáže údaje ukázky a Přehled má data', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/demo.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** režim, seed, reset a bundle v Dockerfile.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/env.test.ts`, `tests/backend/users.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test demo`, Docker po vrstvách a v obrazu `docker run … node scripts/demo-seed.mjs` nad dočasným svazkem, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(demo): add a seeded demo mode with nightly reset`

---

## Blok H: Dokumentace a Nápověda

### Task 18: Dokumentace, spec a uzavření seznamů

**Files:**
- Modify: `README.md`, `.env.example`, `docs/superpowers/specs/2026-10-30-fakturan-design.md`, `tests/spec-pending.txt`, `tests/spec-partial.txt`, tento plán (oddíl Známá omezení, jen doplnění)
- Test: celé sady po částech

**Interfaces:**
- Consumes: všechny předchozí úkoly
- Produces: README pro provozovatele a uživatele, aktuální spec, prázdný `tests/spec-pending.txt` kromě `UI-012`

Spec: OPS-003, OPS-005, SEC-009, kap. 23 bod 9, kap. 24.

Pravidla. README doplní: **Statistiky a dashboard:** sdílení JSON, cache a razítko. **Import, export, záloha a obnova:** mezisoubory, limity v2 a limit těla reverzní proxy 1 GiB. **Zahraniční faktury a zálohy.** **Ukázka nastavení:** SMTP, schránka avíz s `authserv-id`, `CNB_BASE_URL`, `ARES_BASE_URL`, `VIES_BASE_URL` a `TRUST_PROXY`. **Monitoring:** `SENTRY_DSN` pro GlitchTip a co se nikdy neposílá. **Provoz:** doporučená paměť kontejneru aspoň 1,5 GB a proč; kopie nočních záloh mimo svazek; retence archivů **[R-28]**; výkon z Task 12. **Postup vydání:** zvýšit `version` v `package.json`, přidat `tests/fixtures/db/<verze>.sql` (R-36 plánu 8), spustit `test:mutation:summary`, `pnpm audit`, Docker po vrstvách, ruční nasazení. **HTML e-maily:** sedm vzhledů a jak je vyzkoušet.

Spec a seznamy: **Spec:** IMP-011 dostane strop 200 000 položek a manifest v2. Kap. 24 uzavře, co je hotové (vzorek Fio, poradce a vzorky zůstávají). Navigace v kap. 20 dostane Nápovědu, kterou přidá Task 19. **`pnpm audit`:** výsledek jde do zprávy (SEC-009). **Kontrola seznamů:** v pending zůstane jen `UI-012`. V partial zůstanou jen ID z oddílu Pro uživatele a případně TST-013 podle Task 15.

- [ ] **Step 1: Ověř** `timeout 170 pnpm run test:coverage-spec` a že `tests/spec-pending.txt` obsahuje jen `UI-012`.
- [ ] **Step 2: Napiš dokumentaci** a zápisy do spec.
- [ ] **Step 3: Ověř celé sady:** unit, backend po šesti shardech, `pdf-designs` po `-t`, typecheck, lint, format:check, build, Playwright po souborech (`ls tests/e2e/*.spec.ts`, docker testy s `E2E_DOCKER_IMAGE`), Docker po vrstvách, coverage-spec, `pgrep -af 'next|vitest|playwright|stryker'` a `docker ps` bez zbytků.
- [ ] **Step 4: Commit** `docs: document operations, demo, e-mails and release steps`

---

### Task 19: Nápověda (UI-012), poslední úkol

**Files:**
- Create: `src/app/(app)/napoveda/page.tsx`, `src/components/help/help-index.tsx`, `src/components/help/help-faq.tsx`, `tests/e2e/help.spec.ts`
- Modify: `src/components/nav.ts`, `src/lib/texts.ts` (`TEXTS.help`, `TEXTS.nav.help`), `src/lib/quick-search.ts` (kapitoly), `docs/superpowers/specs/2026-10-30-fakturan-design.md` (navigace v kap. 20), `tests/unit/shell.test.ts`, `tests/spec-pending.txt`
- Test: `tests/unit/help.test.ts`, `tests/unit/shell.test.ts`, `tests/e2e/help.spec.ts`

**Interfaces:**
- Consumes: `NAV_ITEMS`, `staticHits`, hotové chování všech plánů
- Produces:
  - `TEXTS.help = { title; chapters: { id: string; title: string; body: string[]; links: { label: string; href: string }[] }[]; faq: { q: string; a: string }[] }`
  - `/napoveda#<id>`

Spec: UI-012, UI-006, UI-008, UI-009, UI-010. Viz **[R-30]**, **[R-32]**.

Pravidla:
- Kapitoly: první spuštění a průvodce; faktura od konceptu po úhradu; odeslání e-mailem a vzhled zprávy; platby a avíza Fio (česká avíza jen ručně); upomínky a souhrny; pravidelné faktury; zálohy a konečná faktura (stejný VS řady **[R-30]**); opravné faktury, stav „dobropisovaná“ a přeplatek; zahraniční faktury a kurzy ČNB; statistiky, dashboard a limity; daňový přehled s upozorněním; import, export, záloha a obnova; klávesové zkratky.
- FAQ má aspoň 12 otázek.
- Každý odkaz v kapitolách míří na existující route (test projde `src/app`).
- Žádné tvrzení o daních nad rámec `TEXTS.tax.disclaimer`.
- Z pending odeber `UI-012`, takže pending zůstane prázdný.

- [ ] **Step 1: Napiš testy**

```ts
test('[UI-012] Nápověda je v navigaci před Nastavením a má aspoň 12 otázek', ...)
test('[UI-012] každý odkaz v Nápovědě míří na existující stránku', ...)
test('[UI-012] daňové kapitoly nesou upozornění TEXTS.tax.disclaimer', ...)
test('[UI-010] Ctrl+K najde kapitolu „opravné faktury“', ...)
test('[UI-012] Nápověda se otevře z navigace, kotva skočí na kapitolu a FAQ jde rozbalit klávesnicí', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/help.test.ts`, FAIL.
- [ ] **Step 3: Napiš obsah a stránku** podle skutečného chování. Proti aplikaci ověř každý popsaný krok, u kterého si nejsi jistý.
- [ ] **Step 4: Ověř:** testy úkolu, unit, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test help`, `shell` a `quick-search`, `timeout 170 pnpm run test:coverage-spec` s prázdným pending, `pgrep` bez zbytků.
- [ ] **Step 5: Commit** `feat(help): add the help tab with guides and FAQ`

---

## Sebekontrola proti spec

| Oblast | Úkol | Poznámka |
|---|---|---|
| C-1, N-2, N-3, m-6 (plán 8) | 1 | **[R-1]** až **[R-4]** |
| Strop 28 000 a manifest 4 MiB | 2 | **[R-5]**, **[R-6]** |
| N-1, m-1, m-7, N-3 bloku C | 3 | **[R-7]** až **[R-9]** |
| T2b, align, resolveRate N+1 (plán 7) | 4 | **[R-10]**, **[R-11]** |
| IMP-005, m-4, m-5 | 5 | **[R-12]** až **[R-14]** |
| Drobnosti plánů 7 a 8 | 6 | Zbytek ve Známých omezeních |
| REM-010 | 7 | **[R-15]**, **[R-16]** |
| REM-011, REM-012 | 8 | Limity jen v `turnover-limits.ts`, ověřeno |
| MAIL-009 | 9, 10 | Ruší R-22 plánu 4, **[R-17]**, **[R-18]** |
| MAIL-010 | 10 | **[R-19]** |
| UI-010 | 11 | **[R-20]** |
| UI-002, ARC-005, měření | 12 | **[R-21]**, **[R-22]** |
| Fixture bez detached, shardy, krok Logo | 13 | **[R-23]**, **[R-24]** |
| TST-013 | 14, 15 | **[R-25]**, **[R-26]** |
| ADM-008, MON-003, místo na svazku, fx | 16 | **[R-27]** až **[R-29]** |
| Ukázka, README | 17 | OPS-007, **[R-31]** |
| Dokumentace, kap. 23 bod 9 | 18 | |
| UI-012 | 19 | Poslední **[R-32]** |
| Logo jako odkaz na Přehled | hotovo | `app-shell.tsx`, `Link href="/"` v obou hlavičkách (ruling plánu 7, Task 6) |
| Řady a stejný VS | nedělá se | **[R-30]** |
| TST-014, PDF-007, BNK-005, TST-006, IMP-000, IMP-002, TST-020 | zůstávají v partial | Oddíl Pro uživatele |

Kontroly plánu:
- **Pending:** všech osm ID z `tests/spec-pending.txt` má úkol.
- **Partial:** IMP-005 a TST-013 s plánem 9 mají úkol.
- **Názvy napříč úkoly:** `MemoryProbe`, `createMemoryGuard`, `spoolWriter` a `eachSpooled` (Task 1); `BACKUP_VERSION = 2` a `columns-v2.json` (Task 2, 7, 10); `openOwnedFile` (Task 3, 10); `documentQrPng`, `renderEmailHtml` a `emailAccent` (Task 9, 10); `user.report` (Task 7, 8); `staticHits` (Task 11, 19).
- **Migrace:** 0046 (Task 7) a 0047 (Task 10), čísla ověřit proti `drizzle/`.

## Známá rizika

- Celá položka `data/*.jsonl` do 200 MiB se při obnově drží jako bajty mimo haldu. Hlídač ji eviduje jako položku `entry`, ale proud položky po řádcích by vyžadoval změnu `readZipEntries` a ten se nemění **[R-4]**.
- Commit obnovy a potvrzení importu jsou jedna synchronní transakce. Zastaví celý proces, protože worker běží v procesu Next. Změřeno po opravě bloku A (Node 24, tento stroj, `t1-measure-experiment.test.ts`):
  - účet o 297 000 řádcích v poměru 1:3:1 a nejhorší tvar pro délku commitu (strop `maxLines`): **18,5 s**;
  - 75 000 faktur se 173 MiB dat: 11,9 s;
  - 780 šablon na stropu 256 KiB JSON (187 MiB): 3,8 s.
  Lease se obnovuje těsně před commitem (`renewHeavy`), takže rezerva je celých 120 s. Proti 90 s je to ~5×, proto se strop řádků nemění. Obnova se dá opakovat nejvýš 5× za hodinu (`restoreUser`).
- HTML e-mail vypadá v Outlooku jinak než v prohlížeči. Tabulky a inline styly to zmírní, ale ověření ve skutečných klientech je ruční **[R-17]**.
- Hlídač paměti eviduje, co obnova drží, podle změřených cen za položku. Pojistka 75 % haldy čte skutečnou haldu, takže souběžná práce jiného účtu může obnovu odmítnout dřív, což je bezpečný směr **[R-3]**.
- Reset ukázky v 3:30 může na chvíli kolidovat s přihlášeným návštěvníkem. Ten dostane prázdný stav do konce resetu **[R-31]**.
- E-mail o limitu hlídá jen DPH. Paušální daň zůstává jen na kartě a v centru upozornění **[R-16]**.

## Přenos do dalších plánů

Plán 9 je poslední. Co zůstává, je pro uživatele a do budoucna:

- **Po dokončení:** finální posudek celého projektu na modelu fable jen po výslovném svolení uživatele (RESTART.md, bod c), pak přehled rulingů.
- **Budoucí rozšíření** (kap. 2.4): API tokeny a MCP nad službami (ARC-001), proudové čtení položek ZIPu po řádcích, e-mail o limitu paušální daně.
- **Známá omezení** doplní Task 18. Patří sem zbylé drobnosti plánu 7, které Task 6 neuzavřel: heatmapa, popisky čar, pořadí DOM v editoru (WCAG 2.4.3), globální CSS RGL, `onConflictDoNothing` bez cíle, týdenní klíče `date_bucket`.
  A zbylé drobnosti plánu 8: XLSX se rozbaluje dvakrát, zahozená dávka jako „Selhalo“, číslo v exponentu (`1E-3`) jako neplatné, `XI` bez převodu a zahození dávky během nahrání, které nechá soubor do úklidu.

## Pro uživatele

Tyto body nejsou úkoly, protože je musí udělat nebo schválit člověk:

- **Fio:** dodat české avízo Fio a porovnat první reálné anglické avízo s fixturou (BNK-005, TST-006). Pak odebrat štítek prozatímnosti a zapnout automatické párování českých variant.
- **Schránka avíz:** nastavit `authserv-id` a ověřit, že nejvyšší `Authentication-Results` přidává příjemce. Vyhodnotit, zda výchozí `require_confirmation` nepřidává zbytečné kliky.
- **TST-014 a PDF-007:** schválit referenční PNG designů a pak doplnit reference dalších stran.
- **QR:** vyzkoušet v reálné bankovní aplikaci z PDF i z HTML e-mailu (B2, B3, B5), CZK i EUR s logem.
- **Daňový poradce:** doložka FOR-006, náležitosti neplátce, texty TAX a `TAX_TEXT_REVIEWED`, „Toto není daňový doklad“, pevný kurz FOR-010, limity 2 000 000,00 Kč a základ obratu, text lednové připomínky (REM-011).
- **Produkční svazek:** STARTTLS proti živému serveru a `statfs` (`bavail` není 0).
- **Rozhodnutí z předchozích plánů:** dnešní termín po dočasné reaktivaci (R-19 plánu 4); výchozí režim `draft` po záloze; storno plně vrácené zálohy s konceptem; stažení z vestavěného náhledu PDF bez auditu.
- **Import (TST-020, IMP-000, IMP-002):** porovnat součty se zdrojem na skutečných dokladech a dodat exporty Fakturoidu a iDokladu.
- **Ruční kontrola souborů:** otevřít XLSX v Excelu a LibreOffice, ISDOC v cizím validátoru, vytisknout PDF daňového přehledu.
- **HTML e-maily:** zkontrolovat v Gmailu, Outlooku a Apple Mail a potvrdit výchozí B4 a akcent.
- **GlitchTip:** založit projekt Fakturanu (v případě potřeby dočasně `ENABLE_ORGANIZATION_CREATION`) a nastavit `SENTRY_DSN` v Coolify. Token se nikam nevypisuje.
- **Nasazení ukázky v Coolify:** ručně a s vlastním svazkem. Do README doplnit odkaz. Reverzní proxy musí mít limit těla aspoň 1 GiB pro obnovu zálohy.
- **Procesy:** zkontrolovat, že po e2e nezůstávají procesy `next start` (dřívější cizí procesy na portu 3917 a další).
- **Fable:** svolení k finálnímu posudku.
