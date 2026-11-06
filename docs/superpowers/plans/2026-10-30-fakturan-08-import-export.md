# Fakturan 8: Import, export a daňový přehled – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uživatel přenese historii faktur z ISDOC, CSV a Excelu, vrátí import podle dávky, vyveze doklady a evidenci do PDF, ISDOC, CSV a Excelu, pošle klientovi ISDOC v příloze, získá roční daňový podklad a zálohuje celý účet tak, aby šel obnovit do prázdného účtu i na jiné instanci. Cizí soubor nikdy nepřekročí limity procesu, neopustí hranici účtu a nespustí žádnou automatiku.

**Architecture:** Nedůvěryhodné vstupy procházejí jednou vrstvou čtení `src/lib/safe-input/` s tvrdými limity a bez `server-only`. Každý formát se převede na společný model `ImportDocument`, další kroky formát neznají. ISDOC má vlastní modul `src/server/isdoc/` s parserem, generátorem, ručními pravidly a validací proti přiloženému XSD dané verze. Nahrání jde mimo server actions přes route handler na disk účtu, těžká práce běží ve frontě na samostatné dráze, aby nezdržovala poštu **[R-8]**. Daňový přehled staví na jádru `src/server/reports/`. Záloha popisuje každou tabulku a sloupec v registru `BACKUP_TABLES`, nový sloupec bez zařazení spadne v testu.

**Tech Stack:** Next.js 16.4, Drizzle, better-sqlite3, Zod, `fflate` (proudové `Unzip`, `Zip`, `Inflate`), `@react-pdf/renderer`, Vitest, fast-check, Playwright. Nové závislosti `saxes@6.0.0` **[R-4]** a `xmllint-wasm@5.3.0` **[R-2]**, obě s přesnou verzí. Žádná knihovna pro Excel ani PDF.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`, kap. 15 TAX-001 až 004, 16 IMP-000 až 013, 17 EXP-001 až 009, TST-015, TST-019, TST-020, ADM-009, INV-024, MAIL-001, ADV-005, TST-009, SEC-001, SEC-005, AUD-002, otevřené body kap. 24. Přenosy z konců plánů 1 až 7. Exporty pro Pohodu a Money S3 jsou v kap. 2.3 mezi věcmi, které se neplánují, a tento plán je nedělá.

## Global Constraints

- Správce balíčků je pnpm. Práce probíhá na `main`. Nic se nepushuje a nic se nenasazuje.
- **Plán navazuje na dokončený plán 7.** Při psaní plánu (1. 11. 2026) plán 7 implementovaný nebyl a v pracovním stromu souběžně přibývaly opravy jiné práce (`main` na `0f49e21`). Před Task 1 ověř čistý strom a existenci `src/server/reports/queries.ts`, `src/lib/tabular.ts`, `src/lib/xlsx-writer.ts`, `src/lib/sql-functions.ts`. Když chybí, zastav a ohlas to, plán 7 nesuplovat.
- **Harness přesouvá příkazy nad 180 s na pozadí.** Každý příkaz v popředí proto běží nejvýš 170 s (`timeout 170 …`) a dlouhé běhy se dělí po částech: `pnpm exec vitest run --project unit`, `pnpm exec vitest run --project backend --shard=N/4` a Playwright po jednotlivých souborech. **Nikdy nečekej na úlohu na pozadí.** Běh, který se do limitu nevejde, rozděl jemněji. Když to nejde, zapiš do zprávy úkolu „neověřeno“ s příkazem a nepředstírej úspěch.
- `pnpm build` před Playwrightem, protože fixture spouští `next start`.
- `minimumReleaseAge` se neobchází: žádný `--config` ani změna `pnpm-workspace.yaml`. Obě nové verze prošly 1. 11. 2026 zkušebním `pnpm add --lockfile-only` v prázdném projektu s pnpm 11.28.9. Když pnpm verzi odmítne, použij nejbližší starší, kterou přijme, a zapiš ji do zprávy úkolu.
- **Každou novou závislost ověř v Dockeru v úkolu, který ji přidává:** po vrstvách s `timeout 170`: `--target deps`, `--target build`, celý obraz, pak `E2E_DOCKER_IMAGE=fakturan-ci timeout 170 pnpm exec playwright test docker-scheduler`. Když krok buildu sám přesáhne limit, zapiš „Docker neověřen“ a neběž na pozadí. Nová závislost pro XSD zůstane jen tehdy, když projde Dockerem včetně kontroly `scripts/isdoc-smoke.mjs` v běhovém obrazu **[R-2]**.
- Implementeři neběží souběžně. Úkoly jdou po sobě a každý začíná z čistého stromu po commitu předchozího.
- **Po dokončení úkolu a odeslání výsledku nezanechávej detached procesy.** Před zprávou úkolu ukonči `next start`, testovací SMTP a IMAP, Stryker i kontejnery a ověř `pgrep -af 'next|vitest|playwright|stryker'` a `docker ps`.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů. Agent staguje jen své soubory.
- Komentáře jen pro neočividné invarianty. **UI texty česky a v `src/lib/texts.ts`** (`TEXTS.importing`, `TEXTS.exporting`, `TEXTS.tax`, `TEXTS.backup`), jen tokeny barev.
- **Migrace navazují po nejvyšší v `drizzle/`,** dnes `0038_advance_final_mode`, plán 7 přidá další: `pnpm exec drizzle-kit generate --name <jméno>`, číslo vždy ověř proti `drizzle/`. Rozšíření výčtů v TS (`FILE_KINDS`, `JOB_KINDS`, `EXCHANGE_RATE_SOURCES`, `NOTIFICATION_KINDS`) SQL nepotřebuje, pokud sloupec nemá `CHECK`. Ověř to ve vygenerovaném SQL.
- Service kód běží v testech i přes type stripping Node (`tests/helpers/*-worker.mjs`), proto žádné `constructor(readonly x)`, `enum` ani jiná syntaxe vyžadující transformaci. Týká se hlavně `src/lib/safe-input/`, `src/lib/backup-format.ts` a `src/server/isdoc/`.
- Před kódem v App Routeru přečti příslušný návod v `node_modules/next/dist/docs/` (viz `AGENTS.md`). Pro Task 4 `01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`, `…/proxyClientMaxBodySize.md` a `01-app/03-api-reference/03-file-conventions/route.md`.
- Název testu obsahuje ID požadavku, `tests/spec-pending.txt` se průběžně zmenšuje a každý úkol sám přesune ID, která v testech pojmenuje. `test:coverage-spec` selže na ID, které je zároveň v pending i v názvu testu. ID splněné jen zčásti a bez testu v pending zůstává. ID s testem, které ještě není splněné celé, jde do `tests/spec-partial.txt` (tři sloupce oddělené tabulátorem: ID, co chybí, plán). Úkoly to mají označené **[částečně]**.
- Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)`, tělo je synchronní. Import a obnova používají aktéra `source: 'import'`, ID vlastníka se bere z úlohy, ne ze souboru.
- **Každý dotaz na data účtu jde přes `scoped(ownerId)`, u spojení tabulek na obou stranách.** Nové tabulky `import_batch`, `mapping_preset`, `export_job` patří do `USER_OWNED_TABLES` před tabulky, na které odkazují bez kaskády. `exchange_rate` je instanční a do zálohy nepatří.
- Aktuální čas jen přes `clock`, „dnes“ přes `calendarDateInPrague`. Peníze jsou celá čísla, částky z cizích souborů se čtou jako desetinné řetězce, nikdy přes `Number` ani `parseFloat`.
- `dueSql` je jediný výraz aktuálního zůstatku. Příjmy jsou vždy `kind = 'payment'` včetně záporných vrácení, řádky `difference` nejsou příjem.
- **Skutečné faktury nikdy do repozitáře (IMP-013).** Lokální vzorek jsou ZIPy `~/Downloads/isdoc-faktury-*.zip` z Fakturovače. Implementer je smí použít jen ke zkušebnímu běhu mimo repozitář, nekopíruje je do stromu, necituje z nich údaje do testů, zpráv ani commitů a nikdy je necommituje. Totéž platí pro exporty kontaktů z Fakturoidu v téže složce.
- Testy nikdy nesahají na síť. Vstupy se validují na serveru sdíleným Zod schématem, které nepřijímá neznámé klíče.

## Review Focus

1. **Nedůvěryhodné soubory:** ZIP bomba s falešnou velikostí v hlavičce, vnořené archivy, cesty `../` a absolutní cesty, DOCTYPE, XXE a entitní bomby, hluboké XML, bomba v proudu PDF a v XLSX, přetečení velikosti při nahrání, kontrola obsahu místo přípony, jméno z archivu nikdy jako cesta (Task 1, 2, 4, 9).
2. **Izolace a obnova:** cílový účet jen z relace, nikdy z archivu, kontrola prázdného účtu ve stejné transakci, každé ID přemapované, žádný odkaz mimo archiv, soubor cizího účtu se nedá přečíst ani přepsat, stažení exportu cizím uživatelem je 404 (Task 3, 4, 6, 8, 9).
3. **Dvojí započtení a částky:** kladné dobropisy v ISDOC se ukládají záporně, záloha a její konečná faktura nesmí dát příjem dvakrát, `*Curr` částky u cizí měny, neuhrazené k 31. 12. podle stavu k tomu dni, ne podle dneška, rozdílný rok zálohy a faktury, odhadnutá data úhrady (Task 2, 4, 7).
4. **Ticho automatik:** importovaný ani obnovený doklad nesmí poslat upomínku, potvrzení, konečnou fakturu ani spárovat avízo. Po obnově je každý spínač vypnutý, `send_confirmed_at` je `NULL`, řádky ve frontě nezůstanou. Musí to dokázat SMTP test, ne jen příznak (Task 3, 9).
5. **Provoz a únik dat:** v záloze ani exportu není `*_enc` ani auth, dočasné soubory s osobními údaji mizí, smazání účtu je odstraní, dlouhá úloha nedrží poštu a přežije lease, XSD, wasm a schémata jsou v `standalone` obrazu, buňky se neutralizují a částky ne (Task 2, 6, 8, 10).

## Rozhodnutí plánu

Uživatel je pryč, proto plán rozhodl sám. Na `[R-n]` se odkazují úkoly. Čísla platí jen v tomto plánu.

- **[R-1] Schémata jsou lokální soubory.** `src/server/isdoc/schema/` nese `isdoc-invoice-6.0.2.xsd` a `isdoc-invoice-6.0.1.xsd` z `https://isdoc.cz/`, ověřeno 1. 11. 2026, oba staženy bez úprav. Hlavička 6.0.2 povoluje použití, kopírování, úpravy a šíření zdarma, pokud v kopiích zůstane copyright a odstavec svolení, a zakazuje používat jména SPIS, ICT UNIE a ISDOC k propagaci. Text jde i do `src/server/isdoc/schema/LICENSE.txt`, README ISDOC jen věcně uvádí. Test hlídá SHA-256 obou souborů. Validátor vybírá XSD podle atributu `version`. Export je vždy 6.0.2. Verze 6.0 a 6.0.0 nejsou na známých adresách (404) a na stránce MV není odkaz, proto jsou odmítnuté srozumitelnou chybou, stejně jako 5.x. Doklady z běžných systémů mají jít přes 6.0.1 nebo 6.0.2, ověří se na lokálním vzorku a odchylka jde do zprávy úkolu.
- **[R-2] XSD validuje `xmllint-wasm@5.3.0`.** Licence MIT, bez nativních částí, 0,9 MB, běží v `worker_threads` a jedno volání přijme pole dokumentů. Ověřeno 1. 11. 2026 v `node:24-bookworm-slim`: XSD 6.0.2 se načte za desítky ms a chyba uvádí chybějící element. **Neověřeno:** běh přes Next `standalone`, proto Task 2 přidá `scripts/isdoc-smoke.mjs` do běhového obrazu. Únikové body v tomto pořadí: `libxml2-wasm@0.7.2` (stejný test prošel, ale je synchronní a vyžaduje ruční `dispose`), jinak `libxml2-utils` v běhovém obrazu a `xmllint --nonet` přes `spawn`. Když neprojde nic, závislost se nepřidá a EXP-005 zůstane v partial s důvodem.
- **[R-3] Schematron se nespouští.** `isdoc-6.0.2.sch` vyžaduje XSLT 2 a v Node pro něj není rozumný běh. `src/server/isdoc/rules.ts` proto ručně kontroluje pravidla, která aplikaci ovlivňují: typy 2, 3 a 6 mají `OriginalDocumentReferences`, cizí měna má všechny `*Curr` částky, součty sedí. Běží na importu i exportu. Soubor `.sch` se nepřikládá.
- **[R-4] XML čte `saxes@6.0.0` s tvrdým odmítnutím DOCTYPE.** `saxes` je dnes přechodná závislost `jsdom`, stává se přímou. Parser nerozvíjí externí entity, ale `xmllint-wasm` se při zkoušce pokusil `file:///etc/passwd` načíst a zastavil ho jen virtuální souborový systém. Pořadí je proto vždy `saxes`, až pak XSD. Jakékoli `<!DOCTYPE`, `<!ENTITY` nebo vlastní entita je chyba. Soubor musí být platné UTF-8 (standard ISDOC to vyžaduje), jiné deklarované kódování je chyba. Hloubka nejvýš 32, nejvýš 200 000 uzlů, text uzlu nejvýš 64 KiB, jeden dokument nejvýš 5 MiB. `jsdom` se na cizí XML nepoužívá.
- **[R-5] ZIP se čte proudově a počítá se skutečný výstup.** `unzipSync` věří hlavičce, proto jen `Unzip` s `UnzipInflate` a `UnzipPassThrough`. Měřeno 1. 11. 2026 s fflate 0.8.3: jeden vstupní blok 16 KiB se rozbalil na 16,8 MiB, kontrola tedy běží až po bloku. Vstup jde po 4 KiB, takže přeběh nad limit je nejvýš asi 4 MiB, a po překročení se volá `terminate` a celý archiv je odmítnutý. Limity: 5 000 položek, 5 MiB na položku (u ISDOC a CSV), součet 200 MiB, poměr rozbalení nejvýš 200:1 od prvního 1 MiB výstupu. Stejný test ukázal, že `../evil.isdoc` dorazí nezměněný: jméno je jen popisek do náhledu, na disk se nikdy nepíše podle něj. Vnořený archiv a `.isdocx` uvnitř ZIPu se přeskočí s upozorněním, jinak by limity šly obejít. Šifrovaná položka a neznámá komprese jsou chyba. Samostatně nahraný `.isdocx` je obyčejný ZIP a čte se jeho ISDOC v kořeni.
- **[R-6] ISDOC z PDF čte vlastní malý skener, `pdfjs-dist` zůstává vývojová závislost.** `getAttachments()` by rozbalil přílohy bez limitu a backing store `ArrayBuffer` nepokrývá `resourceLimits` workeru, takže 5MB PDF by mohlo shodit kontejner. Proud přílohy nemůže být uvnitř objektového proudu, a jeho slovník s `/Type /EmbeddedFile` je tedy v souboru čitelný. `extractEmbeddedXml` najde tyto slovníky, rozbalí `FlateDecode` nebo nekomprimovaný proud přes omezený inflate a vrátí první obsah s kořenem `Invoice` v oboru ISDOC. Šifrované PDF nebo jiný filtr dá chybu „PDF nemá čitelný ISDOC“. PDF do 25 MB, jedna příloha do 5 MiB. Jméno `-isdoc.pdf` se nevyžaduje. Skener se ověří na lokálním vzorku, pokud v něm PDF je.
- **[R-7] Nahrání jde mimo server actions.** `experimental.serverActions.bodySizeLimit` je `3mb` a platí pro všechny akce, zvýšení na 25 MB by otevřelo každou akci. Route `POST /nastaveni/import/nahrani` čte syrové tělo, ne `formData`, kontroluje `origin`, relaci a `RATE_RULES.importUser`, odmítá podle `Content-Length` a znovu počítá proud (vzor `readCapped`), při překročení vrátí 413 a smaže rozepsaný soubor. Více samostatných souborů znamená více požadavků do jedné dávky se společným limitem. `src/proxy.ts` tuto cestu nepokrývá a nesmí: proxy by tělo uřízlo na 10 MB a matcher `/faktury/:id` by `/faktury/import` považoval za ID. Dočasné soubory jsou v `files/<userId>/`, takže je `removeUserDir` smaže s účtem. Názvy jsou nové UUID.
- **[R-8] Fronta má dvě dráhy.** Worker je jediný a dlouhá úloha by zdržela poštu. `claimNext(worker, kinds)` dostane filtr, `HEAVY_JOB_KINDS` jsou `import.parse`, `import.commit`, `export.run`, `backup.run`, `restore.run` a běží v druhé smyčce s nejvýš jednou úlohou. Dlouhá úloha po každém bloku dává `setImmediate` a každých 30 s obnoví lease přes `acquireLease(holder)`, který má 120 s. Výsledek `busy` nebo `taken_over` úlohu ukončí. `maxAttempts` je 1. Přerušený běh přes `recover` označí dávku nebo export `failed`, smaže dočasné soubory a uživatel akci spustí znovu. `jobInFlight` a vypnutí procesu znají obě dráhy.
- **[R-9] Dávka má stavy.** `import_batch.status`: `uploading`, `mapping`, `parsing`, `ready`, `committing`, `done`, `failed`, `undone`. Náhled je JSON v souboru účtu, ne v payloadu úlohy. Do fronty jdou jen ID. Úprava data a přeskočení řádku jsou server actions proti náhledu s revizí. Potvrzení přejde z `ready` na `committing` podmíněným `UPDATE`, takže dvojklik nezaloží dvě úlohy. Nepotvrzená dávka zmizí po 24 hodinách úlohou `import-cleanup`, protože nese osobní údaje. Po potvrzení se zdrojový soubor maže, zůstanou jen přiložená PDF.
- **[R-10] Import přijímá jen vydané doklady účtu.** IČO `AccountingSupplierParty` musí sedět s profilem dodavatele. Jinak je řádek chyba „doklad vystavil někdo jiný“, protože přijaté doklady jsou v kap. 2.3 mimo rozsah a přehled příjmů by lhal. Dodavatel bez IČO v profilu nebo ve zdroji dá náhled s výslovným potvrzením „je to můj doklad“. `supplier_snapshot` jde ze souboru, ne z profilu.
- **[R-11] Typy dokladů.** ISDOC 1 a 7 na `invoice`, 4 na `advance`, 2 na `credit_note`. Typy 3 (vrubopis), 5 a 6 (daňový zálohový list a jeho dobropis) se týkají plátců a jsou chyba řádku, kterou jde přeskočit. Export: `invoice` 1, `advance` 4, `credit_note` 2.
- **[R-12] Částky.** Dobropis je podle standardu vždy kladný, proto se při importu neguje a při exportu vrací kladný. U cizí měny platí `ForeignCurrencyCode` a částky `*Curr`, ne domácí. Celek je `TaxInclusiveAmount`, `net_minor` se přebírá doslova, protože cena na 2 místa nemusí součin zopakovat. Rozdíl součtu řádků proti celku jde do `rounding_minor`, nad 1,00 jednotky měny je to chyba řádku. Importovaná DPH se nerozepisuje (2.3), řádek nese částku včetně daně a náhled to ukáže. `assertConsistent` u `external` nepočítá `computeTotals`, ale kontroluje `subtotal - discount + rounding = total`.
- **[R-13] Kurz importu.** `EXCHANGE_RATE_SOURCES` dostane `import`. Kurz je `CurrRate / RefCurrRate` v mikrech s datem dokladu v `exchange_rate_date`. Když kurz chybí nebo je 1 u cizí měny, zůstává `exchange_rate_micros = NULL`, zdroj `import`, doklad se založí a v přehledech je v `unconverted`, nikdy neselže na `exchange_rate_source`. Výjimka je v `rateProblems` jen pro `external`.
- **[R-14] Úhrada z importu.** `PayableAmount = 0` založí platbu `source: 'import'`, `kind: 'payment'`, `paid_on` rovné splatnosti, jinak datu vystavení, a `payment.date_estimated = 1`. `0 < PayableAmount < celek` založí platbu na rozdíl, stav `partially_paid`, rovněž odhad. Platbu zapisuje `insertImportedPayment`, který nevolá `settleAdvance` ani `queueAutomaticReceipt`. Datum jde změnit v náhledu jednotlivě i hromadně, po potvrzení na detailu platby, a změna příznak zruší. Platby v cizí měně nesou `rate_micros` kurzem dokladu, protože ISDOC jiný nezná, a je to odhad. Dobropis platbu nedostává.
- **[R-15] Záloha a konečná faktura z importu.** `PaidDepositsAmount` s `NonTaxedDeposit` se páruje podle ID na zálohu v dávce nebo v účtu. Při shodě se nastaví `related_invoice_id`, projde `refreshBalance` a `superseded_at`, na konečné faktuře nevznikne platba. Bez shody vznikne platba s odhadem a varování „záloha nenalezena“. Bez této větve by příjem z úhrady zálohy šel dvakrát. Pořadí v dávce: zálohy, faktury, dobropisy.
- **[R-16] Dobropis potřebuje původní doklad.** `OriginalDocumentReference` se hledá podle UUID, pak podle čísla, v dávce a v účtu. Bez shody, v jiné měně nebo při přečerpání je to chyba řádku. Nezakládá se oprava bez vazby a nehádá se. `related_snapshot` se zmrazí stejně jako u vlastní opravy.
- **[R-17] Zákazníci.** Párování přes IČO, pak `foldText` jména. Víc shod nebo archivovaný zákazník dá v náhledu výběr. Chybějící se založí v dávce s `customer.import_batch_id`. Stávající zákazník se nikdy nepřepisuje, doklad nese údaje ze souboru. Duplicita IMP-007: stejné UUID nebo stejné číslo se přeskočí a vypíše, včetně duplicit uvnitř dávky. Klíčem je částečný unikátní index `(user_id, import_uuid)`, číslo hlídá `invoice_user_number_idx`.
- **[R-18] Importovaný doklad jde jen číst (IMP-005).** `assertEditable`, storno, opravná faktura, konečná faktura ze zálohy, odeslání, `markSent` a hromadné akce odmítají `external` v serverové vrstvě, ne jen v UI. Povolené: platba, její úprava, přiložení PDF, smazání přes `deleteImported`, které odmítne doklad s navázanou opravou. Číslo nezasahuje do řad, `allocateNumber` ho jen přeskočí díky `isNumberTaken`. Doklad má stav `issued` nebo podle platby, `sent_at` zůstává `NULL`, protože ho odsud nikdo neposlal. Přílohy mimo původní PDF zůstávají v 2.3 mimo rozsah.
- **[R-19] Importovaný doklad nespouští nic.** `isEligibleForReminder` vrací pro `external` vždy `false`, přepínač v tomto plánu nevzniká. `queueAutomaticReceipt` a `settleAdvance` se u `external` vracejí hned, i když platbu přidá člověk. `matchNotice` nikdy nevrátí `match` pro `external`, nový důvod fronty `external` nabídne doklad k ručnímu přiřazení. `dueAlerts` a pohledávky doklad dál ukazují, je to fakt, ne automatika.
- **[R-20] Vrácení dávky.** Jedna `mutate` smaže doklady dávky, jejich platby `source: 'import'`, řádky, přiložená PDF po commitu a zákazníky a položky ceníku založené dávkou, pokud na ně nic jiného neukazuje. Odmítne se, když je na dokladu ruční platba nebo oprava mimo dávku, hláška je jmenuje. Stav `undone` zůstává kvůli auditu.
- **[R-21] CSV a Excel bez nové knihovny.** `csv.ts` čte RFC 4180, BOM, oddělovač `;`, `,`, tab a kódování UTF-8 nebo `windows-1250` přes `TextDecoder` (obraz Node má plné ICU, ověř testem v Dockeru). `xlsx-reader.ts` čte přes bezpečný ZIP a `saxes` jen první list, `sharedStrings`, a z buňky s `<f>` jen uloženou hodnotu, vzorec nikdy nevyhodnocuje. Limit 50 000 řádků a 200 sloupců. Hodnota `'=SUM(A1)` z vlastního exportu ztratí jen apostrof před znakem spouštěče, jinak se data neupravují. Částky a data se parsují podle voleb v mapování. Faktury z CSV dávají stejný `ImportDocument`, bez `IssuingSystem` se zdroj zadá v průvodci.
- **[R-22] Předlohy IMP-002 jen z ověřených souborů.** `mapping_preset` s vlastními předlohami vzniká celý. Vestavěná předloha se přidá jen pro hlavičky ověřené na reálném souboru. Implementer smí lokálně přečíst pouze řádek hlavičky exportu z Fakturoidu v `~/Downloads`, nikdy data. Pro iDoklad a faktury z Fakturoidu vzorek není, IMP-002 jde do partial s bodem kap. 24.
- **[R-23] Export má jednu cestu.** Každý hromadný export je `export_job` a úloha `export.run`, i malý, ať není druhá větev. Formát `pdf_zip`, `isdoc_zip`, `csv`, `xlsx` u faktur a `customers`, `catalog`, `payments`, `templates` u evidence. Filtr je validovaný Zod schéma nad období, typ, zákazník (přes `ownedCustomerId`), stav, nebo seznam ID z hromadné akce do `MAX_BULK_DOCUMENTS`. Výsledek je v `files/<userId>/<id>`, ke stažení 7 dní, pak ho maže úloha `export-cleanup` a odkaz vrací 404. Stávající `faktury/hromadne-pdf` zůstává pro okamžité PDF. Šablony jsou JSON, nedají se importovat mimo zálohu. Přehled exportů je v Nastavení. Hotový export dá upozornění `export_ready`, ne e-mail.
- **[R-24] Mapování ISDOC exportu.** UUID: `invoice.import_uuid`, jinak `invoice.id`. Neplátce: `VATApplicable=false`, sazba 0, `TaxTotal` s jedinou daňovou skupinou. `ElectronicPossibilityAgreementReference` je prázdný. `IssuingSystem` je `Fakturan`. Sleva dokladu je záporný řádek, protože ISDOC slevu hlavičky nemá. Zaokrouhlení jde do `PayableRoundingAmount`, zálohy a platby do `PaidDepositsAmount` a `PayableAmount` je `amountDue`. Doložka `clause` a texty jdou do `Note`. Kurz z `exchange_rate_micros`, cizí měna doplní všechny `*Curr`, v domácích částkách je přepočet `toCzkMinor`. Koncepty se neexportují. Každý soubor projde XSD i `rules.ts` a selhání zastaví celou úlohu, neplatný doklad klient nedostane. Názvy položek v ZIPu projdou stejnou sanitací, `uniqueFileNames` se zobecní i na `.isdoc`.
- **[R-25] ISDOC v e-mailu (MAIL-001).** `email_log.attach_isdoc` se volí v dialogu, výchozí vypnuto. `sent_isdoc` se archivuje jako `sent_pdf`, opakované doručení tedy posílá stejný obsah. Když validace selže, zpráva se neodešle a záznam skončí `failed` s důvodem, tichý odeslaný mail bez přílohy by lhal. Automatické zprávy ISDOC nepřikládají.
- **[R-26] TAX, základ úhrada.** Příjmy roku jsou platby `kind = 'payment'` s `paid_on` v roce, přepočet `paymentCzkMinor` a pravidla [R-9] plánu 7. Vrácení je záporné v roce vrácení. Úhrada zálohy je příjem v roce úhrady, i když konečná faktura vznikla jinde nebo vůbec, a řádek uvede vazbu. Konečná faktura nepřidá nic kromě doplatku. Importované doklady se počítají. Řádky s `date_estimated` a bez kurzu jsou v součtu označené a přehled vypíše jejich počet a částku.
- **[R-27] TAX, základ vystavení.** Doklady mimo `NOT_IN_TOTALS`, `type <> 'advance'`, `issue_date` v roce, opravy se záporem v roce své vystavení, přepočet `documentCzkMinor`. Konečná faktura se bere celá, záloha sama nikdy.
- **[R-28] Neuhrazené k 31. 12. se skládají z historie.** `dueSql` je dnešní stav, proto vrací špatnou odpověď pro loňský rok. `unpaidAsOf(q, ownerId, date)` bere doklady s `issue_date <= date` mimo `draft` a `cancelled`, `type <> 'advance'`, a odečítá jen `credited_minor` plateb s `paid_on <= date`, opravy s `issue_date <= date` a uhrazenou zálohu do toho dne. Pro běžný rok se používá dnešek a nadpis to řekne. Doklad stornovaný později se nezobrazí, protože storno nemá datum, je to známé omezení v textu přehledu. Přepočet kurzem dokladu, doklad bez kurzu jde do `unconverted`.
- **[R-29] Texty TAX jsou návrh k ověření poradcem.** Upozornění TAX-004 je v `TEXTS.tax.disclaimer`, na stránce i ve všech výstupech, v CSV a Excelu jako první řádek. Znění: „Podklad z údajů ve Fakturanu. Nejde o daňové poradenství, před podáním přiznání údaje ověřte u daňového poradce.“ Nezmiňuje se paušál, výdaje ani výpočet daně. Do uzavření bodu v kap. 24 zůstávají popisky označené v kódu konstantou `TAX_TEXT_REVIEWED = false` a stránka má štítek „text čeká na ověření“.
- **[R-30] Formát zálohy.** ZIP `fakturan-zaloha-<datum>.zip`: `manifest.json` (`format: 'fakturan.account-backup'`, `v`, verze aplikace, poslední migrace, počty, SHA-256 všech položek), `data/<tabulka>.jsonl`, `files/<id>`, `audit.jsonl`. JSONL se píše po řádcích přes `ZipDeflate`, soubory a PDF přes `ZipPassThrough`, nic se nedrží celé v paměti. Manifest není podpis. Archiv je cizí vstup i tehdy, když ho vytvořil Fakturan.
- **[R-31] Co v záloze je, řídí registr.** `BACKUP_TABLES` v `src/server/backup/tables.ts` říká u každého sloupce každé vlastněné tabulky `copy`, `ref:<tabulka>`, `json-ids`, `owner` nebo `omit`. Zahrnuté musí být mimo jiné `invoice` celý (`foreign`, `clause`, `credits_minor`, `advance_minor`, `superseded_at`, `related_snapshot`, `exchange_rate_*`, `import_*`, `external`), `payment` (`rate_micros`, `source`, `date_estimated`), `supplier` (`advance_note_*`, `reverse_charge_*`), `preferences` (`fixed_rates`, limity plánu 7), `bank_notification` včetně `dedupe_key`, `invoice_version`, `recurring_*`, `reminder_*`, `email_log` včetně vazby na archiv `sent_pdf`, `dashboard`, `dashboard_widget`, `file` s bloby. Vynechané jsou `session`, `account`, `job`, `export_job`, tabulky auth a instance (`exchange_rate`, `rate_limit`), `smtp_password_enc`, celá `bank_mailbox`, protože bez hesla nemůže řádek existovat. `audit_log` jde jen do `audit.jsonl`. Test porovná schéma s registrem a neklasifikovaný sloupec nepustí. Změna seznamu vyžaduje zvýšení `v` a krok v `BACKUP_UPGRADES`, hlídá to otisk v `tests/fixtures/backup/columns-v1.json`.
- **[R-32] Obnova jen do prázdného účtu relace.** Cíl je `actor.userId`, `user_id` v archivu se nečte. Prázdný účet znamená žádný řádek v tabulkách registru, kromě výchozího dashboardu z `ensureDashboards` a automaticky vzniklých preferencí a jednotek, které obnova nahradí. Kontrola běží znovu uvnitř `mutate` s `behavior: 'immediate'`, takže souběžný zápis ji neobejde. Každá hodnota jde přes sloupcový Zod validátor odvozený z registru, neznámý klíč je chyba, `ref` musí mířit na ID z téhož archivu. Jméno `files/<id>` se hledá jen podle ID z manifestu, na disk jde pod novým UUID přes `writeBlob` s příznakem `wx`, takže nic nepřepíše. Starší `v` projde `BACKUP_UPGRADES`, novější je chyba. Archiv do 1 GiB. Chyba čehokoli znamená nulovou změnu účtu.
- **[R-33] Nová ID všude.** Tabulka starých a nových UUID vzniká předem pro všechna ID v archivu. Sloupce `ref` se přemapují, `json-ids` (`invoice_version.document`, šablony, `recurring_invoice.document`, `notification.params`, konfigurace widgetů) a textové klíče (`notification.dedupe_key`, `entity_id`) se projdou a nahradí se přesné výskyty známých UUID. `dedupe_key` u avíz je odvozený z banky, účtu a instrukce, ne z ID, zůstává beze změny, takže přečtené avízo znovu nezaplatí ([R-18] plánu 5). `email_log.message_id` se nemění.
- **[R-34] Stav po obnově.** `automation_settings` má všechny spínače `false` včetně `advance_invoice`, `recurring_send`, `reminders`, `payment_receipt`, `daily_digest`, `reminders_open_since` je `NULL`. `preferences.advance_final_mode` je `draft`. `recurring_invoice.send_confirmed_at` je `NULL`. `email_log` ve stavu `queued` a `sending` přejde na `cancelled`, protože fronta se neobnovuje a částečný index by jinak blokoval navždy. `unknown` zůstává, jen člověk ví, co se stalo. `mail_settings` bez hesla a `verified_at`. Účet dostane upozornění `backup_restored`, že je nutné znovu zadat SMTP a IMAP. Audit ze zálohy je soubor `audit_archive` ke stažení a do nového logu jde `account.restore` s počty a otiskem archivu, ne původní záznamy. Tabulka `exchange_rate` se doplní běžným dotažením.
- **[R-35] Odchylka od IMP-011 pro zálohu.** 25 MB platí pro import dokladů. Záloha s bloby se tam nevejde, proto má vlastní route a limit 1 GiB, stejně omezený i při vytvoření, s jasnou chybou. `fflate` neumí ZIP64, nesmí tedy ani tiše dojít ke 4 GiB. Task 10 větu doplní do IMP-011. Reverzní proxy nesmí mít nižší limit, jde to do přenosu.
- **[R-36] TST-019 bez vydaných verzí.** Žádná verze zatím vydaná nebyla. `tests/backend/migrations-upgrade.test.ts` proto aplikuje každý prefix `drizzle/` na prázdnou databázi s vloženými daty pro danou úroveň, dojede na konec a ověří `foreign_key_check`, `integrity_check` a `assertConsistent`. Bod vydání je soubor `tests/fixtures/db/<verze>.sql`, první je stav po tomto plánu a seznam čte test, takže vydání přidá jen soubor. Záloha a obnova se porovnají kanonicky: řádky po zpětném mapování ID a SHA-256 blobů se musí shodovat.
- **[R-37] TST-020 je ruční krok.** `scripts/import-compare.ts <soubor> <kopie.sqlite>` lokálně spočítá počty a součty podle roku a měny pro porovnání se zdrojem a nic nezapisuje do repozitáře. `.gitignore` dostane `*.isdoc`, `isdoc-faktury-*.zip` a `local-samples/` s výjimkou `tests/fixtures/isdoc/`. Test s ID jede nad smyšlenou fixturou, skutečný běh dělá uživatel a do té doby je ID v partial.
- **[R-38] Limity a audit.** `importUser` a `exportUser` už v `RATE_RULES` jsou. Přibývají `backupUser` 5 za hodinu a `restoreUser` 5 za hodinu. Akce auditu: `import.upload`, `import.commit`, `import.undo`, `import.date_edit`, `export.create`, `export.download`, `account.backup`, `account.backup_download`, `account.restore`, `tax.export`. Audit nese počty a formát, ne obsah souboru ani jména z archivu. Entita `account_backup` je účtová, stávající `backup` patří instanci. Stahování je `GET` s `scoped` a 404, s `Content-Disposition: attachment`, `nosniff` a `no-store`.
- **[R-39] Mimo tento plán:** ISDOC.PDF na výstupu, `.isdocx` na výstupu, podepisování, import přijatých dokladů, DPH, upomínky importovaných dokladů, exporty Pohoda a Money S3 (2.3), UI-010, UI-012, UI-002 do plánu 9.

---

### Task 1: Bezpečné čtení vstupů

**Files:**
- Create: `src/lib/safe-input/limits.ts`, `src/lib/safe-input/zip.ts`, `src/lib/safe-input/inflate.ts`, `src/lib/safe-input/xml.ts`, `src/lib/safe-input/csv.ts`, `src/lib/safe-input/xlsx-reader.ts`, `src/lib/safe-input/pdf-embedded.ts`, `src/lib/safe-input/decimal.ts`, `tests/helpers/hostile-files.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `Dockerfile` jen pokud to Docker vyžaduje
- Test: `tests/unit/safe-zip.test.ts`, `tests/unit/safe-xml.test.ts`, `tests/unit/safe-csv.test.ts`, `tests/unit/xlsx-reader.test.ts`, `tests/unit/pdf-embedded.test.ts`, `tests/unit/decimal.property.test.ts`

**Interfaces:**
- Consumes: `fflate`, `saxes`
- Produces:
  - `readZipEntries(source, limits, onEntry): Promise<ZipSummary>`, proudově, `InputRejected` s kódem a položkou
  - `boundedInflate(data, maxBytes): Uint8Array`
  - `parseXml(bytes, limits): XmlNode`
  - `parseCsv(bytes, options): { headers; rows; encoding; delimiter }`, `readXlsx(bytes, limits): SheetData`
  - `extractEmbeddedXml(bytes, limits): Uint8Array | null`
  - `decimalToMinor(text, scale): number`, `decimalToMicros(text): number`, `quantityToMilli(text): number`

Spec: SEC-005. Viz **[R-4]** až **[R-6]**, **[R-21]**.

Pravidla:
- Moduly nemají `server-only` ani přístup k disku a ke kódu aplikace. Berou bajty a vracejí data, takže je jde testovat samostatně a Stryker je pokryje.
- Typ se určuje z obsahu (`PK`, `%PDF-`, BOM, `<`), přípona je jen nápověda.
- Čtení je asynchronní po blocích s `setImmediate`, aby 25MB soubor neblokoval proces.
- `decimalToMinor` zaokrouhluje půl od nuly přes `BigInt`, odmítá exponent a přetečení `MAX_SAFE_INTEGER`.
- `hostile-files.ts` vyrábí útočné soubory v paměti: bombu s lživou hlavičkou, bombu s pravou hlavičkou, cestu ven, absolutní cestu, 6 000 položek, vnořený ZIP, šifrovaný příznak, PDF s proudem nad limit, XLSX se vzorcem.

- [ ] **Step 1: Napiš testy**

```ts
test('[SEC-005] ZIP s lživou velikostí v hlavičce skončí na skutečném výstupu', ...)
test('[SEC-005] poměr rozbalení nad 200:1 je odmítnutý a archiv nedá žádný výsledek', ...)
test('[SEC-005] položka ../evil.isdoc je jen popisek a nic se nezapíše', ...)
test('[SEC-005] vnořený ZIP se nerozbalí a je v upozorněních', ...)
test('[SEC-005] DOCTYPE s entitou je chyba dřív, než se cokoli rozvine', ...)
test('[SEC-005] miliarda smíchů i hloubka 33 jsou odmítnuté', ...)
test('[SEC-005] XML v UTF-16 a neplatné UTF-8 jsou odmítnuté', ...)
test('[SEC-005] PDF s proudem 6 MiB neprojde a ISDOC do 5 MiB ano', ...)
test('[SEC-005] XLSX s <f> vrací uloženou hodnotu, vzorec se nikam nedostane', ...)
test('windows-1250 s diakritikou a středníkem se přečte správně', ...)
// vlastnost: decimalToMinor odpovídá BigInt výpočtu pro všechny řetězce do 4 míst
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/safe-zip.test.ts tests/unit/safe-xml.test.ts`, FAIL.
- [ ] **Step 3: Přidej `saxes@6.0.0` s přesnou verzí a implementuj** moduly.
- [ ] **Step 4: Ověř:** všechny testy úkolu, `timeout 170 pnpm typecheck`, Docker po vrstvách, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(import): add bounded readers for untrusted files`

---

### Task 2: ISDOC: schéma, validace, čtení a zápis

**Files:**
- Create: `src/server/isdoc/schema/isdoc-invoice-6.0.2.xsd`, `src/server/isdoc/schema/isdoc-invoice-6.0.1.xsd`, `src/server/isdoc/schema/LICENSE.txt`, `src/server/isdoc/validate.ts`, `src/server/isdoc/rules.ts`, `src/server/isdoc/parse.ts`, `src/server/isdoc/build.ts`, `src/lib/import-document.ts`, `scripts/isdoc-smoke.mjs`, `tests/fixtures/isdoc/*.isdoc`, `tests/fixtures/isdoc/README.md`
- Modify: `next.config.ts`, `Dockerfile`, `package.json`, `pnpm-lock.yaml`, `.gitignore`, `tests/spec-pending.txt`
- Test: `tests/unit/isdoc-parse.test.ts`, `tests/unit/isdoc-rules.test.ts`, `tests/backend/isdoc-validate.test.ts`, `tests/backend/isdoc-build.test.ts`, `tests/backend/isdoc-roundtrip.property.test.ts`

**Interfaces:**
- Consumes: `parseXml`, `decimalToMinor`, `InvoiceDocument`, `amountDue`, `toCzkMinor`
- Produces:
  - `validateIsdoc(docs: { name; xml }[]): Promise<{ name; version; errors }[]>`
  - `isdocRules(xml: XmlNode): string[]`
  - `parseIsdoc(bytes): ImportDocument`
  - `buildIsdoc(doc: InvoiceDocument, context): string`
  - `ImportDocument` s číslem, UUID, typem, daty, stranami, položkami, měnou, částkami, kurzem, VS, účtem, odkazy, zálohami, `issuingSystem`

Spec: EXP-005, IMP-013, IMP-000 **[částečně]**, IMP-003 **[částečně]**, TST-015. Viz **[R-1]** až **[R-4]**, **[R-11]** až **[R-13]**, **[R-24]**.

Pravidla:
- Stáhni XSD z `https://isdoc.cz/6.0.2/xsd/` a `https://isdoc.cz/6.0.1/xsd/`, neupravuj a ověř hlavičku s licencí. Soubory se v testech čtou z disku, síť se nepoužívá.
- `next.config.ts`: `./src/server/isdoc/schema/**/*` do `outputFileTracingIncludes`, balík do `serverExternalPackages`. Čtení cesty přes `process.cwd()`, stejně jako fonty.
- `validate.ts` předává dokumenty po dávkách do 200 a jde do něj až výstup `parseXml`.
- Fixtury jsou smyšlené (Zkušební s. r. o., vymyšlená IČO s platným kontrolním součtem), strukturou podle standardu a podle toho, co implementer lokálně zjistí ze vzorku, bez jediné převzaté hodnoty. Sada: faktura CZK, EUR s `*Curr`, dobropis s odkazem, zálohová, konečná se zálohou, uhrazená, částečně uhrazená, 6.0.1, cizí dodavatel, vrubopis.
- `isdoc-smoke.mjs` v běhovém obrazu načte XSD ze stromu `standalone`, validuje fixturu vloženou do skriptu a skončí kódem 1 při selhání. Volá se jako `RUN` v kroku obrazu, vzor `pdf-smoke.mjs`.
- `parse.ts` zdroj nepředpokládá. `IssuingSystem` se přebírá jako text do 200 znaků.

- [ ] **Step 1: Napiš testy**

```ts
test('[EXP-005] faktura, záloha, dobropis i cizí měna projdou XSD 6.0.2', ...)
test('[EXP-005] rozbitý doklad vrátí chybu a jmenuje element', ...)
test('[EXP-005] verze se vybírá podle atributu a 5.3 je odmítnutá', ...)
test('[TST-015] zpětně přečtený export má stejné částky, typ, UUID a položky', ...)
test('[TST-015] sleva dokladu je záporný řádek a součet sedí', ...)
test('[IMP-003] dobropis z kladných částek je v modelu záporný', ...)
test('[IMP-003] EUR bere částky *Curr a kurz z CurrRate/RefCurrRate', ...)
test('[IMP-013] žádná fixtura neobsahuje IČO mimo seznam smyšlených', ...)
test('SHA-256 přiložených XSD odpovídá a LICENSE obsahuje odstavec svolení', ...)
// vlastnost: buildIsdoc → parseIsdoc zachová všechny peněžní částky
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/isdoc-parse.test.ts tests/backend/isdoc-validate.test.ts`, FAIL.
- [ ] **Step 3: Přidej `xmllint-wasm@5.3.0` a implementuj** moduly. Při selhání v Dockeru postupuj podle únikových bodů **[R-2]**.
- [ ] **Step 4: Ověř:** testy úkolu, `timeout 170 pnpm build`, Docker po vrstvách včetně `isdoc-smoke.mjs`, `timeout 170 pnpm run test:coverage-spec`. Lokálně mimo repozitář proženeš vzorek z `~/Downloads` jen přes `parseIsdoc` a `validateIsdoc`, do zprávy úkolu dáš jen počet dokladů, verze ISDOC a počet chyb.
- [ ] **Step 5: Commit** `feat(isdoc): add schema validation, parser and generator`

---

### Task 3: Model importu a pravidla importovaných dokladů

**Files:**
- Create: `drizzle/<n>_import_batch.sql`, `src/server/db/schema/import.ts`, `tests/fixtures/external-invoice.ts`
- Modify: `src/server/db/schema/invoice.ts`, `src/server/db/schema/customer.ts`, `src/server/db/schema/catalog.ts`, `src/server/db/schema/payment.ts`, `src/server/db/schema/file.ts`, `src/server/db/schema/job.ts`, `src/server/db/schema/index.ts`, `src/lib/fx.ts`, `src/lib/invoice.ts`, `src/lib/reminders.ts`, `src/lib/payment-matching.ts`, `src/server/services/invoice-versions.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/services/credit-notes.ts`, `src/server/services/advances.ts`, `src/server/services/invoice-mail.ts`, `src/server/services/payments.ts`, `src/server/services/payment-receipt.ts`, `src/server/services/bank-notices.ts`, `src/server/services/users.ts`, `src/server/jobs/queue.ts`, `src/server/jobs/worker.ts`, `src/server/scheduler/start.ts`, `tests/helpers/consistency.ts`, `tests/helpers/isolation.ts`, `tests/backend/silence.test.ts`, `tests/spec-pending.txt`
- Test: `tests/backend/external-invoices.test.ts`, `tests/backend/heavy-jobs.test.ts`, `tests/backend/silence.test.ts`, `tests/unit/payment-matching.test.ts`, `tests/unit/reminders.test.ts`

**Interfaces:**
- Consumes: `mutate`, `refreshBalance`, `applyPayments`, `claimNext`, `acquireLease`
- Produces:
  - tabulky `import_batch`, `mapping_preset`
  - sloupce `invoice.import_batch_id`, `invoice.import_uuid`, `invoice.source_system`, `customer.import_batch_id`, `catalog_item.import_batch_id`, `payment.date_estimated`
  - index `invoice_user_import_uuid_idx` na `(user_id, import_uuid)` s `WHERE import_uuid IS NOT NULL`
  - `FILE_KINDS` + `import_upload`, `import_pdf`, `sent_isdoc`, `export`, `audit_archive`
  - `JOB_KINDS` + `import.parse`, `import.commit`, `export.run`, `backup.run`, `restore.run`, `HEAVY_JOB_KINDS`
  - `insertImportedPayment(tx, audit, input)`, `deleteImported(actor, id)`, `assertNotExternal(row)`, `drainHeavy(worker)`

Spec: IMP-004, IMP-005, ochrana přenosů plánů 4, 5, 6. Viz **[R-8]**, **[R-13]**, **[R-14]**, **[R-18]**, **[R-19]**.

Pravidla:
- Schéma řeší `USER_OWNED_TABLES`: `mapping_preset` kdekoli, `import_batch` až za `invoice`, `customer` a `catalog_item`, protože ty na něj ukazují. Test v `users.test.ts` to pohlídá.
- `invoice.import_batch_id` nekaskáduje. Mazání dávky řeší jen `undoBatch` **[R-20]**.
- `isCreditable` a `isConvertibleAdvance` berou `external`, takže spadne i UI, ale kontrola musí být i ve službě. Filtr „Vytvořeno jinde“ a štítek se zdrojem dostávají reálná data.
- `matchNotice` dostává `external` v `MatchCandidate`. Nový důvod `external` jde do `TEXTS` a do ruční fronty. `splitNotice` a ruční přiřazení zůstávají.
- `tests/fixtures/external-invoice.ts` založí importovaný doklad přímo přes `insertImportedPayment` a veřejné pomocné funkce. Bez něj by matice automatik musela čekat na Task 4.
- `assertConsistent`: `external` podle **[R-12]** a **[R-13]**, `date_estimated` jen u `source = 'import'`, dokud ho člověk neupraví.
- Matice ticha `tests/backend/silence.test.ts` přidá řádek importovaného dokladu pro všechny automatiky včetně doběhu.
- `drainHeavy` nesmí držet `draining` a vypnutí procesu čeká na obě dráhy. Testy nesahají na stávající pořadí pošty.

- [ ] **Step 1: Napiš testy**

```ts
test('[IMP-004] importovaný doklad nemění počítadlo řady a číslo je obsazené', ...)
test('[IMP-005] úprava, storno, oprava a odeslání importovaného dokladu jsou odmítnuté službou', ...)
test('[IMP-005] úhradu a smazání povoluje, smazání s navázanou opravou ne', ...)
test('[TST-016] importovaný doklad po splatnosti nedostane upomínku ani po doběhu', ...)
test('[TST-016] ruční platba importované zálohy nezaloží konečnou fakturu ani potvrzení', ...)
test('[BNK-008] avízo se stejným VS a částkou importovaný doklad nespáruje, jde do fronty', ...)
test('[INV-024] hromadné odeslání importovaný doklad přeskočí a vypíše', ...)
test('[ARC-007] běžící export nezdrží mail.send a druhá těžká úloha čeká', ...)
test('[TST-017] přerušená těžká úloha skončí failed a uklidí dočasný soubor', ...)
test('[ADM-006] smazání účtu odstraní dávky, předlohy a dočasné soubory', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/external-invoices.test.ts tests/backend/heavy-jobs.test.ts`, FAIL.
- [ ] **Step 3: Vygeneruj migraci a implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `timeout 170 pnpm exec vitest run tests/backend/silence.test.ts tests/backend/users.test.ts`, `pnpm exec vitest run --project backend --shard=N/4` pro N od 1 do 4 s `timeout 170`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(import): add batches and read-only imported documents`

---

### Task 4: Import ISDOC s náhledem, potvrzením a vrácením

**Files:**
- Create: `src/server/services/import-batch.ts`, `src/server/services/import-parse.ts`, `src/server/services/import-commit.ts`, `src/server/services/import-undo.ts`, `src/server/files/upload.ts`, `src/app/(app)/nastaveni/import/page.tsx`, `src/app/(app)/nastaveni/import/[id]/page.tsx`, `src/app/(app)/nastaveni/import/actions.ts`, `src/app/(app)/nastaveni/import/nahrani/route.ts`, `src/components/import/upload-zone.tsx`, `src/components/import/import-preview.tsx`, `src/components/import/import-progress.tsx`, `tests/e2e/import-isdoc.spec.ts`
- Modify: `src/server/files/store.ts`, `src/server/services/files.ts`, `src/server/rate-limit.ts`, `src/server/scheduler/start.ts`, `src/lib/automation.ts`, `src/lib/texts.ts`, `src/app/(app)/nastaveni/layout.tsx`, `src/components/invoices/*` pro štítek zdroje a přiložené PDF, `tests/backend/actions-isolation.test.ts`, `tests/helpers/isolation.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/backend/import-batch.test.ts`, `tests/backend/import-isdoc.test.ts`, `tests/backend/import-undo.test.ts`, `tests/backend/import-upload.test.ts`, `tests/backend/import-crash.test.ts`, `tests/backend/actions-isolation.test.ts`, `tests/e2e/import-isdoc.spec.ts`

**Interfaces:**
- Consumes: `readZipEntries`, `extractEmbeddedXml`, `parseIsdoc`, `validateIsdoc`, `insertImportedPayment`, `enqueue`
- Produces:
  - `createBatch(actor, kind)`, `storeUpload(actor, batchId, stream, meta)`, `startParse(actor, batchId)`
  - `getPreview(ownerId, batchId)`, `editPreview(actor, batchId, revision, change)`, `confirmBatch(actor, batchId, revision)`, `undoBatch(actor, batchId)`
  - `runImportParse(job)`, `runImportCommit(job)`, `purgeStaleBatches(now)`
  - `PreviewRow = { key; source; document; status: 'ok' | 'warning' | 'error' | 'duplicate' | 'skipped'; messages; customerAction; paidOn; dateEstimated }`

Spec: IMP-000, IMP-003, IMP-006, IMP-007, IMP-008, IMP-009, IMP-011, IMP-012, SEC-001, SEC-002, AUD-002. Viz **[R-5]** až **[R-10]**, **[R-14]** až **[R-17]**, **[R-20]**.

Pravidla:
- Route nedělá nic než kontrolu, zápis proudu na disk a `import.upload` audit. Klient stahuje stav přes server action s prodlevou 1 s a `import_batch.progress`.
- Potvrzení je jedna `mutate` s `source: 'import'`. IMP-009: řádek s chybou zablokuje potvrzení, dokud ho uživatel nepřeskočí. Limit 5 000 dokladů v dávce, protože celá transakce běží synchronně. Změř dobu 5 000 dokladů a zapiš ji do zprávy úkolu.
- Těsně před zápisem se znovu ověří duplicity i zákazníci, protože mezi náhledem a potvrzením může uživatel doklady měnit.
- Audit jde za každý doklad a zákazníka v téže transakci (AUD-001), plus souhrn dávky.
- PDF se stejným kmenem jako ISDOC v ZIPu nebo PDF nesoucí ISDOC se uloží jako `import_pdf`, dostupné přes `soubory/[id]` jen vlastníkovi, s `attachment`.
- Hromadné datum v náhledu: pro vybrané řádky nastav datum, nebo „podle splatnosti“, „podle vystavení“. Datum po dnešku je chyba.
- IMP-012: ověř na vzorku, že `PayableAmount` 0 skutečně znamená uhrazeno. Spec to tvrdí pro Fakturovač, ostatní systémy mohou vyplňovat jinak, proto náhled ukazuje počet „uhrazených z importu“ a datum jako odhad.
- E2E běží s `tests/fixtures/isdoc/` zabalenými do ZIPu v testu. Po importu `assertConsistent`.
- Partial: `IMP-000` „Fakturoid, iDoklad, SuperFaktura, Vyfakturuj a ABRA Flexi jsou ověřené jen z dokumentace“, kap. 24.

- [ ] **Step 1: Napiš testy**

```ts
test('[IMP-011] 25 MiB + 1 B skončí 413 a na disku nic nezůstane', ...)
test('[IMP-011] lživý Content-Length neobejde počítání proudu', ...)
test('[IMP-011] průběh se mění a zpracování běží na pozadí', ...)
test('[SEC-001] překročení importUser vrátí 429 a zapíše audit', ...)
test('[SEC-002] cizí dávku nejde zobrazit, upravit, potvrdit ani vrátit', ...)
test('[SEC-002] nahrání s cizím batchId je 404 a nic nezapíše', ...)
test('[IMP-000] jeden .isdoc, ZIP i PDF s ISDOC dají stejný náhled', ...)
test('[IMP-003] převezme číslo, UUID, typ, data, zákazníka, položky, měnu, částky, VS a účet', ...)
test('[IMP-006] páruje podle IČO, pak jména a chybějící založí', ...)
test('[IMP-007] stejné UUID nebo číslo se přeskočí a vypíše, i uvnitř dávky', ...)
test('[IMP-008] chyba posledního dokladu nezapíše nic', ...)
test('[IMP-008] vrácení smaže doklady, platby a nové zákazníky, staré nechá', ...)
test('[IMP-008] vrácení s ruční platbou je odmítnuté a jmenuje doklad', ...)
test('[IMP-009] chybný řádek zablokuje potvrzení, po přeskočení projde', ...)
test('[IMP-012] PayableAmount 0 založí platbu s odhadem a hromadná úprava ho změní', ...)
test('doklad jiného dodavatele je chyba řádku', ...)
test('[ADV-005] úhrazená záloha a její konečná faktura dají příjem jednou', ...)
test('[TST-017] pád uvnitř import.commit nezanechá částečnou dávku', ...)
test('[IMP-000] od ZIPu po detail s štítkem a vrácení dávky', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/import-upload.test.ts tests/backend/import-isdoc.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** služby, route a stránky.
- [ ] **Step 4: Ověř:** testy úkolu, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test import-isdoc`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(import): import ISDOC documents with preview and undo`

---

### Task 5: Průvodce CSV a Excelu

**Files:**
- Create: `src/lib/import-mapping.ts`, `src/lib/import-presets.ts`, `src/server/services/import-tabular.ts`, `src/server/services/mapping-presets.ts`, `src/components/import/column-mapper.tsx`, `tests/fixtures/import/*.csv`, `tests/e2e/import-csv.spec.ts`
- Modify: `src/server/services/import-parse.ts`, `src/server/services/import-commit.ts`, `src/server/services/customers.ts`, `src/server/services/catalog.ts`, `src/app/(app)/nastaveni/import/actions.ts`, `src/app/(app)/nastaveni/import/[id]/page.tsx`, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/unit/import-mapping.test.ts`, `tests/backend/import-tabular.test.ts`, `tests/e2e/import-csv.spec.ts`

**Interfaces:**
- Consumes: `parseCsv`, `readXlsx`, `customerInputSchema`, `catalogInputSchema`, `PreviewRow`
- Produces:
  - `mappingSchema` (cíl `customers`, `catalog`, `invoices`, sloupce, formát data, desetinný oddělovač, měna, zdroj)
  - `applyMapping(sheet, mapping): MappedRow[]`, `saveCustomerIn(tx, audit, …)`, `saveCatalogItemIn(tx, audit, …)`
  - `listPresets(ownerId)`, `savePreset(actor, input)`, `deletePreset(actor, id)`

Spec: IMP-001, IMP-002 **[částečně]**. Viz **[R-17]**, **[R-21]**, **[R-22]**.

Pravidla:
- Kroky: nahrání, mapování, náhled, kontrola chyb, potvrzení. Stav `mapping` čeká na schéma sloupců. Náhled mapování ukáže prvních 20 řádků.
- Řádek faktury jde přes stejný `ImportDocument`, `PreviewRow` a `confirmBatch` jako ISDOC. Žádný druhý zápis dokladu.
- Zákazníci a ceník používají stávající Zod schémata. `saveCustomer` a položka ceníku se rozdělí na variantu v transakci a tenký obal, bez změny chování.
- Sloučení vícerádkových faktur: sloupec čísla určuje doklad, další řádky jsou položky. Řádky bez čísla jsou chyba.
- Předloha je jen mapování, nic z dat. Jde do `USER_OWNED_TABLES` a do zálohy.
- E2E pokrývá kritický tok „import z CSV“ ze spec.

- [ ] **Step 1: Napiš testy**

```ts
test('[IMP-001] CSV zákazníků projde mapováním, náhledem a potvrzením', ...)
test('[IMP-001] XLSX ceníku se načte přes stejný průvodce', ...)
test('[IMP-001] CSV faktur v EUR dá stejné částky jako ISDOC', ...)
test('[IMP-002] uložená předloha se použije na další soubor a cizí není vidět', ...)
test('[IMP-009] chybné datum uvede řádek, sloupec a hodnotu', ...)
test('hodnota =HYPERLINK se uloží jako text a v exportu je neutralizovaná', ...)
test('[IMP-001] průvodce od CSV po zákazníka v seznamu', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/import-mapping.test.ts tests/backend/import-tabular.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.** Hlavičku exportu Fakturoidu ověř lokálně podle **[R-22]**.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/customers.test.ts`, `tests/backend/catalog.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test import-csv`, `timeout 170 pnpm run test:coverage-spec`. `IMP-002` do partial: „Vestavěné předlohy čekají na reálné soubory Fakturoidu a iDokladu“, kap. 24.
- [ ] **Step 5: Commit** `feat(import): add CSV and Excel wizard with saved mappings`

---

### Task 6: Hromadné exporty a ISDOC v e-mailu

**Files:**
- Create: `drizzle/<n>_export_job.sql`, `src/server/db/schema/export.ts`, `src/lib/export-filter.ts`, `src/server/files/zip-writer.ts`, `src/server/services/exports.ts`, `src/server/services/export-run.ts`, `src/app/(app)/nastaveni/export/page.tsx`, `src/app/(app)/nastaveni/export/actions.ts`, `src/app/(app)/nastaveni/export/[id]/route.ts`, `src/components/export/export-form.tsx`, `tests/e2e/export.spec.ts`
- Modify: `src/lib/xlsx-writer.ts`, `src/lib/tabular.ts`, `src/lib/mail-send.ts`, `src/server/db/schema/mail.ts`, `src/server/db/schema/index.ts`, `src/server/services/invoice-pdf.ts`, `src/server/services/invoice-mail.ts`, `src/server/services/mail-delivery.ts`, `src/server/services/files.ts`, `src/server/services/users.ts`, `src/server/scheduler/start.ts`, `src/components/invoices/*` pro hromadnou akci a dialog, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/unit/export-filter.test.ts`, `tests/unit/xlsx-writer.test.ts`, `tests/backend/exports.test.ts`, `tests/backend/export-isdoc.test.ts`, `tests/backend/invoice-mail.test.ts`, `tests/backend/actions-isolation.test.ts`, `tests/e2e/export.spec.ts`

**Interfaces:**
- Consumes: `buildIsdoc`, `validateIsdoc`, `isdocRules`, `invoicePdf`, `tabular`, `xlsx-writer`, `HEAVY_JOB_KINDS`
- Produces:
  - `export_job` (`id`, `user_id`, `kind`, `format`, `filter`, `status`, `progress`, `file_id`, `reason`, `expires_at`, časy)
  - `createExport(actor, input): { id }`, `listExports(ownerId)`, `openExport(actor, id)`, `runExport(job)`, `purgeExpiredExports(now)`
  - `zipFileWriter(path): { addStored; addDeflated; close }`
  - `buildSheets` v `xlsx-writer.ts`, více listů proudově
  - `attachIsdoc` v `sendInputSchema`, `email_log.attach_isdoc`, `archiveSentIsdoc`

Spec: EXP-001, EXP-002, EXP-003, EXP-005, EXP-007, EXP-008, EXP-009 **[částečně]**, INV-024, MAIL-001, SEC-001, SEC-002, AUD-002. Viz **[R-8]**, **[R-23]** až **[R-25]**.

Pravidla:
- `zip-writer.ts` píše synchronně do otevřeného souboru s `fsync` před přejmenováním a hlídá 1 GiB. Rozepsaný soubor úspěšný výsledek nikdy nezobrazí.
- Názvy položek z `fileNameFor` prochází sanitací, která odmítá `/`, `\\`, `..`, řídicí znaky a zachovává českou diakritiku. `uniqueFileNames` přestane předpokládat `.pdf`.
- Excel používá `inlineStr` a každá textová buňka jde přes neutralizaci EXP-008, částka zůstává číslem. Excel faktur má list dokladů a list položek, CSV jen doklady s počtem položek, výběr uvádí, co soubor obsahuje.
- `export.run` čte přes `Reader` po stránkách 200 dokladů. Filtr drží vlastníka, ID z hromadné akce se znovu ověřují v úloze, cizí ID celou úlohu odmítne.
- PDF, šablony a ISDOC v ZIPu nesmí nést `*_enc`. Test rozbalí každý výstup a hledá hodnoty tajemství vložené do fixtury.
- Stažení `GET` s `scoped`, vypršení 404, audit `export.download`, proud z disku bez načtení do paměti.
- MAIL-001: příloha ISDOC je jen u dokladu mimo koncept a v dialogu je vypnutá ve výchozím stavu. Při selhání validace `email_log.status` je `failed`, `reason` je kód a žádná úloha nezkouší znovu. TST-005 ověřuje přílohu v testovacím SMTP a čte ji přes `parseIsdoc`.
- Z partial odeber `MAIL-001` a `INV-024`, `TST-015` po doplnění zpětného čtení. `EXP-009` zůstává částečně do Task 8.

- [ ] **Step 1: Napiš testy**

```ts
test('[EXP-001] ZIP PDF, ZIP ISDOC, CSV i Excel obsahují vybrané doklady', ...)
test('[EXP-002] filtr období, typu, zákazníka a stavu se protínají, cizí zákazník dá prázdno', ...)
test('[EXP-003] export zákazníků, ceníku, plateb a šablon', ...)
test('[EXP-005] neplatný ISDOC zastaví export a nic se nestáhne', ...)
test('[EXP-007] výsledek je 7 dní, po vypršení 404 a soubor zmizí', ...)
test('[EXP-007] úloha běží na pozadí s průběhem', ...)
test('[EXP-008] =1+1 je neutralizované, -500,00 zůstává číslo', ...)
test('[EXP-009] žádný výstup neobsahuje heslo ani jeho šifrovaný tvar', ...)
test('[SEC-002] cizí export je 404 a neprozradí existenci', ...)
test('[INV-024] hromadná akce vyveze vybrané doklady', ...) // e2e
test('[MAIL-001] klient dostane ISDOC a opakované doručení pošle stejný obsah', ...)
test('[MAIL-001] neplatný ISDOC zprávu neodešle', ...)
test('jméno ../../x v čísle dokladu nevytvoří cestu v archivu', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/exports.test.ts tests/backend/export-isdoc.test.ts`, FAIL.
- [ ] **Step 3: Vygeneruj migraci a implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/invoices-list.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test export`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(export): add background exports and ISDOC mail attachment`

---

### Task 7: Daňový přehled

**Files:**
- Create: `src/server/reports/tax.ts`, `src/server/services/tax-report.ts`, `src/server/pdf/tax-overview.tsx`, `src/app/(app)/prehledy/dane/page.tsx`, `src/app/(app)/prehledy/dane/export/route.ts`, `src/components/reports/tax-overview.tsx`, `tests/fixtures/tax-scenario.ts`, `tests/e2e/tax.spec.ts`
- Modify: `src/lib/texts.ts`, `src/lib/report-filter.ts`, `src/server/rate-limit.ts` jen je-li potřeba, `src/components/reports/report-tabs.tsx`, `tests/helpers/consistency.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/backend/tax-report.test.ts`, `tests/backend/tax-export.test.ts`, `tests/backend/consistency.test.ts`, `tests/e2e/tax.spec.ts`

**Interfaces:**
- Consumes: `paymentCzkMinor`, `documentCzkMinor`, `fx_czk`, `NOT_IN_TOTALS`, `tabular`, `xlsx-writer`, `Reader`, `scoped`
- Produces:
  - `taxOverview(q, ownerId, { year, basis: 'paid' | 'issued' }, today): TaxOverview`
  - `unpaidAsOf(q, ownerId, date): UnpaidRow[]`
  - `TaxOverview = { year; basis; lines; totalCzkMinor; unpaid; unpaidCzkMinor; estimated: { count; czkMinor }; unconverted; asOf }`
  - `exportTaxOverview(actor, input, format: 'pdf' | 'xlsx' | 'csv')`

Spec: TAX-001 až TAX-004, ADV-005, IMP-012, přenos plánu 6. Viz **[R-26]** až **[R-29]**.

Pravidla:
- `tax.ts` jako `queries.ts`, bez `server-only`, nad `Reader`. Nezkopíruje `incomeSeries`: sdílí podmínky a přepočet.
- Výchozí základ je úhrada. Rok se volí, výchozí je předchozí kalendářní rok v období do 31. 3., jinak běžný.
- Stránka je uvnitř Statistik, čte cache s klíčem podle plánu 7 **[R-14]**, export počítá přímo a jde přes `POST` s origin a `tax.export`.
- PDF používá stávající fonty a `renderInvoicePdf` se nemění. Dlouhý seznam stránkuje, opakuje hlavičku a uvádí upozornění na každé straně.
- `assertConsistent` přidá `taxProblems`: součet řádků odpovídá `totalCzkMinor` a pro každý rok nezávisle v JS z plateb odpovídá `taxOverview`, a `unpaidAsOf(today)` odpovídá `amountDue` nad otevřenými doklady.
- Z partial odeber `ADV-005`. Do `TST-018` přibude TAX jen v rámci `assertConsistent`, ID už uzavřené je.
- Fixture `tax-scenario.ts` staví na `report-scenario.ts`, dnes 2. 11. 2026, a doplní doklady:
  - H: faktura 1 000,00 z 20. 12. 2025, uhrazena 3. 1. 2026.
  - I: záloha 5 000,00 uhrazená 28. 12. 2026 a konečná faktura z 5. 1. 2027, čas testu 10. 1. 2027.
  - J: faktura 2 000,00 z 15. 12. 2025 a oprava -500,00 z 2. 1. 2026, neuhrazená.
  - K: faktura 3 000,00 z 2025 uhrazená 20. 12. 2025, vrácení -3 000,00 z 15. 1. 2026.
  - L: importovaná 1 200,00 s odhadnutým datem úhrady.
  - M: faktura 100,00 EUR bez kurzu platby a bez lístku v okně 7 dnů.

- [ ] **Step 1: Napiš testy**

```ts
test('[TAX-001] rok 2026 má příjmy 41 650,00 Kč a seznam plateb', ...)
test('[TAX-001] vrácení z roku 2026 sníží rok 2026 a rok 2025 nezmění', ...)
test('[ADV-005] záloha uhrazená 2026 a faktura 2027 je příjem jen v 2026', ...)
test('[ADV-005] ve výstavním základu je jen konečná faktura v 2027', ...)
test('[TAX-001] H je neuhrazená k 31. 12. 2025, i když je dnes uhrazená', ...)
test('[TAX-001] J k 31. 12. 2025 dluží 2 000,00, oprava je až z ledna', ...)
test('[TAX-002] výchozí základ je úhrada, vystavení dá 44 100,00 Kč', ...)
test('[TAX-003] PDF, Excel a CSV mají stejný součet a upozornění', ...)
test('[TAX-004] upozornění je na stránce i na každé straně PDF', ...)
test('[IMP-012] přehled uvede počet a částku odhadnutých dat', ...)
test('[REP-009] platba bez kurzu je v unconverted a součet ji mlčky nevynechá', ...)
test('[REP-007] storno a koncept v přehledu nejsou', ...)
test('[SEC-002] rok cizího účtu vrátí jen vlastní data', ...)
test('[TAX-001] e2e od výběru roku po stažení CSV', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/tax-report.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** jádro, výstupy a stránku.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/reports.test.ts`, `tests/backend/consistency.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test tax`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(tax): add yearly tax overview with exports`

---

### Task 8: Záloha účtu

**Files:**
- Create: `src/server/backup/tables.ts`, `src/lib/backup-format.ts`, `src/server/services/account-backup.ts`, `src/app/(app)/nastaveni/zaloha/page.tsx`, `src/app/(app)/nastaveni/zaloha/actions.ts`, `src/components/backup/backup-panel.tsx`, `tests/fixtures/backup/columns-v1.json`
- Modify: `src/server/rate-limit.ts`, `src/server/scheduler/start.ts`, `src/lib/texts.ts`, `src/app/(app)/nastaveni/layout.tsx`, `tests/backend/actions-isolation.test.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/backend/backup-registry.test.ts`, `tests/backend/account-backup.test.ts`

**Interfaces:**
- Consumes: `zipFileWriter`, `export_job`, `readBlob`, `redact`, `USER_OWNED_TABLES`
- Produces:
  - `BACKUP_TABLES: BackupTable[]`, `BACKUP_VERSION`, `backupManifestSchema`
  - `createBackup(actor): { id }`, `runBackup(job)`
  - `backupColumnsFingerprint(): ...`

Spec: EXP-006, EXP-009, AUD-002, SEC-003. Viz **[R-30]**, **[R-31]**, **[R-35]**, **[R-38]**.

Pravidla:
- Záloha je `export_job` s `kind = 'backup'`, stažení i 7 dní stejnou route.
- Konzistence: `better-sqlite3` čtecí transakci přes `await` neudrží, proto první fáze v jedné synchronní transakci vypíše řádky účtu do `files/<userId>/tmp-<id>/*.jsonl`, přes `scoped` a bez `await`. Teprve druhá fáze skládá ZIP po blocích a čte bloby. `VACUUM INTO` se nepoužívá, protože by snímek celé instance s cizími účty ležel ve složce uživatele. Synchronní fáze blokuje proces úměrně velikosti účtu, změř ji na 5 000 dokladech a zapiš čas. Dočasná složka zmizí i při chybě.
- Tajemství: `omit` se nesmí dostat ani do JSON. Test vloží do `smtp_password_enc` a `bank_mailbox.password_enc` značku, rozbalí archiv a hledá ji ve všech položkách.
- `audit.jsonl` drží jen řádky s `owner_id = ownerId`, hodnoty jsou už redigované.
- Bloby `sent_pdf`, loga, `import_pdf`, `audit_archive` jdou všechny. Chybějící blob je chyba zálohy, ne tichá díra.
- `export_job` a dočasné soubory v záloze nejsou.
- Partial: `EXP-006` až do Task 9, kdy obnova prokáže použitelnost. `EXP-009` se odebere z pending.

- [ ] **Step 1: Napiš testy**

```ts
test('[EXP-006] každý sloupec každé vlastněné tabulky je zařazený v registru', ...)
test('[EXP-006] změna sloupců bez nové verze spadne na otisku', ...)
test('[EXP-006] archiv má manifest, data, soubory, audit a sedící SHA-256', ...)
test('[EXP-009] značky v heslech SMTP a IMAP v archivu nejsou', ...)
test('[EXP-006] archiv nese foreign, clause, rate_micros, dedupe_key a sent_pdf', ...)
test('[SEC-002] záloha neobsahuje řádek ani soubor cizího účtu', ...)
test('[SEC-001] překročení backupUser vrátí 429', ...)
test('[TST-017] přerušení smaže dočasnou složku a neukáže rozepsaný soubor', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/backup-registry.test.ts`, FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Ověř:** testy úkolu, `timeout 170 pnpm build`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(backup): add full account backup archive`

---

### Task 9: Obnova účtu a smazání s nabídkou zálohy

**Files:**
- Create: `src/server/backup/restore-read.ts`, `src/server/backup/remap.ts`, `src/server/services/account-restore.ts`, `src/app/(app)/nastaveni/zaloha/nahrani/route.ts`, `src/components/backup/restore-panel.tsx`, `tests/helpers/backup-compare.ts`, `tests/e2e/backup-restore.spec.ts`
- Modify: `src/lib/backup-format.ts`, `src/server/audit/record.ts` jen je-li potřeba, `src/lib/automation.ts`, `src/lib/texts.ts`, `src/server/rate-limit.ts`, `src/server/scheduler/start.ts`, `src/app/(app)/nastaveni/ucet/*`, `src/components/account/delete-account-form.tsx`, `tests/backend/silence.test.ts`, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/backend/account-restore.test.ts`, `tests/backend/restore-hostile.test.ts`, `tests/backend/backup-roundtrip.test.ts`, `tests/backend/silence.test.ts`, `tests/e2e/backup-restore.spec.ts`

**Interfaces:**
- Consumes: `readZipEntries`, `BACKUP_TABLES`, `backupManifestSchema`, `writeBlob`, `assertConsistent`
- Produces:
  - `startRestore(actor, uploadId)`, `runRestore(job)`, `recoverRestore(job)`, `isAccountEmpty(tx, ownerId)`
  - `remapIds(row, table, idMap)`, `BACKUP_UPGRADES`
  - `canonicalAccount(db, ownerId)` v testovací pomůcce, data bez ID a s otiskem blobů

Spec: IMP-010, EXP-006, TST-019 **[částečně]**, ADM-009, SEC-002, SEC-005. Viz **[R-32]** až **[R-35]**.

Pravidla:
- Upload jde do `files/<userId>/`, proudově s limitem 1 GiB. Archiv se čte dvakrát: první průchod ověří limity, manifest, SHA-256 a Zod všech řádků, druhý zapisuje. Před validací nejde nic do databáze.
- Limity ZIPu zde: 1 GiB výstupu, položky `data/*` do 200 MiB, `files/*` do 25 MiB, 200 000 položek. `manifest.json` je první čtený a do 1 MiB, nejde-li najít, je to chyba.
- Bloby se zapisují pod nová UUID před transakcí. Selhání nebo pád je smaže: běh má řádek `export_job` s `kind = 'restore'` a složku `files/<userId>/restore-<id>/`, `recover` podle něj uklidí.
- Commit je jedna `mutate` s `source: 'import'`. Před vložením se odstraní jen automaticky vzniklé řádky **[R-32]**, až po kontrole prázdnoty. Vkládá se v pořadí, kde odkazy existují, cykly `invoice.related_invoice_id` se řeší `PRAGMA defer_foreign_keys = ON` v transakci.
- Na konci transakce `foreign_key_check` nad tabulkami účtu, porušení vrací změnu.
- Obnova nespouští `refreshBalance` ani `applyPayments`, hodnoty jsou doslovné, aby data zůstala shodná. Upravený archiv ale může nést nesmyslné součty, proto část kontrol z `tests/helpers/consistency.ts` přejde do `src/server/services/data-checks.ts` bez závislosti na testech, běží na konci transakce a porušení obnovu vrátí.
- `reminder_sent`, `recurring_run` a `bank_notification` zůstávají, jinak by zapnutí automatik poslalo upomínky znovu. Po obnově je každé zapnutí automatik vědomá akce člověka a nové `reminders_open_since` omezí zpětnou vlnu.
- Plán s `mode = 'send'` po obnově bez potvrzení nic neodešle. Ověř tok v `recurring-run.ts` řádek `plan.sendConfirmedAt && automaticSendAllowed` a přidej test.
- ADM-009: formulář smazání ukáže datum poslední zálohy a tlačítko Vytvořit zálohu. Smazání nečeká a zálohu nevynucuje, ale text řekne, že se soubor s účtem odstraní, proto ho je nutné stáhnout. Smazání během běžící úlohy zálohy úlohu zruší, `job` má kaskádu a `run` skončí bez chyby při chybějícím vlastníkovi, složka zmizí se `removeUserDir`.
- `TST-019` jde do partial s důvodem „chybí upgrade migrací“, Task 10 ho uzavře. Z partial odeber `EXP-006`.

- [ ] **Step 1: Napiš testy**

```ts
test('[IMP-010] obnova do prázdného účtu jiné instance vrátí shodná data s novými ID', ...)
test('[IMP-010] účet s jedinou fakturou je odmítnutý a nic se nezmění', ...)
test('[IMP-010] souběžný zápis mezi kontrolou a commitem obnovu shodí', ...)
test('[IMP-010] žádné staré ID nezůstane v JSON ani v klíči upozornění', ...)
test('[IMP-010] audit ze zálohy je soubor a v logu je jen account.restore', ...)
test('[TST-016] po obnově nic neodejde: plán send, upomínka, potvrzení, záloha, digest', ...)
test('[IMP-010] všechny spínače vypnuté, advance_final_mode draft, send_confirmed_at NULL', ...)
test('[IMP-010] queued a sending skončí cancelled a index neblokuje', ...)
test('[IMP-010] SMTP a IMAP chybí a upozornění vyzve k zadání', ...)
test('[BNK-006] znovu přečtené avízo po obnově nezaloží platbu', ...)
test('[SEC-002] user_id cizího účtu v archivu se ignoruje a cizí řádky jsou netknuté', ...)
test('[SEC-002] ref mimo archiv je odmítnutý', ...)
test('[SEC-005] jméno files/../../x, cizí sloupec a neznámý klíč jsou chyba', ...)
test('[SEC-005] změněný blob nesedí na SHA-256 a nic se nezapíše', ...)
test('[TST-017] pád uvnitř transakce nechá účet prázdný a nové bloby zmizí', ...)
test('[EXP-006] verze v2 archivu je odmítnutá', ...)
test('[ADM-009] smazání nabídne zálohu a poslední běh', ...)
test('[IMP-010] e2e záloha, nový účet, obnova, shodné faktury', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/account-restore.test.ts tests/backend/restore-hostile.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** čtení, přemapování, obnovu a nabídku při smazání.
- [ ] **Step 4: Ověř:** testy úkolu, `tests/backend/silence.test.ts`, `tests/backend/users.test.ts`, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test backup-restore`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(backup): restore accounts into empty accounts`

---

### Task 10: Uzavření plánu

**Files:**
- Create: `tests/backend/migrations-upgrade.test.ts`, `tests/fixtures/db/README.md`, `tests/fixtures/db/0.1.0.sql`, `scripts/import-compare.ts`, `tests/backend/import-compare.test.ts`
- Modify: `docs/superpowers/specs/2026-10-30-fakturan-design.md`, `tests/helpers/isolation.ts`, `tests/backend/actions-isolation.test.ts`, `stryker.config.json`, `README.md`, `.gitignore`, `.env.example` jen je-li potřeba, `tests/spec-pending.txt`, `tests/spec-partial.txt`
- Test: `tests/backend/migrations-upgrade.test.ts`, `tests/backend/import-compare.test.ts`, celé sady po částech

**Interfaces:**
- Consumes: všechny předchozí úkoly
- Produces: uzavřené seznamy, zápis do spec, skript lokálního porovnání

Spec: TST-019, TST-020 **[částečně]**, TST-009, SEC-001, SEC-002, AUD-002. Viz **[R-36]**, **[R-37]**.

Pravidla:
- `migrations-upgrade.test.ts` podle **[R-36]**, s rozdělením, aby se vešel do limitu.
- Doplň matici TST-009 o role a entity plánů 7 a 8: `dashboard`, `dashboard_widget`, `import_batch`, `mapping_preset`, `export_job`, a stažení exportu. Z partial odeber `TST-009`.
- `stryker.config.json` přidá `src/lib/safe-input/**`, `src/server/isdoc/parse.ts`, `src/server/isdoc/rules.ts`, `src/server/backup/remap.ts`, `src/server/reports/tax.ts`. Spusť po souborech s dočasnou konfigurací a výsledek zapiš do `TST-013` v partial.
- Spec: **[R-35]** do IMP-011, **[R-14]** a **[R-15]** do IMP-012, **[R-28]** do TAX-001, **[R-19]** do IMP-005, odstranit z kap. 24 jen to, co je opravdu uzavřené. Bod poradce a bod vzorků zůstávají.
- README: postup zálohy a obnovy účtu, limit reverzní proxy, postup TST-020, větu k licenci ISDOC.
- `import-compare.ts` čte soubor přes stejné služby, nezapisuje a výpis obsahuje jen počty a součty podle roku a měny.
- Ručně, mimo repozitář: projdi lokální vzorek z `~/Downloads` testovací instancí, porovnej součet s Fakturovačem a do zprávy dej jen shodu. Pokud uživatel není u toho, `TST-020` zůstane v partial jako „čeká na porovnání uživatelem proti zdrojovému systému“.
- `pnpm audit` a výsledek zapiš, SEC-009.

- [ ] **Step 1: Napiš testy**

```ts
test('[TST-019] každý prefix migrací dojede na konec bez porušení klíčů', ...)
test('[TST-019] uložený stav verze 0.1.0 projde upgradem a soulad dat drží', ...)
test('[TST-019] záloha a obnova dají shodná data', ...)
test('[TST-020] skript vypíše součty a nic nezapisuje', ...)
test('[TST-009] cizí uživatel i administrátor nedostanou entity plánů 7 a 8', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/migrations-upgrade.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** testy, skript a dokumentaci.
- [ ] **Step 4: Ověř:** `timeout 170 pnpm exec vitest run --project unit`, `pnpm exec vitest run --project backend --shard=N/4` pro N od 1 do 4 s `timeout 170`, `timeout 170 pnpm typecheck`, `timeout 170 pnpm lint`, `timeout 170 pnpm format:check`, `timeout 170 pnpm build`, Playwright po souborech, Docker po vrstvách, `timeout 170 pnpm run test:coverage-spec`. Pak `pgrep -af 'next|vitest|playwright|stryker'` a `docker ps`, nic z běhu nesmí zůstat.
- [ ] **Step 5: Commit** `test(import): close plan 8 coverage and upgrade checks`

---

## Sebekontrola proti spec

| Oblast | Úkol | Poznámka |
|---|---|---|
| IMP-000 | 2, 4 | 6.0.1 a 6.0.2, ZIP, PDF; ostatní systémy v partial **[R-1]**, **[R-6]** |
| IMP-001 | 5 | Průvodce **[R-21]** |
| IMP-002 | 5 | Vlastní předlohy hotové, vestavěné v partial **[R-22]** |
| IMP-003 | 2, 4 | Typy **[R-11]**, částky **[R-12]** |
| IMP-004, 005 | 3, 4 | **[R-18]**, **[R-19]** |
| IMP-006, 007 | 4 | **[R-17]** |
| IMP-008, 009 | 4 | Jedna `mutate`, vrácení **[R-20]** |
| IMP-010 | 9 | **[R-32]** až **[R-34]** |
| IMP-011 | 4, 9 | 25 MB, záloha 1 GiB jako odchylka **[R-35]** |
| IMP-012 | 3, 4, 7 | **[R-14]** |
| IMP-013 | 2, 10 | Fixtury smyšlené, `.gitignore` **[R-37]** |
| EXP-001 až 003 | 6 | **[R-23]** |
| EXP-004 | hotovo | Audit CSV z plánu 1 |
| EXP-005 | 2, 6 | **[R-1]** až **[R-3]** |
| EXP-006 | 8, 9 | **[R-30]**, **[R-31]** |
| EXP-007 | 6 | **[R-8]**, 7 dní |
| EXP-008 | 6 | Sdílený `tabular` |
| EXP-009 | 6, 8 | Hledání značek v archivu |
| TAX-001 až 004 | 7 | **[R-26]** až **[R-29]** |
| TST-015 | 2, 6 | Zpětné čtení exportu i přílohy |
| TST-019 | 9, 10 | **[R-36]** |
| TST-020 | 10 | Ruční krok, zůstává v partial **[R-37]** |
| ADM-009 | 9 | Nabídka zálohy |
| INV-024 | 6 | Hromadný export |
| MAIL-001 | 6 | **[R-25]** |
| ADV-005 | 4, 7 | Rok úhrady, žádné dvojí započtení |
| TST-009 | 10 | Matice |
| SEC-001, 002, 005, AUD-002 | 1, 3, 4, 6, 8, 9 | Rate, izolace, obsah, audit |
| Přenos plánu 4 | 3, 6, 8, 9 | `external` v upomínkách, `send_confirmed_at`, `sent_pdf`, MAIL-001 |
| Přenos plánu 5 | 3, 8, 9 | `source: 'import'`, `matchNotice`, `dedupe_key`, schránka znovu |
| Přenos plánu 6 | 2, 4, 7, 8, 9 | Typ a odkaz, kurz, `advance_final_mode`, sloupce zálohy, TAX se znaménkem |
| Přenos plánu 7 | 2, 6, 7, 8 | Jádro přehledů, `tabular`, `xlsx-writer`, dashboardy v záloze, `includeExternal` |
| Přenos plánu 1 | 3, 6, 9 | Rate limit, izolace, audit, ADM-009 |
| Pohoda, Money S3 | nedělá se | Kap. 2.3 |

Kontroly plánu: všechna ID z rozsahu v `tests/spec-pending.txt` mají úkol, EXP-004 je mimo pending. Každé rozhodnutí má úkol nebo zápis do spec. Názvy `ImportDocument`, `PreviewRow`, `BACKUP_TABLES`, `HEAVY_JOB_KINDS`, `export_job` jsou napříč úkoly stejné. Čísla 44 100,00 a 41 650,00 v Task 7 pocházejí ze scénáře plánu 7 před přidáním dokladů H až M, proto je test počítá nad základní fixturou a nové doklady ověřuje samostatně.

## Přenos do dalších plánů

- **Daňový poradce:** texty TAX a rozsah přehledu **[R-29]**, základ úhrada proti vystavení, zda odhadnuté datum úhrady stačí pro podklad **[R-14]**, zacházení s importovanou DPH **[R-12]**. Po ověření přepnout `TAX_TEXT_REVIEWED` a uzavřít bod v kap. 24.
- **Zadavatel:** spustit TST-020 nad skutečnými doklady a porovnat součty se zdrojem. Dodat reálné exporty Fakturoidu a iDokladu pro předlohy IMP-002 a ověření IMP-000. Prověřit, zda některý systém nevyplňuje `PayableAmount` 0 jinak než Fakturovač **[R-14]**.
- **Plán 9:** dokumentace importu, exportu a obnovy, UI-010, UI-012, UI-002. Limit těla na reverzní proxy pro zálohu 1 GiB **[R-35]**. Sledovat místo na svazku u výsledků exportu a dočasných složek, rozhodnout o limitu na účet. `TST-013` s novými soubory. Verze aplikace v manifestu zálohy jako běžná součást vydání. Přidat `tests/fixtures/db/<verze>.sql` při každém vydání **[R-36]**.
- **Ruční ověření:** otevřít Excel z exportu a XLSX z importu ve skutečném Excelu a LibreOffice, ISDOC z exportu načíst v jednom cizím programu nebo validátoru, PDF daňového přehledu vytisknout.
- **Známá rizika:** Schematron se nespouští, soulad nad rámec `rules.ts` je jen podle XSD **[R-3]**. Verze 6.0 a 6.0.0 nejsou podporované kvůli chybějícímu XSD **[R-1]**. Skener PDF nečte přílohy s jiným filtrem než Flate a neověřuje vztah přílohy `/AFRelationship`, spoléhá na kořen dokumentu **[R-6]**. Importovaná platba v cizí měně je kurzem dokladu, ne dnem úhrady **[R-14]**. Doklad stornovaný po 31. 12. přehled v minulém roce neukáže **[R-28]**. Záloha je nezašifrovaný archiv s osobními údaji, ukládá si ji uživatel, stránka to říká. Archiv není podepsaný, změněný obsah projde, pokud je platný a sedí SHA-256 v manifestu, škoda je omezená na účet, který ho obnovuje **[R-30]**. Synchronní potvrzení dávky a první fáze zálohy krátce blokují proces **[R-8]**. Import a obnova změní razítko plánu 7 a zneplatní celou cache účtu, což je správně.

### Doplněno při uzavření plánu (Task 10)

**Přenos do plánu 9**
- **IMP-005:** ruční přiložení PDF k importovanému dokladu po importu. Dnes se přiloží jen PDF z dávky importu (partial).
- **TST-013:** mutační skóre nových modulů je pod prahem 90 (`tests/spec-partial.txt`). Doplnit testy hlavně pro `pdf-embedded`, `isdoc/parse` (spolu s backendovými testy ISDOC) a `safe-input/csv`.
- **Paměť obnovy:** řádky celého archivu leží v paměti až do jediné transakce, nejvýš 300 000 řádků a 256 MiB dat podle `RESTORE_LIMITS`, vložené tabulky se uvolňují průběžně. Nečtená položka ZIPu se drží celá jako bajty (do 200 MiB) a řetězce ani pole z ní nevznikají. Delší výhled je mezisoubor a vkládání po tabulkách ve stejné transakci.
- **Interní texty** `worker.ts` („Úloha přišla o zámek plánovače“), `import-parse.ts` a `pdf-embedded.ts` přesunout do `texts.ts` (m-12 bloku B).
- **Testovací háček** `setTaxPdfRowLimitForTests` v produkčním kódu nahradit parametrem (N-4 bloku C).

**Známá omezení**
- Import z CSV a Excelu umí jen typ `invoice` (m-11 bloku B).
- Faktura z tabulky bez účtu nemá způsob platby: ISDOC ji exportuje bez `PaymentMeans` a PDF způsob platby neukazuje.
- Doklady importované před migrací `0045` nemají uložený `PaymentMeansCode`, takže jejich ISDOC export nemá `PaymentMeans`, splatnost ani VS.
- PDF daňového přehledu má strop 2 000 řádků. Delší přehled je jen v Excelu a CSV (422 s hláškou). PDF se vykresluje synchronně, jen se stropem.
- Potvrzení dávky s 5 000 doklady drží event loop asi 18 s, protože jde o jednu synchronní `mutate` [R-8]. Snímek zálohy 5 000 dokladů trvá 0,5 s.
- Průběh importu a exportu se zapisuje mimo `mutate` (`jobs/import-progress.ts`, `jobs/export-progress.ts`). Je to stav úlohy, ne data účtu, a zápis je omezený `user_id` i ID dávky (m-7 bloku B).
- Matice TST-009 kryje entity plánů 7 a 8: `dashboard`, `dashboard_widget`, `import_batch`, `mapping_preset`, `export_job` a stažení exportu. Proti každé stojí cizí uživatel i administrátor.
- Odložené drobnosti:
  - **ZIP:** uložená položka s data descriptorem je odmítnutá jako poškozená a hláška zatím neradí uložit archiv s kompresí. XLSX se rozbaluje dvakrát. Kódy zemí `UK` a `XI` se nepřevádějí (blok A).
  - **Dávky importu:** zahozená dávka se do úklidu ukazuje jako „Selhalo“. Zahození dávky během běžícího nahrání může nechat soubor až do úklidu (blok B).
  - **Čísla:** číselná buňka XLSX v exponentu (`1E-3`) se hlásí jako neplatné číslo (m-10 bloku B).
  - **Limity:** limit požadavků se spotřebuje i tehdy, když export nebo zálohu odmítne strop 3 rozpracovaných (N-3 bloku C).
  - **Daňový export:** souborová pole ve formuláři nedají 400 (N-5 bloku C).
  - **Bez vlastního testu** zůstaly společný strop PDF a ISDOC v poště, snímek ID exportu a selhání `finishExport` (m-2, m-3 a m-5 bloku C).
  - **Obnova** (m-2, m-7 a m-8 bloku D):
    - libovolné ID z archivu nahradí stejný řetězec ve všech `json-ids` sloupcích účtu, například ID `manual`;
    - přeskočené adresáře a vnořené archivy v ZIPu obejdou kontrolu „každá položka je v manifestu“;
    - commit obnovy je jedna synchronní dávka.
- **Obnova** kontroluje tvar jen u JSON sloupců, které čtou stránky, PDF a odeslání (vzhled, snapshoty, pevné kurzy, adresy, data). U ostatních JSON hlídá jen hloubku.
- **Upload k obnově**, který nespustil obnovu, se smaže po hodině úlohou `export-cleanup`.
- **Velmi velký účet nejde zálohovat ani obnovit:** obnova drží přemapované řádky do jediného commitu (po tabulkách je uvolňuje), proto platí nejvýš 300 000 řádků v archivu (tabulky i historie změn), 256 MiB dat všech tabulek po rozbalení, 1 000 000 objektů a polí a 10 000 000 klíčů a hodnot JSON v datech (počítáno po bajtech před parsováním), na řádek nejvýš 20 000 objektů a hloubka 40, 28 000 položek (soubory) a manifest do 4 MiB. Záloha tytéž limity hlídá předem a nad nimi skončí hláškou. Trvalé řešení je mezisoubor po tabulkách (přenos do plánu 9).
- **Po obnově jsou pravidelné faktury pozastavené** a historie změn ze zálohy je ke stažení v Nastavení, Záloha.
- **Přenos do plánu 9 (z finální recenze):** spravedlnost těžké fronty mezi účty a strop dokladů `pdf_zip` (m-1), falešné „Záloha nenalezena“ u znovu importovaného uhrazeného dokladu (m-4), paměť tabulkového importu (m-5), souběh stažení a úklidu exportu (m-7).
