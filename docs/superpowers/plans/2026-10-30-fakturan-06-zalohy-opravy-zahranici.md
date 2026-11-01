# Fakturan 6: Zálohy, opravné a zahraniční faktury – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uživatel vystaví zálohu a z ní konečnou fakturu, opraví vystavenou fakturu opravnou fakturou a fakturuje do zahraničí s kurzem ČNB. Zbývá uhradit, stav, QR, upomínky i souhrny vycházejí z jednoho výpočtu, peníze se nezapočtou dvakrát a výpadek ČNB nezablokuje žádnou práci.

**Architecture:** `amountDue` zůstává jediný výpočet. `invoice` dostane denormalizované `credits_minor`, `advance_minor` a `superseded_at`, zapisuje je jediná funkce `refreshBalance`, vždy jako nový `SUM`, a zvyšuje `revision`. Zálohy i opravy jsou řádky `invoice` spojené přes `related_invoice_id`. Kurzy žijí ve sdílené tabulce `exchange_rate`: síť běží jen v úloze nebo akci před transakcí, `mutate` čte výhradně uložené řádky, takže vystavení ani platba nikdy nečekají na ČNB. Čisté výpočty leží v `src/lib/fx.ts`, `src/lib/cnb-rates.ts` a `src/lib/invoice-totals.ts`.

**Tech Stack:** Next.js 16.4, Drizzle, better-sqlite3, Zod, `fetch` s injektovatelným `Fetcher`, `croner`, Vitest, fast-check, Stryker, Playwright. Plán nepřidává žádnou závislost **[R-34]**.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`, kap. 7.1, 7.6 (FOR-001 až 010), 7.8 (ADV), 7.9 (CRN), SET-011, SET-040 až 043, PAY-006, REC ADV-006, REP-009, QR-002, CUS-008, TST-012, TST-016. Přenosy z konců plánů 3, 4 a 5.

## Global Constraints

- Správce balíčků je pnpm. Práce probíhá na `main`. Nic se nepushuje a nic se nenasazuje.
- **Harness přesouvá příkazy nad 180 s na pozadí.** Každý příkaz v popředí proto běží nejvýš 170 s (`timeout 170 …`) a dlouhé běhy se dělí po částech: `pnpm exec vitest run --project unit`, `pnpm exec vitest run --project backend --shard=N/4` a Playwright po jednotlivých souborech. **Nikdy nečekej na úlohu na pozadí.** Běh, který se do limitu nevejde, rozděl jemněji. Když to nejde, zapiš do zprávy úkolu „neověřeno“ s příkazem a nepředstírej úspěch.
- `pnpm build` před Playwrightem, protože fixture spouští `next start`.
- `minimumReleaseAge` se neobchází: žádný `--config` ani změna `pnpm-workspace.yaml`. Tento plán žádný balíček nepřidává, kdyby to úkol přesto potřeboval, použij nejbližší starší verzi, kterou pnpm přijme.
- Implementeři neběží souběžně. Úkoly jdou po sobě a každý začíná z čistého stromu po commitu předchozího.
- Plán navazuje na uzavřený plán 5. Před Task 1 ověř, že je jeho Task 8 commitnutý, a znovu přečti jeho Přenos, plán vznikal nad commitem `ba25fd6`, zatímco Task 8 ještě běžel.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů. Agent staguje jen své soubory.
- Komentáře jen pro neočividné invarianty. **UI texty česky a v `src/lib/texts.ts`**, jen tokeny barev. Texty, které dostane klient, patří dokumentu: maily v `src/server/mail/defaults.ts`, PDF v `src/server/pdf/labels.ts`, doložky v `src/lib/clauses.ts`.
- **Migrace navazují po nejvyšší v `drizzle/`,** dnes `0032_email_log_payment`: `pnpm exec drizzle-kit generate --name <jméno>`, čísla níže platí pro pořadí úkolů, soubor vždy ověř proti `drizzle/`. Ruční SQL jen tam, kde to úkol říká.
- Service kód běží v testech i přes type stripping Node (`tests/helpers/*-worker.mjs`), proto žádné `constructor(readonly x)` ani jiná syntaxe vyžadující transformaci. Vlastnost deklaruj zvlášť a přiřaď v konstruktoru, vzor `BlockedHostError` a `NotIssuableError`.
- Před kódem v App Routeru přečti příslušný návod v `node_modules/next/dist/docs/` (viz `AGENTS.md`).
- Název testu obsahuje ID požadavku, `tests/spec-pending.txt` se průběžně zmenšuje a každý úkol sám přesune ID, která v testech pojmenuje. `test:coverage-spec` selže na ID, které je zároveň v pending i v názvu testu. ID splněné jen zčásti a bez testu v pending zůstává, takový test ID v názvu nenese a nad testem je komentář proč. ID s testem, které ještě není splněné celé, jde do `tests/spec-partial.txt` (tři sloupce oddělené tabulátorem: ID, co chybí, plán). Úkoly to mají označené **[částečně]**.
- Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)`. **Mutace je synchronní, HTTP v ní neběží** **[R-11]**.
- Plánovač jedná za aktéra `{ userId: ownerId, source: 'scheduler' }`. Zápis kurzů nemá vlastníka a jde za aktéra `{ userId: null, source: 'system' }` se `scope: 'instance'`.
- Každý dotaz na data účtu jde přes `scoped(ownerId)`. `exchange_rate` je jediná nová tabulka, nemá vlastníka a do `USER_OWNED_TABLES` nepatří. Server actions pokrývá `tests/backend/actions-isolation.test.ts`.
- Aktuální čas jen přes `clock`, „dnes“ přes `calendarDateInPrague`. V běhových službách není `new Date()` bez argumentu ani `Date.now()`.
- Úlohy nesou v `payload` jen ID a data.
- `registerJob` a tick úlohy se registrují jen v `src/server/scheduler/start.ts`, protože instrumentation má vlastní bundle.
- Peníze a kurzy jsou celá čísla, mezivýpočty přes `BigInt`, zaokrouhlení půl od nuly, žádné plovoucí desetinné číslo. Kurz je `exchange_rate_micros`, tedy CZK za 1 jednotku měny krát 1 000 000.
- **Testy nikdy nesahají na síť.** Backend předává `Fetcher` nebo běží proti `tests/helpers/cnb.ts`, e2e nastavuje `CNB_BASE_URL` na lokální pahýl, vzor `startAresStub`.
- Nic neodejde klientovi bez kliknutí nebo zapnuté automatiky. Vstupy se validují na serveru sdíleným Zod schématem.
- Každá nová automatika jde do `AUTOMATIONS` a `armed` v `tests/backend/silence.test.ts`.

## Review Focus

1. Dvojí započtení a posun zůstatku: `credits_minor`, `advance_minor` a `paid_minor` po každé cestě (vystavení, úprava, obnovení verze, storno, vrácení storna opravy, vrácení avíza). Záloha nesmí být příjem dvakrát a do `invoicedMinor` smí jen konečná faktura (Task 2, 3, 6).
2. Záporné částky: zrcadlová symetrie `computeTotals`, sleva a zaokrouhlení v záporu, záporný `netMinor` na běžné faktuře nesmí projít, opravy nesmí přečerpat fakturu a záporná platba nesmí stáhnout `paid_minor` pod nulu (Task 1, 3).
3. Fronta a revize: každá změna zůstatku zvýší revizi původního dokladu, zpráva ve frontě se starou částkou neodejde a platba nikdy nespadne kvůli selhání automatiky po záloze (Task 2, 3, 7).
4. Kurz: nefunkční nebo podvržený lístek ČNB nic nezablokuje ani neuloží napůl, `Date` a časová zóna neposunou rozhodný den, po vystavení se kurz sám nezmění, měna po změně nedrží cizí kurz, síť v `mutate` neběží (Task 4, 5).
5. Daňové texty: doložka jen pro identifikovanou osobu a firmu z EU, v jazyce faktury, zamrzlá na vystaveném dokladu a označená k ověření poradcem. Druhá automatika po záloze nesmí nic poslat bez SET-040 a hlavního vypínače (Task 5, 7).

## Rozhodnutí plánu

Uživatel chtěl plán bez čekání, proto je plán rozhodl sám. Na `[R-n]` se odkazují úkoly. Čísla platí jen v tomto plánu.

- **[R-1] Znaménko nese cena, ne množství.** Opravná faktura má `quantity_milli > 0` a `unit_price_minor` záporné. `lineProblems` kontrolu množství nemění a formulář nemusí řešit záporné množství. Záporná cena jde jen u `credit_note`: odmítá ji `draftInputSchema` a `templateDocumentSchema` podle `type` a `lineProblems` u vystavených dokladů. Řádky opravy mohou mít obě znaménka, aby šla oprava „odebrat a přidat“, celek musí být pod nulou.
- **[R-2] `computeTotals` je zrcadlově symetrický.** Počítá v absolutní hodnotě a znaménko vrací až na konci, takže `computeTotals(zápor(x))` je přesně `-computeTotals(x)` a úplná oprava dá přesně `-total_minor` i se slevou a zaokrouhlením. Sleva zmenšuje velikost částky a je omezená `|základ|`. `discountMinor` a řádkové `discountMinor` jsou znaménkové, platí `subtotal - discount + rounding = total` a `gross - discount = net`. Limit `MAX_DOCUMENT_MINOR` platí pro `|hodnotu|`.
- **[R-3] Zůstatek je denormalizovaný a má jediný zápis.** `credits_minor` (≤ 0, součet `total_minor` aktivních oprav, aktivní znamená `issued` nebo `sent`), `advance_minor` (≥ 0, `paid_minor` navázané zálohy), `superseded_at` **[R-27]**. `amountDue = total + credits - advance - paid`, u nahrazené zálohy `min(0, …)`. Sloupce zapisuje jen `refreshBalance`, vždy jako nový výpočet, zvyšuje `revision` a netvoří verzi dokladu, stejně jako platby. SQL souhrny používají jeden výraz `dueSql`. `amountDue` má pole povinná, aby zapomenutý `select` skončil typovou chybou, proto `readVersion` starým uloženým dokumentům doplní nuly.
- **[R-4] Stav `credited`.** Nastane při `total > 0`, `credits < 0`, `total + credits = 0`, `paid = 0`, `advance = 0`. Přepočet musí z `credited` umět zpět, proto do něj `deriveStatus` vstupuje, `canTakePayment` však zůstává bez něj. Úprava a smazání platby jdou přes `canAmendPayment`, aby šlo vrátit i vrácení peněz u dobropisované faktury. Zůstatek pod nulou je `paid` s řádkem „Přeplatek k vrácení“, kredit zákazníka se neeviduje (CRN-006). Faktura s doplatkem po záloze má základní stav, ne `partially_paid`, protože na ní žádná platba není.
- **[R-5] Opravná faktura vzniká jen z typu `invoice`** ve stavu `issued`, `sent`, `partially_paid` nebo `paid`. Koncept kopíruje zákazníka, měnu, kurz včetně zdroje a data, jazyk, účet, způsob platby, vzhled, zaokrouhlení a slevu dokladu. Datum vystavení i splatnosti je dnešek. Měna, kurz, zákazník a odkaz jsou zamčené. Nemá VS, QR ani platby: `issueIn` jí nastaví `variable_symbol = null`, banka ji nikdy nepáruje a vrácení peněz se eviduje na původní faktuře. Ručně založit ani duplikovat ji nejde, `saveDraft` bez existujícího řádku a `duplicateInvoice` ji odmítnou, šablonu z ní založit nejde.
- **[R-6] Předvyplnění je vždy celá faktura.** `createCreditNote` zkopíruje všechny řádky se zápornou cenou, uživatel částečnou opravu vytvoří úpravou. Po dřívější opravě formulář ukáže, kolik zbývá opravit. Oprava nesmí přečerpat: při vystavení, úpravě i vrácení storna platí `original.total + original.credits + oprava.total >= 0`. Celek opravy musí být pod nulou.
- **[R-7] Faktura s opravou nebo navázaná na zálohu má zamčené peníze.** Faktura s aktivní opravou nejde stornovat, měnit v měně ani kurzu, a úprava nesmí snížit `total` pod `|credits|`. Měna konečné faktury je zamčená kvůli `advance_minor`. Stráž je v `applyChange`, platí tedy i pro obnovení verze. Formulář pole vypne s vysvětlením, vzor `hasPayments`.
- **[R-8] Vrácení peněz je záporná platba s `kind = 'payment'`.** Filtr plánu 7 `kind = 'payment'` ji tak započte do příjmů se správným znaménkem. Vzniká jen přes `addRefund`, formulář zadává kladnou částku a služba ukládá zápor, `updatePayment` znaménko drží. `applyPayments` odmítne součet pod nulou (`E.refundExceeds`), platí proto i pro smazání dřívější kladné platby a vrácení avíza. Vrácení nejde na koncept, storno ani opravu. Potvrzení platby se k němu neposílá, `receiptPayment` je odmítne a `averagePaymentDays` je nepočítá.
- **[R-9] Odkaz na původní doklad je zamrzlý** ve sloupci `related_snapshot` (`{ type, number, issueDate }`), zapsaný při vystavení, u konceptu počítaný v `loadInvoiceDocument`. Pozdější přečíslování původní faktury nesmí přepsat vystavený doklad. Detail ale vede odkazem přes `related_invoice_id`.
- **[R-10] Název dokladu je „Opravná faktura“** v PDF, řadách, filtru i mailu. „Opravný daňový doklad“ neplátce nevystavuje a dnešní tři různé názvy (`Dobropis`, `Opravný doklad`, `Opravný daňový doklad`) se sjednotí. Anglicky zůstává `Credit note`, záloha `Advance invoice` i v mailu místo `Proforma invoice`. Uložené vlastní šablony se nemění. Znění je v seznamu pro poradce.
- **[R-11] Síť nikdy v transakci.** `resolveRate` je synchronní a čte jen `exchange_rate` a preference. HTTP běží v úloze `fx.fetch`, v akci formuláře a v `runRecurringJob` před `processOccurrence`. Díky tomu ČNB nemůže podržet zápisový zámek SQLite ani shodit vystavení.
- **[R-12] Zdroj je textový denní lístek** `{CNB_BASE_URL}/denni_kurz.txt?date=DD.MM.RRRR`, ne JSON API, protože desetinná čárka jde do čísla bez plovoucí čárky. Formát ověřen 1. 11. 2026: první řádek `30.10.2025 #211`, druhý hlavička `země|měna|množství|kód|kurz`, dále řádky `EMU|euro|1|EUR|24,380`. **ČNB na víkend i budoucí datum odpoví HTTP 200 s posledním lístkem,** proto se datum bere vždy z prvního řádku a lístek s datem po žádaném dni se zahodí. Parser je všechno nebo nic: špatná hlavička, neplatný řádek nebo nulový kurz dá `null` a neuloží se nic. Limit odpovědi 64 KiB, timeout 5 s, `CNB_BASE_URL` jen z konfigurace.
- **[R-13] Kurz je za 1 jednotku měny.** `rate_micros = kurz × 1 000 000 / množství`, takže lístek `100|HUF|37,512` dá 375 120. Převod `convertMinor(amount, from, to) = round(amount × from / to)`, CZK má 1 000 000.
- **[R-14] Pořadí zdrojů v `resolveRate`:** pevný kurz (FOR-010), lístek platný k rozhodnému dni, poslední známý lístek před ním s upozorněním (`last_known`), jinak `null` a ruční zadání. `expectedListDate` určí poslední pracovní den ≤ datum podle `isWorkingDay` a pro dnešek před 14:30 v Praze předchozí pracovní den. Lístek starší než očekávaný je `last_known`, novější se nepoužije. Zdroje v `invoice.exchange_rate_source`: `cnb`, `last_known`, `fixed`, `manual`, v `exchange_rate_date` je datum lístku.
- **[R-15] Plnění tabulky.** Tick `fx-plan` založí úlohu `fx.fetch` s klíčem `fx:<očekávaný den>:<hodina>`, když v tabulce chybí EUR k očekávanému dni, nejdřív ve 14:45 v Praze. První běh na prázdné instanci stáhne poslední lístek hned. Úloha při selhání skončí bez chyby a další pokus je další hodina, Sentry nedostane provozní výpadek. Úlohy se mažou po 7 dnech. Rate limit `fxLookupUser` 60 za minutu platí jen pro dotaz z formuláře, který nenajde řádek.
- **[R-16] Ruční kurz.** Psaní do pole nastaví `manual`, tlačítko „Použít kurz ČNB“ vrátí automatiku. Změna data nebo měny automatický kurz přenačte a ruční nechá. **Výjimka: změna měny maže i ruční kurz,** 25,32 za EUR je pro USD nesmysl a FOR-003 myslí kurz téže měny. Odpověď staršího dotazu se zahodí přes `ticket`, vzor `customerTicket`.
- **[R-17] Vystavení kurz jednou přepočítá a zamrazí.** `issueIn` u `source != 'manual'` zavolá `resolveRate` k rozhodnému dni, protože datum mohl změnit dialog, a pravidelná faktura kurz vůbec nemá. Když `resolveRate` nic nevrátí a dokument kurz má, zůstane, jinak platí stávající `T.exchangeRate`. Po vystavení kurz mění jen úprava člověkem, a to se zdrojem `manual`. Oprava dědí kurz původní faktury, `issueIn` ho nepřepočítává.
- **[R-18] CZK nemá kurz.** `saveDraft`, `updateIssuedInvoice` a šablony u CZK vynulují `exchange_rate_micros`, zdroj i datum, i kdyby je klient poslal. `assertConsistent` to hlídá, doklad v cizí měně po vystavení kurz mít musí.
- **[R-19] Hranice 5 % je včetně.** Upozorní až odchylka nad 5 %: reference 25,000000 projde s 26,250000 a upozorní u 26,250001. Porovnání je `|kurz - ref| × 10 000 > 500 × ref` v `BigInt`. Je to upozornění ve formuláři a v dialogu vystavení, nikdy blok. Bez reference (výpad ČNB) formulář řekne, že porovnání nešlo provést.
- **[R-20] Přepínač je sloupec `invoice.foreign`.** Výchozí hodnota je z `!isDomesticCountry(customer.country)`, u uloženého dokladu jde přes stávající nabídku `customerOffer`. Měna, kurz a doložka jsou vidět při `foreign` nebo měně mimo CZK, takže stávající doklad v EUR o pole nepřijde. Vypnutí vrátí měnu na výchozí účtu, smaže kurz i doložku. Zahraniční faktura v CZK je povolená a pole kurzu nemá.
- **[R-21] Doložka je předvyplněný text, ne výpočet DPH.** `invoice.clause` se předvyplní při `foreign`, `supplier.vatIdentified` a `isEuVatId(customer.dic)` z výchozího textu v jazyce faktury. Dokud ji uživatel neupraví, změna jazyka ji přeloží (FOR-007). Výchozí texty leží v `supplier.reverse_charge_cs` a `reverse_charge_en`, upravitelné vedle textu o neplátcovství. Službu od zboží aplikace nepozná, proto je to návrh, který jde smazat. U vyplněné doložky a identifikované osoby vystavení vyžaduje DIČ obou stran. **Znění je k ověření poradcem:** UI u pole to řekne, `src/lib/clauses.ts` má komentář a bod v kap. 24 zůstává otevřený.
  - cs: `Daň odvede zákazník (přenesení daňové povinnosti, čl. 196 směrnice 2006/112/ES).`
  - en: `Reverse charge: VAT to be accounted for by the customer (Article 196 of Directive 2006/112/EC).`
- **[R-22] Kurz se na PDF netiskne.** Neplátce ho na dokladu nepotřebuje a referenční PNG čekají na schválení. Fixtury bez nových polí musí vykreslit stejný výstup, nové řádky a bloky se ukážou jen u nového obsahu. PDF-007 se proto nerozšiřuje, nové typy kryje extrakce textu.
- **[R-23] Pevné kurzy jsou JSON `preferences.fixed_rates`** (`{ EUR: 25000000 }`). Jde o malou mapu nad existujícími preferencemi včetně auditu a validace. CZK ani neznámá měna neprojdou.
- **[R-24] PAY-006 jde přes CZK.** Připsaná částka je `convertMinor(amount, rate(platba), rate(faktura))` ke dni úhrady, pevný kurz se nepoužije, spec říká ČNB. Bez kurzu formulář pole nechá prázdné a chce ruční hodnotu, jako dosud podle R-7 plánu 5. `payment.rate_micros` drží kurz měny platby ke dni úhrady pro REP-009, `null` znamená „dopočítat později“ a nic neblokuje. Avízo v jiné měně jde dál do fronty, dialog přiřazení jen předvyplní.
- **[R-25] FOR-008 v tomto plánu dodá jen výpočet** `documentCzkMinor` a `paymentCzkMinor`. Statistiky jsou plán 7, ID jde do `tests/spec-partial.txt` a REP-009 zůstává v pending.
- **[R-26] Záloha a konečná faktura jsou 1:1.** Konečná faktura má `type = 'invoice'` a `related_invoice_id` zálohy, částečný unikátní index `invoice_final_of_advance_idx` na `related_invoice_id` s podmínkou `type = 'invoice' AND related_invoice_id IS NOT NULL AND status <> 'cancelled'`. Index je pojistka idempotence: opakovaná úhrada ani souběh druhou fakturu nevytvoří. Vzniknout může jen z vystavené zálohy, koncept nemá číslo, na které by odkazovala. Záloha s aktivní fakturou nejde stornovat. Vrácení storna konečné faktury narazí na obsazený index a skončí `V.finalExists`.
- **[R-27] Vystavením konečné faktury se záloha nahradí.** Do té doby by před úhradou převedená záloha (ADV-004) šla upomínat a párovat vedle faktury. `superseded_at` nastaví `amountDue` na nulu nebo přeplatek, takže upomínky, QR, přehled po splatnosti i párování fungují beze změny kódu, a `insertPayment` kladnou platbu odmítne. Stav se počítá z nezkrácené částky, částečně uhrazená záloha zůstává `partially_paid`. Storno faktury příznak zruší. Detail zálohy ukáže odkaz „Nahrazeno fakturou“.
- **[R-28] Konečná faktura je kopie zálohy** s řádky, zákazníkem, měnou, jazykem, účtem, vzhledem a poznámkami. Datum vystavení je dnešek, splatnost zachová odstup zálohy, DUZP zůstává prázdné, řada je výchozí řada faktur. Kurz má vlastní, je to samostatný doklad. „Uhrazeno zálohou“ je řádek rekapitulace z `advance_minor`, ne záporná položka, celkem zůstává plná částka a fakturováno je správně (ADV-007). Platba zůstává na záloze (ADV-005).
- **[R-29] Vznik faktury po úhradě je v transakci platby a nikdy ji neshodí.** Spouští se z `insertPayment` a `updatePayment` při přechodu zálohy na `paid`. Režim `preferences.advance_final_mode`: `off`, `draft` (výchozí), `issue`. `createFinalIn` běží v savepointu, chyba `ServiceError` skončí upozorněním `advance_final_failed` a platba zůstane. Hlavní vypínač SET-043 změní `issue` na `draft` s upozorněním `advance_final_held`, stejně jako pravidelné faktury. Stará avíza (úhrada starší 3 dnů) fakturu založí, protože jde o účetní krok, odeslání ne **[R-30]**.
- **[R-30] Automatika `advanceInvoice` jen odesílá.** Platí jen v režimu `issue` a dialog zapnutí to řekne. Kontroly `automaticSendAllowed`, datum úhrady nejvýš 3 dny staré, adresa zákazníka. Klíč `mail:advance-final:<finalId>`, `automation: 'advanceInvoice'`, `plannedFor` je datum úhrady. Chybějící adresa dá `advance_final_no_address`. Kdo nechce nic posílat, nechá přepínač vypnutý, faktura vznikne stejně. U faktury s `advance_minor > 0` přidá `composeMail` větu z `ADVANCE_FINAL_LINE` v jazyce faktury, protože šablona `invoice` mluví o celé částce se splatností.
- **[R-31] Vrácení platby zálohy nevrací fakturu.** Vzniklý doklad může být odeslaný. `refreshBalance` sníží `advance_minor`, stav se přepočítá, revize zadrží zprávu ve frontě a upozornění `advance_final_review` řekne, že faktura opět chce doplatek. Stejně pro smazání platby, vrácení avíza i `addRefund`. Automatická faktura se při další úhradě znovu nezakládá **[R-26]**.
- **[R-32] Souhrny.** `invoicedMinor` je `CASE WHEN type <> 'advance'`, `paidMinor` zůstává včetně zálohy, takže příjem je jednou. `overdueMinor` a `outstandingMinor` zálohy nepočítají a `InvoiceSummaryRow` má nově `advanceOpenMinor`. `NOT_IN_TOTALS` zůstává `draft` a `cancelled`, `credited` v souhrnu být musí, jinak by `+1000` a `-1000` nevyšly. Přehled upozornění REM-009 zálohy dál ukazuje, je to vzkaz majiteli, ne pohledávka.
- **[R-33] Stejný VS se neřeší změnou řad.** Záloha `Z2026-001` a faktura `2026-001` mají VS `2026001`. `matchNotice` rozhodne částka proti `amountDue`, při shodě jde do fronty s důvodem `multiple`. Po nahrazení má záloha `amountDue` nulu, sama tedy vypadne. Ostré použití ověří uživatel, rozhodnutí o řadách zůstává na plánu 9.
- **[R-34] Žádná nová závislost.** ČNB je `fetch` a krátký vlastní parser, Docker obraz se mění jen kódem.

---

### Task 1: Záporné částky ve výpočtu a vstupech

**Files:**
- Modify: `src/lib/invoice-totals.ts`, `src/lib/invoice-form.ts`, `src/server/services/invoices.ts`, `src/server/services/invoice-templates.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/pdf/view.ts`, `src/lib/texts.ts`
- Test: `tests/unit/invoice-totals.test.ts`, `tests/unit/invoice-totals.property.test.ts`, `tests/unit/invoice-examples.test.ts`, `tests/unit/invoice-form.test.ts`, `tests/backend/invoices.test.ts`, `tests/backend/invoices-issue.test.ts`

**Interfaces:**
- Consumes: `computeTotals`, `lineProblems`, `lineSchema`, `toDocumentFields`
- Produces:
  - `TotalsLine.unitPriceMinor` může být záporná
  - `allowsNegativePrice(type: InvoiceType): boolean`
  - `toDocumentFields(values, type)`, `computeFormTotals(values, type)`

Spec: INV-012, ARC-002, TST-012 **[částečně]**, TST-014, CRN-002 **[částečně]**. Viz **[R-1]**, **[R-2]**.

Pravidla:
- `computeTotals` dostane vnitřní výpočet nad `|cena|` a znaménko vrací u řádku. Součet řádků je znaménkový, sleva dokladu i zaokrouhlení běží nad velikostí součtu. Nezáporné vstupy dávají bit po bitu stejný výsledek, existující testy zůstávají beze změny.
- `nonNegativeInteger` zůstává pro množství, slevu a procenta. Nový převod ceny přijme bezpečné celé číslo obou znamének. `withinDocument` kontroluje velikost.
- `cappedDiscounts` porovnává s velikostí základu, `appliedLineDiscount` vrací kladnou uplatněnou slevu a PDF ji tak dál tiskne.
- `lineSchema` povolí `unitPriceMinor` od `-MAX_PRICE_MINOR`. `draftInputSchema` a `templateDocumentSchema` v `superRefine` odmítnou zápor mimo `credit_note`, `issuedInputSchema` typ nezná, proto stejné pravidlo drží `lineProblems(lines, type)` v `documentProblems`.
- `parseAmount` ve formuláři záporná čísla přijme jen s `allowsNegativePrice(type)`. Stávající volání předají `type` z `InvoiceForm`.
- V `totalsOf` a `assertConsistent` se nic nemění, oba volají `computeTotals`.

- [ ] **Step 1: Napiš testy**

```ts
test('[INV-012] řádek 3 × -1 250,50 Kč se slevou 10 % dá -3 376,35 Kč', ...) // hrubě -3 751,50, sleva -375,15
test('[TST-014] oprava 3 × 1 250,50, sleva 10 %, sleva dokladu 100, na koruny: subtotal -3 376,35, discount -100,00, rounding +0,35, total -3 276,00', ...)
test('[TST-014] zaokrouhlení -12,50 Kč na koruny je -13,00 a rozdíl -0,50', ...) // půl od nuly
test('[TST-014] množství 0,333 × -100,01 Kč je -33,30 Kč', ...) // -3 330,333 haléře
test('[TST-012] pro libovolné řádky platí computeTotals(zápor) = -computeTotals', ...) // fast-check, výsledek nesmí obsahovat -0
test('[TST-012] součet položek a slev odpovídá celku i se smíšenými znaménky', ...) // fast-check
test('sleva nad základem je omezená velikostí základu i v záporu', ...)
test('částka mimo limit je odmítnutá v obou znaméncích', ...)
test('záporná cena na faktuře a záloze je odmítnutá u konceptu, šablony i úpravy vystavené', ...)
test('formulář přijme -100 jen u opravné faktury', ...)
test('nezáporné doklady dávají shodný výsledek s ručně spočtenými vzory', ...) // tests/unit/invoice-examples.test.ts beze změny
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/invoice-totals tests/unit/invoice-form.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** výpočet a stráže.
- [ ] **Step 4: Ověř:** `timeout 170 pnpm exec vitest run tests/unit/invoice-totals tests/unit/invoice-examples.test.ts tests/unit/invoice-form.test.ts tests/backend/invoices.test.ts tests/backend/invoices-issue.test.ts tests/backend/invoice-templates.test.ts`, PASS. Pak mutace `invoice-totals.ts` přes dočasnou konfiguraci s `vitest.configFile` jen na tyto testy, aspoň 90 %.
- [ ] **Step 5: Commit** `feat(invoices): compute totals for negative lines`

---

### Task 2: Zůstatek dokladu

**Files:**
- Create: `drizzle/0033_invoice_balance.sql`, `src/server/services/invoice-balance.ts`
- Modify: `src/server/db/schema/invoice.ts`, `src/lib/qr-payload.ts`, `src/lib/payments.ts`, `src/lib/invoice.ts`, `src/lib/invoice-document.ts`, `src/lib/invoice-diff.ts`, `src/lib/reminders.ts`, `src/lib/payment-matching.ts`, `src/server/services/invoices.ts`, `src/server/services/invoice-versions.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/services/payments.ts`, `src/server/services/reminders.ts`, `src/server/services/due-alerts.ts`, `src/server/services/bank-notices.ts`, `src/server/services/design-preview.ts`, `src/server/services/email-templates.ts`, `src/server/pdf/view.ts`, `src/server/pdf/labels.ts`, `src/components/invoices/payment-panel.tsx`, `src/components/invoices/invoice-table.tsx`, `src/app/(app)/faktury/[id]/page.tsx`, `src/lib/audit-labels.ts`, `src/lib/texts.ts`, `tests/helpers/consistency.ts`, `tests/fixtures/invoices.ts`
- Test: `tests/unit/payments.test.ts`, `tests/unit/payments-status.property.test.ts`, `tests/unit/qr-payload.test.ts`, `tests/unit/payment-matching.test.ts`, `tests/backend/invoice-balance.test.ts`, `tests/backend/invoices-list.test.ts`, `tests/backend/reminders.test.ts`, `tests/backend/pdf.test.ts`, `tests/backend/invoice-versions.test.ts`, `tests/backend/consistency.test.ts`

**Interfaces:**
- Consumes: `applyPayments`, `deriveStatus`, `findOwned`, `scoped`
- Produces:
  - `amountDue(row: { totalMinor; paidMinor; creditsMinor; advanceMinor; supersededAt }): number`
  - `dueSql: SQL<number>` v `invoices.ts`
  - `deriveStatus({ status; sentAt; totalMinor; paidMinor; creditsMinor; advanceMinor }): InvoiceStatus`
  - `canAmendPayment(status): boolean`
  - `ACTIVE_CREDIT_STATUSES = ['issued','sent']`, `isActiveDocument(status): boolean`
  - `refreshBalance(tx: Tx, audit: Audit, userId: string, invoiceId: string): Invoice`
  - `hasPayments` se přesune do `invoice-balance.ts` a `payments.ts` ho reexportuje, aby `advances.ts` v Task 6 nevytvořil cyklus přes `invoice-lifecycle.ts`

`invoice` nově: `credits_minor` (výchozí 0), `advance_minor` (výchozí 0), `superseded_at`, `related_snapshot` (JSON), index `(user_id, related_invoice_id)`. Migrace `--name invoice_balance`.

Spec: CRN-005, CRN-006 **[částečně]**, QR-006, INV-023, REM-006, BNK-008, TST-018 **[částečně]**. Viz **[R-3]**, **[R-4]**, **[R-9]**, **[R-32]**.

Pravidla:
- `refreshBalance` sečte aktivní opravy (`type = 'credit_note'`, `related_invoice_id = id`, stav v `ACTIVE_CREDIT_STATUSES`), načte `paid_minor` navázané zálohy, když `row.relatedInvoiceId` ukazuje na typ `advance`, zapíše `credits_minor`, `advance_minor`, `status` přes `deriveStatus`, `revision + 1` a audit `invoice.balance`. Volající žádnou aritmetiku nedělá.
- `applyPayments` u dokladu typu `advance` po zápisu zavolá `refreshBalance` konečné faktury. Podpis `applyPayments` získá `audit`, upraví se všechna volání.
- `isOverdue` a `overdueCondition` přejdou na `amountDue > 0`, SQL na `dueSql`. `tests` stále porovnávají obě formy. `customerInvoiceStats`, `invoiceSummary` a `invoiceRows` vybírají nová pole **[R-32]**, `InvoiceRow` nese i `type`.
- Nová pole musí vybírat každý dotaz, který dnes čte `totalMinor` kvůli zůstatku (ověř přes `grep -rn totalMinor src`): `REMINDER_COLUMNS`, `due-alerts`, oba dotazy v `bank-notices.ts`, `invoiceRows`, `StatusSteps` (dnes počítá `total - paid` ručně) a `payment-panel`. Typy `EligibleInvoice`, `MatchCandidate` a `DocumentTotals` pole mají povinná.
- `invoiceDocument` přidá pole do `totals` a `relatedDocument`. `diffInvoices` vedle `paidMinor` vynechá `creditsMinor`, `advanceMinor` a `supersededAt`, nejsou obsahem verze. `restoreVersion` je nezapisuje a `relatedDocument` mapuje na `relatedSnapshot`. `readVersion` starým dokumentům doplní nuly a `null`.
- `balanceWarningOf` jede přes nové `amountDue`: přeplatek po opravě je `overpaid`. Přechod z `credited` neexistuje, doklad není editovatelný. `deriveStatus` přečte `credited` jako vstup **[R-4]**.
- `totalRows` v PDF: celkem, `credits`, `paidByAdvance`, `paid`, `due`. Popisek `overpaid` „Přeplatek k vrácení“ při záporném zůstatku. Silný je poslední řádek. Doklady bez nových hodnot mají beze změny stejné řádky **[R-22]**.
- `assertConsistent` přidá: `credits_minor` je součet aktivních oprav, `advance_minor` je úhrada zálohy, stav odpovídá `deriveStatus`, `paid_minor >= 0`. Fixtura `seedCreditNote` vloží řádek opravy přímo pro testy tohoto úkolu, Task 3 ji nahradí službou.
- Přesuň z pending CRN-005 a CRN-006, `CRN-006` jde do partial s důvodem „chybí tvorba opravy“, plán 6, Task 3.
- `reminder` s `mustStateRest`: platí i pro doklad, kde `amountDue != total`, jinak upomínka s vlastní šablonou neřekne zbytek po opravě.

- [ ] **Step 1: Napiš testy**

```ts
test('[CRN-005] 12 100,00 + oprava -2 100,00 - platba 4 000,00 dá zbývá 6 000,00', ...)
test('[CRN-005] QR, upomínka, souhrn a karta zákazníka vycházejí ze stejné hodnoty 6 000,00', ...)
test('[CRN-006] 5 000,00 + oprava -5 000,00 bez plateb je credited a nejde na ni upomínka', ...)
test('[CRN-006] 5 000,00, platba 5 000,00, oprava -1 500,00 je paid s přeplatkem 1 500,00', ...)
test('[QR-006] částka v QR je 6 000,00 po opravě a platbě', ...)
test('[REM-006] upomínka s vlastní šablonou uvede zbytek po opravě', ...)
test('[BNK-008] avízo na 6 000,00 uhradí fakturu po opravě, 12 100,00 jde do fronty', ...)
test('[INV-023] úprava faktury s opravou počítá přeplatek z nového amountDue', ...)
test('refreshBalance zvýší revision a upomínka ve frontě se zadrží', ...) // přenos z plánu 4
test('refreshBalance je idempotentní a nepřičítá', ...)
test('[TST-012] stav je funkcí součtů a nezávisí na předchozím stavu včetně credited', ...) // fast-check
test('[TST-018] nesoulad credits_minor kontrola odhalí', ...)
test('souhrn: 1 000,00 a -400,00 dá fakturováno 600,00, po splatnosti 600,00', ...)
test('souhrn: stornovaná oprava se nepočítá', ...)
test('obnovení starší verze nepřepíše credits_minor', ...)
test('uložená verze bez nových polí jde otevřít a porovnat', ...)
test('PDF ukáže Přeplatek k vrácení 1 500,00', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/payments.test.ts tests/backend/invoice-balance.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** migraci, `refreshBalance`, nové výrazy a selecty.
- [ ] **Step 4: Ověř:** `timeout 170 pnpm exec vitest run --project unit`, pak `tests/backend/invoice-balance.test.ts tests/backend/invoices-list.test.ts tests/backend/reminders.test.ts tests/backend/payments.test.ts tests/backend/bank-notices.test.ts tests/backend/qr.test.ts`, pak `tests/backend/invoice-versions.test.ts tests/backend/consistency.test.ts tests/backend/pdf.test.ts tests/backend/due-alerts.test.ts`, PASS. `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(invoices): add balance from credit notes and advances`

---

### Task 3: Opravné faktury a vrácení peněz

**Files:**
- Create: `src/server/services/credit-notes.ts`, `src/components/invoices/refund-dialog.tsx`, `src/components/invoices/related-documents.tsx`, `tests/e2e/credit-notes.spec.ts`
- Modify: `src/server/services/invoice-lifecycle.ts`, `src/server/services/invoice-versions.ts`, `src/server/services/invoices.ts`, `src/server/services/invoice-document.ts`, `src/server/services/invoice-templates.ts`, `src/server/services/payments.ts`, `src/server/services/invoice-mail.ts`, `src/lib/payments.ts`, `src/lib/audit-labels.ts`, `src/lib/texts.ts`, `src/server/pdf/view.ts`, `src/server/pdf/labels.ts`, `src/server/pdf/parts.tsx`, `src/server/mail/defaults.ts`, `src/app/(app)/faktury/actions.ts`, `src/app/(app)/faktury/[id]/page.tsx`, `src/app/(app)/faktury/[id]/upravit/page.tsx`, `src/app/(app)/faktury/form-data.ts`, `src/components/invoices/invoice-actions.tsx`, `src/components/invoices/invoice-form.tsx`, `src/components/invoices/payment-panel.tsx`, `src/components/invoices/invoice-table.tsx`, `tests/backend/actions-isolation.test.ts`, `tests/helpers/consistency.ts`
- Test: `tests/backend/credit-notes.test.ts`, `tests/backend/payments.test.ts`, `tests/backend/payments.property.test.ts`, `tests/backend/invoice-mail.test.ts`, `tests/backend/users.test.ts`, `tests/e2e/credit-notes.spec.ts`

**Interfaces:**
- Consumes: `refreshBalance`, `issueIn`, `totalsOf`, `insertLines`, `accountForCopy`
- Produces:
  - `createCreditNote(actor, invoiceId): { id }`
  - `creditableMinor(q, ownerId, invoiceId): number`
  - `relatedDocuments(ownerId, id): { parent; children }`
  - `addRefund(actor, invoiceId, raw: PaymentInput): { id }`
  - `formChoices(ownerId, keptAccountId, type)`
  - actions `createCreditNoteAction`, `addRefundAction`

Spec: CRN-001, CRN-002, CRN-003 **[částečně]**, CRN-004, CRN-005, CRN-006, INV-002, INV-021, NUM-003, MAIL-003, PDF-001, ADM-006, AUD-001, TST-009. Viz **[R-5]** až **[R-10]**.

Pravidla:
- `createCreditNote` zapíše `credit_note`, `related_invoice_id`, řádky s `unitPriceMinor = -cena`, spočte součty přes `totalsOf` a zvolí výchozí řadu typu `credit_note`. Audit `invoice.credit_note`. Text před položkami se nekopíruje.
- `saveDraft` u konceptu s `related_invoice_id` odmítne změnu typu, zákazníka a měny, u opravy i kurzu. Bez existujícího řádku odmítne `type = 'credit_note'`.
- `issueIn` u opravy: původní doklad je v povoleném stavu, `total < 0`, nepřečerpá se, `variable_symbol = null`, zapíše `related_snapshot` a po uložení `refreshBalance` původní faktury. `keptAccountId` je účet původní faktury, skrytý účet opravu nezablokuje.
- `changeStatus` u opravy po storně a vrácení storna volá `refreshBalance`, vrácení storna kontroluje limit. `applyChange` u opravy kontroluje limit a totéž volá. Stráže **[R-7]** jsou v `applyChange` a `cancelInvoice` se zprávami `V.hasCredits`, `V.creditsExceedTotal`, `V.currencyHasCredits`.
- `insertPayment` zůstává jen kladný. `addRefund` má vlastní větev, `parseInput` je stejné, ukládá se zápor a `applyPayments` hlídá `paid_minor >= 0` **[R-8]**. `assertPayable` při úpravě a smazání používá `canAmendPayment`.
- `averagePaymentDays` čte jen `credited_minor > 0`. `receiptPayment` odmítne záporný řádek. Panel plateb ukáže vrácení znaménkem a nenabídne u něj „Poslat potvrzení“.
- Detail: tlačítko „Vytvořit opravnou fakturu“ u typu `invoice` v povoleném stavu, sekce souvisejících dokladů, tlačítko „Vrátit peníze“ jen při `paid_minor > 0`. Zůstatek pod nulou má řádek „Přeplatek k vrácení“.
- Opravná faktura nemá `PaymentPanel` ani `ReminderPanel`, stávající podmínka `takesPayment` drží. Fungují `Odeslat klientovi` s šablonou `credit_note`, PDF a verze.
- PDF: titul „Opravná faktura“, řádek detailu `labels.correctsDocument` s číslem a datem původního dokladu ze `related_snapshot`, popisek celku `labels.creditTotal` místo „Celkem k úhradě“. Platební box bez VS a QR.
- `formChoices` filtruje řady podle typu dokladu, dnes má natvrdo `invoice`.
- `duplicateInvoice` a `templateFromInvoice` opravu odmítnou **[R-5]**.
- `users.ts`: smazání účtu s opravou i zálohou musí projít přes `USER_OWNED_TABLES`, `related_invoice_id` nekaskáduje a SQLite kontroluje cizí klíč na konci příkazu. Test to dokáže.
- Texty podle **[R-10]** v `texts.ts`, `labels.ts`, `defaults.ts`. Přesuň z pending CRN-001, 002, 004, z partial odeber `CRN-006` a `CRN-003` přesuň z pending do partial se záznamem „Chybí statistiky a dashboard“, plán 7.

- [ ] **Step 1: Napiš testy**

```ts
test('[CRN-001] opravná faktura vzniká jen z vystavené faktury a odkazuje na ni', ...)
test('[CRN-001] má vlastní řadu D2026-001 a faktura dál 2026-002', ...)
test('[CRN-002] úplná oprava 12 100,00 se slevou a zaokrouhlením dá přesně -12 100,00', ...)
test('[CRN-002] částečná oprava upraveným množstvím dá -2 100,00', ...)
test('[CRN-003] oprava sníží fakturováno v seznamu i na kartě zákazníka z 1 000,00 na 600,00', ...) // spec-partial
test('[CRN-004] vrácení 1 500,00 je záporná platba a paid_minor klesne z 5 000,00 na 3 500,00', ...)
test('[CRN-004] vrácení nad přijatou částku je odmítnuté', ...)
test('[CRN-004] smazání kladné platby pod vrácenou částku je odmítnuté', ...)
test('[CRN-006] úplná oprava bez plateb dá credited, storno opravy vrátí sent', ...)
test('[CRN-006] 5 000,00 po opravě -1 500,00 a vrácení 1 500,00 je paid bez přeplatku', ...)
test('[CRN-006] úplná oprava a vrácení všeho dá credited a vrácení jde smazat', ...)
test('[CRN-005] vystavení, úprava a storno opravy přepočítají zůstatek a revizi původní faktury', ...)
test('[CRN-005] 1 000,00, oprava -600,00, druhá -500,00 je odmítnutá, -400,00 projde a dá credited', ...)
test('[INV-002] faktura s opravou nejde stornovat', ...)
test('[INV-021] oprava má verze a obnovení přepočítá původní fakturu', ...)
test('[MAIL-003] oprava jde odeslat šablonou credit_note a nastaví sent', ...)
test('[PDF-001] PDF opravy uvede číslo a datum původní faktury a nemá VS ani QR', ...)
test('přečíslování původní faktury nezmění vystavenou opravu', ...)
test('kurz a měna faktury s opravou jsou zamčené i při obnovení verze', ...)
test('oprava nejde duplikovat ani uložit jako šablona', ...)
test('oprava se skrytým účtem jde vystavit', ...)
test('banka opravu nikdy nepáruje', ...)
test('[ADM-006] smazání účtu s opravou a zálohou projde', ...)
test('[TST-009] akce oprav a vrácení odmítnou cizí ID', ...)
test('[AUD-001] oprava, přepočet zůstatku a vrácení jsou v auditu', ...)
test('opravná faktura od tlačítka po přeplatek a vrácení', ...) // e2e
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/credit-notes.test.ts tests/backend/payments.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** službu, stráže, UI a PDF. Hodnoty 1 000,00 a 600,00 z testů počítej ručně v haléřích, ne přes `computeTotals`.
- [ ] **Step 4: Ověř:** stejné testy, pak `tests/backend/invoice-versions.test.ts tests/backend/invoices.test.ts tests/backend/invoices-issue.test.ts tests/backend/invoice-mail.test.ts tests/backend/users.test.ts tests/backend/pdf.test.ts tests/backend/actions-isolation.test.ts tests/backend/payments.property.test.ts`, PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test credit-notes`, `timeout 170 pnpm exec playwright test payments`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(invoices): add credit notes and refunds`

---

### Task 4: Kurzy ČNB

**Files:**
- Create: `drizzle/0034_exchange_rate.sql`, `src/server/db/schema/exchange-rate.ts`, `src/lib/fx.ts`, `src/lib/cnb-rates.ts`, `src/server/external/cnb.ts`, `src/server/services/exchange-rates.ts`, `tests/fixtures/cnb/denni-kurz.txt`, `tests/fixtures/cnb/vikend.txt`, `tests/helpers/cnb.ts`
- Modify: `src/server/db/schema/index.ts`, `src/server/db/schema/job.ts`, `src/server/db/schema/payment.ts`, `src/server/db/schema/settings.ts`, `src/lib/preferences.ts`, `src/server/services/preferences.ts`, `src/server/services/payments.ts`, `src/server/services/bank-notices.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/services/recurring-run.ts`, `src/server/jobs/queue.ts`, `src/server/scheduler/start.ts`, `src/server/audit/record.ts`, `src/server/rate-limit.ts`, `src/server/env.ts`, `src/lib/automation.ts`, `src/lib/notification-text.ts`, `src/lib/audit-labels.ts`, `src/lib/texts.ts`, `src/components/invoices/payment-dialog.tsx`, `src/components/payments/notice-assign-dialog.tsx`, `src/app/(app)/faktury/actions.ts`, `src/app/(app)/platby/actions.ts`, `.env.example`, `docs/superpowers/specs/2026-10-30-fakturan-design.md` (jen řádek `CNB_BASE_URL` v 19.5), `stryker.config.json`, `tests/e2e/fixtures.ts`
- Test: `tests/unit/fx.test.ts`, `tests/unit/fx.property.test.ts`, `tests/unit/cnb-rates.test.ts`, `tests/backend/cnb.test.ts`, `tests/backend/exchange-rates.test.ts`, `tests/backend/payments.test.ts`, `tests/backend/recurring-run.test.ts`, `tests/backend/env.test.ts`, `tests/backend/scheduler.test.ts`

**Interfaces:**
- Consumes: `Fetcher`, `isWorkingDay`, `timeInPrague`, `registerJob`, `registerTickTask`, `enqueue`, `FxBasis`
- Produces:
  - `RATE_UNIT = 1_000_000`, `convertMinor(amountMinor, fromMicros, toMicros): number`, `toCzkMinor(amountMinor, rateMicros): number`, `rateFromList(text: string, amount: number): number | null`
  - `deviationExceeds(rateMicros, referenceMicros): boolean`
  - `expectedListDate(date: CalendarDate, now: Date): CalendarDate`
  - `rateDate(row: { issueDate; taxableDate }, basis: FxBasis, today): CalendarDate`
  - `parseDailyRates(text: string): { listDate: CalendarDate; rates: { currency: Currency; rateMicros: number }[] } | null`
  - `fetchDailyRates(date, fetcher?): Promise<ParsedRates | null>`
  - `type RateResult = { rateMicros; source: 'cnb' | 'last_known' | 'fixed'; listDate: CalendarDate | null; reference: number | null } | null`
  - `resolveRate(q: Reader, ownerId, currency, date, now): RateResult`, synchronní
  - `cnbRate(q, currency, date): number | null`, bez pevného kurzu
  - `ensureRate(currency, date, fetcher?): Promise<void>`, stáhne a uloží, nikdy nevyhodí
  - `loadRate(actor, raw: { currency; date }): Promise<RateResult>`
  - `planRateFetch(now: Date): void`, `runRateFetch(job): Promise<void>`
  - `creditPreview(actor, raw: { invoiceId; currency; amountMinor; paidOn }): Promise<{ creditedMinor: number } | null>`
  - `documentCzkMinor(row): number | null`, `paymentCzkMinor(row): number | null`
  - `RATE_RULES.fxLookupUser = rule('fxLookupUser', 60, 60)`
  - actions `loadRateAction`, `creditPreviewAction`

`exchange_rate`: `currency`, `list_date`, `rate_micros`, `fetched_at`, PK `(currency, list_date)`, index `(currency, list_date)` kryje PK. `invoice` nově `exchange_rate_source`, `exchange_rate_date`, `payment` nově `rate_micros`, `preferences` nově `fixed_rates` (JSON, výchozí `{}`). `JOB_KINDS` získá `fx.fetch`, sloupec nemá `CHECK`. Migrace `--name exchange_rate`.

Spec: FOR-003 **[částečně]**, FOR-004, FOR-008 **[částečně]**, FOR-009, FOR-010, PAY-006, TST-012, OPS-003, AUD-002. Viz **[R-11]** až **[R-19]**, **[R-23]** až **[R-25]**.

Pravidla:
- `parseDailyRates` je čistá, bez `server-only`, běží po řádcích, regulární výrazy nesmí mít katastrofální backtracking. Vrací jen měny z `CURRENCIES` bez CZK, ostatní řádky validuje, ale zahodí. Fixtura je tvarem věrná lístku z **[R-12]** se smyšlenými hodnotami a datem 30.10.2026.
- `fetchDailyRates` má vzor `lookupAres`: `AbortController`, 5 s, `catch` vrací `null`. Čte nejvýš 64 KiB, větší odpověď je `null`. Lístek s `listDate` po žádaném dni je `null`.
- `ensureRate` zapisuje přes `mutate` za aktéra `{ userId: null, source: 'system' }`, akce `exchange_rate.fetch`, entita `exchange_rate` se přidá do `INSTANCE_ENTITIES`, `onConflictDoNothing`. Audit nese jen datum a počet měn. Selhání je `null` a provozní stav, žádný `reportFailure`.
- `loadRate` v pořadí: `resolveRate`, a když výsledek není `cnb` ani `fixed`, rate limit, `ensureRate`, znovu `resolveRate`. Nikdy nevyhodí kvůli síti, překročený limit vrátí poslední známý výsledek.
- `reference` v `RateResult` je kurz ČNB k témuž dni i u pevného kurzu, slouží upozornění **[R-19]**.
- `issueIn` podle **[R-17]**: před `draftProblems` spočte `resolveRate` s `getPreferences(userId).fxBasis`, kandidát dostane kurz, zdroj i datum. `IssuePreview` přidá `rateNotes: string[]`.
- `runRecurringJob` před `processOccurrence` zavolá `ensureRate` pro měnu plánu mimo CZK a datum výskytu, výsledek ignoruje. `last_known` u automatického vystavení založí upozornění `rate_last_known`. Prázdná tabulka a výpadek dají stávající `fallback`, tedy koncept s upozorněním, žádná chyba úlohy.
- `insertPayment` a `updatePayment` doplní `rate_micros` přes `cnbRate`, CZK má `RATE_UNIT`. Chybějící kurz nic neblokuje **[R-24]**.
- `purgeFinishedJobs` maže `fx.fetch` po 7 dnech. `fxPlanTask` a `registerJob('fx.fetch', { run: runRateFetch })` jsou v `start.ts`.
- `preferencesSchema.fixedRates`: klíče mimo CZK, hodnoty kladné a do `MAX_EXCHANGE_RATE_MICROS`. `merged` musí sloupec převzít.
- Stryker mutuje `fx.ts` a `cnb-rates.ts`. Testy nesou FOR-003, 004, 008, 009 a 010, proto tato ID odejdou z pending do partial: FOR-003, 004, 009 a 010 s důvodem „chybí formulář“, plán 6, a `FOR-008` s důvodem „chybí statistiky“, plán 7. `PAY-006` a `TST-012` zůstávají v partial do Task 5.

- [ ] **Step 1: Napiš testy**

```ts
test('[FOR-004] parser přečte EUR 24,380 jako 24 380 000 mikro', ...)
test('[TST-012] lístek 100|HUF|37,512 dá 375 120 mikro za 1 jednotku', ...)
test('[FOR-004] rozbitá hlavička, chybějící sloupec, nulový kurz nebo 1.234,56 dají null a nic se neuloží', ...)
test('[FOR-003] lístek s datem po žádaném dni se zahodí, sobota 31. 10. 2026 má lístek z pátku 30. 10.', ...)
test('[FOR-003] 28. 10. 2026 je svátek a očekávaný lístek je 27. 10.', ...)
test('[FOR-003] pondělí 2. 11. 2026 v 10:00 používá lístek z pátku, ve 14:31 očekává pondělní', ...)
test('[FOR-003] den se bere v Praze: 31. 10. 2026 23:30 UTC je už 1. 11.', ...)
test('[FOR-009] základ DUZP použije DUZP a bez něj datum vystavení', ...)
test('[FOR-010] pevný kurz má přednost před ČNB', ...)
test('[FOR-010] reference 25,000000: 26,250000 a 23,750000 neupozorní, 26,250001 a 23,749999 ano', ...)
test('[FOR-004] nedostupná ČNB použije poslední známý lístek se zdrojem last_known', ...)
test('[FOR-004] prázdná tabulka a nedostupná ČNB vrátí null a ruční kurz jde vystavit', ...)
test('[FOR-004] timeout, HTTP 500, odpověď nad 64 KiB ani výjimka fetcheru nevyhodí', ...)
test('[FOR-003] vystavení vezme kurz k rozhodnému dni a pozdější lístek ho nezmění', ...)
test('[FOR-003] ruční kurz přežije vystavení beze změny', ...)
test('[TST-012] 1 234,56 EUR × 25,320000 = 31 259,06 Kč', ...) // 3 125 905,92 haléře
test('[TST-012] 333,33 EUR × 24,380000 = 8 126,59 Kč', ...) // 812 658,54 haléře
test('[TST-012] -1 234,56 EUR dá -31 259,06 Kč a půl haléře se zaokrouhlí od nuly', ...)
test('[TST-012] pro libovolnou částku a kurz je převod symetrický v záporu a nepřekročí bezpečné číslo', ...) // fast-check
test('[PAY-006] 100,00 USD na faktuře v EUR při 23,000000 a 25,000000 předvyplní 92,00 EUR', ...)
test('[PAY-006] 333,33 USD při 22,111000 a 25,320000 předvyplní 291,08 EUR', ...) // 29 108,4
test('[PAY-006] předvyplnění jde přepsat a platba uloží kurz dne úhrady', ...)
test('[PAY-006] bez kurzu předvyplnění nic nevrátí a ruční částka projde', ...)
test('[FOR-008] doklad 1 000,00 EUR při 25,000000 je 25 000,00 Kč, oprava -100,00 je -2 500,00 Kč', ...) // spec-partial
test('[OPS-003] CNB_BASE_URL má veřejný výchozí a lomítko se ořízne', ...)
test('[AUD-002] stažení kurzů je v auditu instance bez údajů účtu', ...)
test('pravidelná faktura v EUR se vystaví bez sítě z uloženého lístku a nekončí ve fallback', ...)
test('pravidelná faktura při výpadku s prázdnou tabulkou skončí konceptem bez chyby úlohy', ...)
test('tick založí jednu úlohu za hodinu a na prázdné instanci hned', ...)
test('testy kurzů nevolají globální fetch', ...) // vi.stubGlobal, který vyhodí
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/fx tests/unit/cnb-rates.test.ts tests/backend/cnb.test.ts tests/backend/exchange-rates.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** čisté funkce, klienta, tabulku, službu, úlohu a napojení. `tests/helpers/cnb.ts` je malý server nad `node:http` s režimy `ok`, `down`, `garbage`, `date(...)`.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/payments.test.ts tests/backend/recurring-run.test.ts tests/backend/invoices-issue.test.ts tests/backend/scheduler.test.ts tests/backend/env.test.ts tests/backend/preferences.test.ts tests/backend/bank-notices.test.ts` PASS, `timeout 170 pnpm run test:coverage-spec`, mutace `fx.ts` a `cnb-rates.ts` aspoň 90 %.
- [ ] **Step 5: Commit** `feat(fx): add cnb rates and currency conversion`

---

### Task 5: Zahraniční faktura ve formuláři

**Files:**
- Create: `drizzle/0035_foreign_invoice.sql`, `src/lib/clauses.ts`, `src/components/invoices/foreign-section.tsx`, `src/components/settings/fixed-rates.tsx`, `tests/e2e/foreign.spec.ts`
- Modify: `src/server/db/schema/invoice.ts`, `src/server/db/schema/supplier.ts`, `src/server/services/invoices.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/services/invoice-versions.ts`, `src/server/services/invoice-templates.ts`, `src/server/services/customers.ts`, `src/server/services/supplier.ts`, `src/server/services/invoice-document.ts`, `src/lib/invoice-document.ts`, `src/lib/invoice-diff.ts`, `src/lib/invoice-form.ts`, `src/lib/invoice-template.ts`, `src/lib/qr-payload.ts`, `src/lib/version-format.ts`, `src/lib/texts.ts`, `src/components/invoices/invoice-form.tsx`, `src/components/invoices/issue-dialog.tsx`, `src/components/settings/supplier-form.tsx`, `src/components/recurring/recurring-form.tsx`, `src/server/pdf/view.ts`, `src/server/pdf/parts.tsx`, `src/server/services/design-preview.ts`, `src/app/(app)/nastaveni/vychozi/page.tsx`, `src/app/(app)/faktury/form-data.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/invoice-form.spec.ts`, `tests/helpers/consistency.ts`
- Test: `tests/unit/invoice-form.test.ts`, `tests/unit/clauses.test.ts`, `tests/backend/invoices.test.ts`, `tests/backend/invoices-issue.test.ts`, `tests/backend/pdf.test.ts`, `tests/backend/supplier.test.ts`, `tests/e2e/foreign.spec.ts`

**Interfaces:**
- Consumes: `loadRateAction`, `planQr`, `isDomesticCountry`, `splitVatId`, `deviationExceeds`, `customerOffer`
- Produces:
  - `EU_COUNTRY_CODES`, `isEuVatId(dic: string): boolean`
  - `suggestedClause(input: { foreign; language; vatIdentified; customerDic; texts }): string`
  - `changeCurrency` maže kurz, `changeForeign(values, on, defaults, touched, accounts): FormValues`, `changeLanguage(values, language, clauseDefaults, touched)`
  - `applyRate(values, result: RateResult): FormValues`
  - `formQrState(values, accounts): QrState`
  - `AccountChoice` nově `iban: boolean`, `bic: boolean`
  - `CustomerDefaults.foreign`, `CustomerDefaults.dic`

`invoice` nově `foreign` (výchozí 0), `clause` (výchozí prázdný). `supplier` nově `reverse_charge_cs`, `reverse_charge_en` s výchozími texty z **[R-21]**. Migrace `--name foreign_invoice`.

Spec: FOR-001, FOR-003, FOR-004, FOR-005, FOR-006, FOR-007, FOR-009, FOR-010, SET-011, SET-012, QR-002, CUS-008, INV-010, INV-041, PDF-003. Viz **[R-16]**, **[R-18]** až **[R-22]**, přenos „EUR→USD ponechá starý kurz“.

Pravidla:
- `documentFields` získá `foreign`, `clause`, `exchangeRateSource`. `exchange_rate_date` zapisuje jen server. Normalizace **[R-18]** je ve společné funkci volané ze `saveDraft`, `createDraftIn` a `updateIssuedInvoice`.
- `updateIssuedInvoice` změněný kurz uloží se zdrojem `manual`, shodný nechá původní zdroj. U opravy je stráž **[R-5]**.
- `templateDocumentSchema` má `foreign` a `clause` s `.default`, staré uložené šablony a plány tak dál fungují. `draftInputFromDocument` je přenese, `exchangeRateMicros` zůstává `null` a doplní ho vystavení **[R-17]**.
- `recurring-form.tsx` dostane sekci `foreign-section.tsx` bez kurzu. Pravidelná faktura má jen přepínač a doložku.
- Sekce formuláře: přepínač, měna, kurz se štítkem zdroje (ČNB k datu, poslední známý, pevný, ručně zadaný), tlačítko „Použít kurz ČNB“, upozornění **[R-19]**, doložka s poznámkou o ověření poradcem. Vše přes `TEXTS.invoices.foreign`.
- `InvoiceForm` volá `loadRateAction` při změně měny, data a `fxBasis` s `ticket`, jen u konceptu a jen když `source != 'manual'`. Selhání akce ponechá pole prázdné a psatelné.
- `applyCustomerDefaults` a `customerOffer` přenášejí `foreign` a navržený text doložky. Zamčená měna nevypne přepínač.
- `documentProblems` u `clause` a `vatIdentified` kontroluje `supplier.dic` a `customer.dic` (FOR-006). `dic` v PDF se tiskne už dnes, popisek je `VAT ID`.
- `InvoiceView.clause`, blok v `InvoiceBody` před `vatStatement`, bez změny u prázdného textu **[R-22]**. Znění z dokumentu, ne z preference, vystavený doklad se nezmění.
- `/nastaveni/vychozi`: výběr rozhodného dne a tabulka pevných kurzů. Spec požaduje u pevného kurzu štítek ve formuláři.
- `supplier-form.tsx`: dvě pole doložky se stejným vysvětlením k ověření.
- **Přenosy z `tests/spec-partial.txt`:** `formQrState` ukáže důvod z `TEXTS.invoices.qr` i ve formuláři konceptu (QR-002), e2e test upozornění na chybějící účet (FOR-005), e2e test tlačítka obnovení údajů zákazníka na detailu (CUS-008). `planQr` se nemění.
- Stávající `invoice-form.spec.ts` vybírá měnu přímo. Doplň zapnutí přepínače, nezjednodušuj **[R-20]**.
- `assertConsistent`: CZK nemá kurz, vystavený cizí doklad má kurz, zdroj a datum, zdroj je z výčtu.
- Přesuň z pending FOR-001, FOR-006, FOR-007. Z partial odeber `FOR-003`, `FOR-004`, `FOR-005`, `FOR-009`, `FOR-010`, `QR-002`, `CUS-008`, `PAY-006`, `TST-012`.

- [ ] **Step 1: Napiš testy**

```ts
test('[FOR-001] přepínač odkryje měnu, kurz a doložku', ...) // e2e
test('[FOR-001] zákazník z Německa zapne přepínač, zákazník z Česka ne', ...)
test('[FOR-003] změna data přenačte automatický kurz, ruční zůstane', ...) // unit i e2e
test('[FOR-003] změna EUR na USD smaže i ruční kurz a načte nový', ...)
test('[FOR-003] pozdní odpověď na starý dotaz se zahodí', ...)
test('[FOR-004] ČNB dole: formulář ukáže poslední známý kurz s upozorněním a jde vystavit', ...) // e2e
test('[FOR-004] ČNB dole a prázdná tabulka: ruční kurz jde zadat a vystavit', ...) // e2e
test('[FOR-005] chybějící účet v USD formulář ukáže před vystavením', ...) // e2e
test('[FOR-006] identifikovaná osoba a DE123456789 dostanou doložku v češtině', ...)
test('[FOR-006] neidentifikovaná osoba, CZ DIČ a třetí země doložku nedostanou', ...)
test('[FOR-006] doložka jde upravit a smazat', ...)
test('[FOR-006] vystavení s doložkou chce DIČ obou stran', ...)
test('[FOR-006] PDF vytiskne doložku a VAT ID obou stran', ...)
test('[FOR-007] změna jazyka přeloží neupravenou doložku, upravenou nechá', ...)
test('[FOR-007] pravidelná faktura v angličtině má doložku anglicky', ...)
test('[FOR-009] nastavený základ DUZP řídí načtený kurz', ...) // e2e
test('[FOR-010] pevný kurz je ve formuláři označený a odchylka nad 5 % ukáže upozornění', ...) // e2e
test('[SET-011] vystavená faktura drží doložku i po změně nastavení', ...)
test('[SET-012] výchozí text doložky jde upravit v obou jazycích', ...)
test('[QR-002] formulář konceptu v EUR bez IBAN řekne proč QR není', ...) // e2e
test('[QR-002] změna účtu důvod změní', ...)
test('[CUS-008] tlačítko na detailu obnoví údaje zákazníka', ...) // e2e
test('[PAY-006] dialog platby v jiné měně předvyplní připsanou částku', ...) // e2e
test('CZK nikdy nedrží kurz ani z přímého volání služby', ...)
test('šablona a plán uložené před tímto plánem jdou načíst', ...)
test('doklad bez doložky má shodné PDF jako dřív', ...) // TST-014 reference beze změny
test('[TST-018] CZK s kurzem kontrola odhalí', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/invoice-form.test.ts tests/unit/clauses.test.ts tests/backend/invoices.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** sloupce, čisté funkce, formulář a nastavení. Komentář v `clauses.ts`: znění není ověřené, viz kap. 24 spec.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/invoices-issue.test.ts tests/backend/pdf.test.ts tests/backend/pdf-designs.test.ts tests/backend/supplier.test.ts tests/backend/invoice-templates.test.ts tests/backend/recurring.test.ts` PASS, `timeout 170 pnpm build`, po jednom `timeout 170 pnpm exec playwright test foreign`, `invoice-form`, `invoices`, `recurring`, `settings`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(invoices): add foreign invoices with clauses and rate form`

---

### Task 6: Zálohové faktury

**Files:**
- Create: `drizzle/0036_advance_invoice.sql`, `src/server/services/advances.ts`, `tests/e2e/advances.spec.ts`
- Modify: `src/server/db/schema/invoice.ts`, `src/server/db/schema/supplier.ts`, `src/server/services/invoice-balance.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/services/invoice-versions.ts`, `src/server/services/invoices.ts`, `src/server/services/payments.ts`, `src/server/services/supplier.ts`, `src/server/services/invoice-document.ts`, `src/server/services/design-preview.ts`, `src/lib/invoice-document.ts`, `src/lib/audit-labels.ts`, `src/lib/texts.ts`, `src/server/pdf/view.ts`, `src/server/pdf/labels.ts`, `src/server/pdf/parts.tsx`, `src/app/(app)/faktury/actions.ts`, `src/app/(app)/faktury/nova/page.tsx`, `src/app/(app)/faktury/page.tsx`, `src/app/(app)/faktury/[id]/page.tsx`, `src/app/(app)/faktury/[id]/upravit/page.tsx`, `src/components/invoices/invoice-actions.tsx`, `src/components/invoices/invoice-summary.tsx`, `src/components/invoices/related-documents.tsx`, `src/components/customers/customer-invoices.tsx`, `src/components/recurring/recurring-form.tsx`, `src/components/settings/supplier-form.tsx`, `tests/helpers/consistency.ts`, `tests/backend/actions-isolation.test.ts`
- Test: `tests/backend/advances.test.ts`, `tests/backend/invoices-list.test.ts`, `tests/backend/recurring-run.test.ts`, `tests/backend/pdf.test.ts`, `tests/unit/payment-matching.test.ts`, `tests/e2e/advances.spec.ts`

**Interfaces:**
- Consumes: `refreshBalance`, `issueIn`, `linkTags`, `accountForCopy`, `newDraftDefaults`, `draftInputFromDocument`
- Produces:
  - `newDraftDefaults(ownerId, customerId, type = 'invoice')`
  - `finalOf(q, ownerId, advanceId): Invoice | null`, aktivní konečná faktura
  - `createFinalIn(tx, audit, userId, advance: Invoice, note): { id }`
  - `convertAdvance(actor, advanceId): { id }`, ADV-004
  - `syncSuperseded(tx, audit, userId, finalId): void`
  - action `convertAdvanceAction`

`invoice` nově částečný unikátní index `invoice_final_of_advance_idx` **[R-26]**. `supplier` nově `advance_note_cs` (`Toto není daňový doklad.`), `advance_note_en` (`This is not a tax document.`). `SupplierSnapshot` je přidá, staré snapshoty čte `?? výchozí`. Migrace `--name advance_invoice`.

Spec: ADV-001, ADV-003, ADV-004, ADV-005 **[částečně]**, ADV-006, ADV-007 **[částečně]**, NUM-003, REM-006, QR-006, TST-018 **[částečně]**. Viz **[R-26]** až **[R-28]**, **[R-32]**, **[R-33]**.

Pravidla:
- `/faktury/nova?typ=zalohova` předá typ přes `upravit`, stránka `/faktury` má vedle „Nová faktura“ tlačítko „Nová záloha“. `InvoiceForm` dostane správné řady přes `formChoices` z Task 3.
- `createFinalIn` čte `finalOf` a při nálezu vrátí existující ID. Kopíruje podle **[R-28]** včetně štítků, zapíše `advance_minor` přes `refreshBalance`. Audit `invoice.final_from_advance`.
- `convertAdvance` jde ze stavů `issued`, `sent`, `partially_paid`, `paid`, vrací ID konceptu, opakovaný klik vrátí existující. Odmítne zálohu nahrazenou stornovanou fakturou jen tehdy, když aktivní existuje.
- `issueIn` u typu `invoice` s odkazem zapíše `related_snapshot` a zavolá `syncSuperseded`. `cancelInvoice` a `restoreInvoice` konečné faktury totéž, `cancelInvoice` zálohy s aktivní fakturou `V.hasFinalInvoice`. Porušení unikátního indexu v `restoreInvoice` převeď na `V.finalExists`, předem to zjistí `finalOf`.
- `syncSuperseded` zapisuje `superseded_at` a `revision + 1` na zálohu, zpráva ve frontě se tím zadrží. `insertPayment` u nahrazené zálohy odmítne kladnou platbu `E.superseded`, `addRefund` projde.
- `amountDue` u nahrazené zálohy v kódu z Task 2 už platí, tady se doplní testy a badge. Detail konečné faktury ukáže odkaz na zálohu, řádek „Uhrazeno zálohou“ a zbývající doplatek.
- PDF: `labels.paidByAdvance`, řádek detailu `labels.advanceOf`, u zálohy `TextBlock` s textem ze snapshotu v jazyce dokladu. Zaplacená záloha nemá QR.
- `invoiceSummary` a `customerInvoiceStats` podle **[R-32]**. `invoice-summary.tsx` a `customer-invoices.tsx` ukazují vlastní řádek neuhrazených záloh.
- ADV-006: typ v `recurring-form.tsx`, jen `invoice` a `advance`. `templateDocumentSchema` `credit_note` odmítne. Šablona `advance` v mailu už běží přes `kindForInvoice`.
- **Stejný VS:** `matchNotice` se nemění, test ho dokáže přes skutečné vystavení obou řad **[R-33]**.
- `assertConsistent`: nejvýš jedna aktivní konečná faktura, stejná měna a zákazník jako záloha, `superseded_at` právě když je konečná vystavená, `advance_minor` sedí.
- Přesuň z pending ADV-001, 003, 004, 006, ADV-005 a ADV-007 do partial: chybí statistiky a daňový přehled, plán 7 a 8.

- [ ] **Step 1: Napiš testy**

```ts
test('[ADV-001] záloha má řadu Z2026-001 a text Toto není daňový doklad.', ...)
test('[ADV-001] text jde upravit a vystavená záloha drží původní', ...)
test('[ADV-003] konečná faktura po záloze 10 000,00 ukáže Uhrazeno zálohou a zbývá 0,00', ...)
test('[ADV-003] faktura 12 100,00 po záloze 10 000,00 chce doplatek 2 100,00', ...)
test('[ADV-003] faktura odkazuje na zálohu a záloha na fakturu', ...)
test('[ADV-004] převod před úhradou dá koncept a opakovaný klik stejný doklad', ...)
test('[ADV-004] převod konceptu zálohy je odmítnutý', ...)
test('[ADV-005] platba 10 000,00 zůstane na záloze a souhrn ji počítá jednou', ...) // spec-partial
test('[ADV-005] úhrada v prosinci a faktura v lednu mají příjem k datu úhrady', ...) // spec-partial
test('[ADV-006] pravidelná záloha vystaví doklad řady záloh a mail advance', ...)
test('[ADV-007] fakturováno 10 000,00 zahrnuje konečnou fakturu, ne zálohu', ...) // spec-partial
test('[ADV-007] neuhrazená záloha 8 000,00 není v pohledávkách ani po splatnosti a je v advanceOpenMinor', ...) // spec-partial
test('[NUM-003] záloha, oprava a faktura mají své řady', ...)
test('[REM-006] nahrazená záloha nedostane upomínku, ani se zapnutým přepínačem', ...)
test('[QR-006] nahrazená záloha nemá QR a doplatek 6 000,00 je v QR faktury', ...)
test('částečná úhrada 4 000,00 z 10 000,00 a vystavená faktura: zbývá 6 000,00 a záloha je partially_paid', ...)
test('platba na nahrazenou zálohu je odmítnutá, vrácení projde', ...)
test('storno konečné faktury vrátí zálohu mezi otevřené', ...)
test('vrácení storna při druhé aktivní faktuře je odmítnuté', ...)
test('zálohu s aktivní fakturou nejde stornovat', ...)
test('stejný VS: záloha 12 000,00 a faktura 8 000,00 rozhodne částka', ...)
test('stejný VS a stejná částka jde do fronty jako multiple', ...)
test('po nahrazení zálohy jde stejný VS na konečnou fakturu', ...)
test('měna konečné faktury je zamčená i při úpravě', ...)
test('souběh dvou převodů dá jednu fakturu', ...) // run-workers
test('[TST-018] dvě aktivní konečné faktury kontrola odhalí', ...)
test('[TST-009] akce záloh odmítnou cizí ID', ...)
test('[AUD-001] převod a nahrazení jsou v auditu', ...)
test('záloha, úhrada, faktura', ...) // kritický tok, advances.spec.ts
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/advances.test.ts tests/backend/invoices-list.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** službu, stráže, PDF a stránky.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/payments.test.ts tests/backend/bank-notices.test.ts tests/backend/recurring-run.test.ts tests/backend/pdf.test.ts tests/backend/actions-isolation.test.ts tests/backend/reminders.test.ts tests/backend/qr.test.ts` PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test advances`, `timeout 170 pnpm exec playwright test recurring`, `timeout 170 pnpm run test:coverage-spec`.
- [ ] **Step 5: Commit** `feat(invoices): add advance invoices and final invoices`

---

### Task 7: Automatika po úhradě zálohy

**Files:**
- Create: `drizzle/0037_advance_final_mode.sql`, `src/server/services/advance-automation.ts`
- Modify: `src/server/db/schema/settings.ts`, `src/lib/preferences.ts`, `src/server/services/preferences.ts`, `src/lib/automation.ts`, `src/lib/notification-text.ts`, `src/lib/texts.ts`, `src/server/services/payments.ts`, `src/server/services/automation.ts`, `src/server/services/email-templates.ts`, `src/server/mail/defaults.ts`, `src/app/(app)/nastaveni/automatizace/page.tsx`, `src/components/settings/automation-panel.tsx`, `tests/backend/silence.test.ts`
- Test: `tests/backend/advance-automation.test.ts`, `tests/backend/automation.test.ts`, `tests/backend/silence.test.ts`, `tests/backend/email-templates.test.ts`, `tests/e2e/automation.spec.ts`

**Interfaces:**
- Consumes: `createFinalIn`, `issueIn`, `queueMail`, `composeMail`, `automaticSendAllowed`, `notify`, `resolveNotification`, `getAutomation`
- Produces:
  - `ADVANCE_FINAL_MODES = ['off','draft','issue']`, `Preferences.advanceFinalMode`, výchozí `draft`
  - `afterAdvancePaid(tx: Tx, audit: Audit, input: { userId; advanceId; paidOn; today }): void`, nikdy nevyhodí `ServiceError`
  - `advanceBalanceDropped(tx, userId, finalId): void`
  - `ADVANCE_FINAL_LINE: Record<Language, (zbyva: string, zaloha: string) => string>`
  - `NOTIFICATION_KINDS` získá `advance_final_failed`, `advance_final_held`, `advance_final_no_address`, `advance_final_bad_mail`, `advance_final_review`, `rate_last_known`

`preferences` nově `advance_final_mode`. Migrace `--name advance_final_mode`.

Spec: ADV-002, SET-040, SET-041, SET-042, SET-043, TST-016, BNK-009, MAIL-004, MAIL-003, AUD-001. Viz **[R-29]** až **[R-31]**.

Pravidla:
- `insertPayment` a `updatePayment` po `applyPayments` zjistí `before.status !== 'paid' && after.status === 'paid' && after.type === 'advance'` a zavolají `afterAdvancePaid`. `closeDifference` jde přes `insertPayment`, tedy také. `paidOn` je datum poslední platby.
- `afterAdvancePaid` v pořadí: režim `off` konec, `finalOf` existuje konec, `createFinalIn` v savepointu, režim `draft` konec, `paused` upozornění `advance_final_held` a konec, `issueIn` v savepointu, odeslání.
- Selhání `ServiceError` v savepointu je `advance_final_failed` s textem chyby a koncept zůstává. Jiná chyba je chyba kódu a běžně se šíří, jde o programátorskou vadu, ne stav dat.
- Odeslání podle **[R-30]** ve stejném tvaru jako `queueAutomaticReceipt`: pořadí kontrol, `mailMessageSchema`, `queueMail`, `null` je opakování. `applySent` už na `kindForInvoice` reaguje, stav faktury přejde správně. Hlavní vypínač při doručení kontroluje `refusal` beze změny.
- `advanceBalanceDropped` volá `refreshBalance` konečné faktury, když `advance_minor` klesl, a založí `advance_final_review` u vystavené faktury. Upozornění se vyřeší, když `amountDue <= 0` po další platbě.
- `AUTOMATIONS`: `advanceInvoice` má `available: true`. `automationImpact` a dialog uvedou počet zákazníků s adresou a podmínku režimu „Vystavit“. `setAutomation` jinak beze změny. Text `TEXTS.automation.items.advanceInvoice` přepiš, ať říká přesně, co a komu odejde.
- `/nastaveni/automatizace` ukáže `advanceFinalMode` jako výběr vedle přepínače. Výběr sám nic neposílá, proto nevyžaduje potvrzení SET-042.
- `composeMail` u `kind = 'invoice'` a `advanceMinor > 0` přidá `ADVANCE_FINAL_LINE` na konec těla, před podpis to nejde, protože šablona je volný text. Uložený text šablony se nemění a dialog odeslání větu ukáže předem.
- `armed` v `silence.test.ts` získá `advanceInvoice`. `available` z `AUTOMATIONS` matici rozšíří sám. Scénář potřebuje v předvyplněném účtu `advanceFinalMode: 'issue'` a uhrazenou zálohu z avíza.
- Z partial odeber `TST-016`, z pending ADV-002.

- [ ] **Step 1: Napiš testy**

```ts
test('[ADV-002] výchozí režim po úhradě 10 000,00 založí koncept a nic neodešle', ...)
test('[ADV-002] režim vypnuto nezaloží nic, ruční převod jde dál', ...)
test('[ADV-002] režim vystavit dá číslo z řady faktur', ...)
test('[ADV-002] chyba vystavení nechá platbu i koncept a založí upozornění', ...)
test('[ADV-002] platba, smazání a nová platba dají jednu fakturu', ...)
test('[ADV-002] uzavření rozdílu uhradí zálohu a založí fakturu', ...)
test('[ADV-002] úhrada z avíza i přiřazení z fronty fakturu založí', ...)
test('[SET-041] odeslání po záloze je na novém účtu vypnuté', ...)
test('[SET-042] zapnutí vyžaduje potvrzení s popisem a podmínkou režimu', ...)
test('[SET-040] stránka ukáže odeslání po záloze jako dostupné', ...) // e2e
test('[SET-043] hlavní vypínač změní vystavit na koncept a po uvolnění se nic samo neodešle', ...)
test('[BNK-009] vypnutá automatika po záloze SMTP nic nepošle', ...)
test('[MAIL-004] zapnutá automatika pošle jednu zprávu s fakturou na adresu zákazníka', ...)
test('[MAIL-003] zpráva faktury po záloze uvede zálohu a zbývá 0,00', ...)
test('úhrada stará 4 dny fakturu založí a nepošle', ...)
test('zákazník bez adresy založí upozornění', ...)
test('režim koncept nikdy neodešle ani se zapnutou automatikou', ...)
test('vrácení avíza sníží advance_minor, zadrží zprávu a založí kontrolu', ...)
test('vrácení peněz ze zálohy 10 000,00 po faktuře chce doplatek 10 000,00', ...)
test.each(MATRIX)('automatika %s při %s nepošle klientovi nic', ...) // TST-016, zahrnuje advanceInvoice
```

Název matice v `silence.test.ts` nese `[TST-016]` už dnes, poslední test jen ukazuje, kudy nová automatika prochází.

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/advance-automation.test.ts tests/backend/silence.test.ts tests/backend/automation.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** režim, hook, frontu a texty.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/mail-delivery.test.ts tests/backend/invoice-mail.test.ts tests/backend/email-templates.test.ts tests/backend/bank-notices.test.ts tests/backend/payment-receipt.test.ts tests/backend/notifications.test.ts` PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test automation`, `timeout 170 pnpm exec playwright test advances`.
- [ ] **Step 5: Commit** `feat(automation): issue and send final invoice after advance`

---

### Task 8: Odolnost, kritické toky a uzavření plánu

**Files:**
- Create: `tests/e2e/foreign-flow.spec.ts`
- Modify: `tests/backend/resilience.test.ts`, `tests/helpers/crash-worker.mjs`, `tests/helpers/run-workers.ts`, `tests/helpers/consistency.ts`, `tests/e2e/advances.spec.ts`, `README.md`, `.env.example`, `tests/spec-pending.txt`, `tests/spec-partial.txt`, `stryker.config.json`
- Test: `tests/backend/resilience.test.ts`, `tests/e2e/foreign-flow.spec.ts`, `tests/e2e/advances.spec.ts`

**Interfaces:**
- Consumes: všechny služby tohoto plánu, `runCrashWorker`, `TestImap`, `TestSmtp`, `startCnb`
- Produces: `CrashPoint` rozšířený o `in_advance_tx`, `after_advance_tx`, `in_credit_tx`

Spec: TST-012, TST-013, TST-014, TST-016, TST-017, TST-018 **[částečně]**, TST-009 **[částečně]**, kritické toky kap. 22.

Pravidla:
- `in_advance_tx`: `SIGKILL` uvnitř transakce avíza se zálohou, po restartu jedna platba a jedna faktura. `after_advance_tx`: po commitu a před posunem kurzoru, opakované čtení nic nezdvojí. `in_credit_tx`: pád při vystavení opravy, doklad i zůstatek se vrátí spolu. Všechny běží přes `assertConsistent`.
- `SIGKILL` během `fx.fetch` nezanechá částečný lístek, zápis je jedna transakce.
- Kritický tok „zahraniční faktura v EUR“: zákazník z DE, přepínač, kurz z pahýlu, doložka, QR EPC, vystavení, změna lístku kurz nezmění, platba v USD s předvyplněním. Kritický tok „záloha → faktura“: vystavení zálohy, úhrada z avíza přes `TestImap`, faktura, odeslání, vrácení, upozornění.
- Docker: závislosti se nemění, ale `start.ts` má novou úlohu, proto jeden běh `docker-scheduler`.
- `.env.example` a README: `CNB_BASE_URL`, co se stane při výpadku ČNB, doložky k ověření poradcem, režim po úhradě zálohy, proč se kurz netiskne. Spec kap. 24 se nemění, bod o doložce zůstává otevřený.
- `tests/spec-partial.txt` po uzavření, sloupce jsou odděleny tabulátorem:
  - přidat nebo ponechat `CRN-003`: Chybí statistiky a dashboard; plán 7
  - přidat nebo ponechat `ADV-005`: Chybí příjmy ve statistikách a daňovém přehledu; plán 7 a 8
  - přidat nebo ponechat `ADV-007`: Chybí řádek záloh ve statistikách; plán 7
  - přidat nebo ponechat `FOR-008`: Chybí statistiky, hotový je přepočet; plán 7
  - odebrat `TST-012`, `PAY-006`, `QR-002`, `FOR-005`, `CUS-008`, `TST-016`
  - upravit `TST-009`: Matice nemá roli administrátora ani entity plánů 7 a 8; plán 7 a 8
  - `TST-018` ponechat „Kontrola nepokrývá přehledy“, plán 7
  - `TST-013`: doplnit změřené skóre `fx.ts`, `cnb-rates.ts`, `invoice-totals.ts`, `payments.ts`, `qr-payload.ts`, nebo ponechat s přesným důvodem
- Z `tests/spec-pending.txt` vypadnou: ADV-001 až 007, CRN-001 až 006, FOR-001, 003, 004, 006, 007, 008, 009, 010. V pending zůstává REP-008, REP-009 a vše z jiných plánů.

- [ ] **Step 1: Napiš testy**

```ts
test('[TST-017] SIGKILL v transakci zálohy: po restartu jedna platba a jedna faktura', ...)
test('[TST-017] SIGKILL po transakci před kurzorem: žádná druhá faktura', ...)
test('[TST-017] SIGKILL při vystavení opravy: zůstatek odpovídá dokladům', ...)
test('[TST-017] výpadek ČNB během běhu: vystavení, platby a plán dál fungují', ...)
test('[TST-017] plný disk při zápisu lístku: nic se neuloží a další běh doplní', ...)
test('[TST-018] po každém scénáři projde kontrola souladu', ...)
test('zahraniční faktura v EUR od zákazníka po platbu', ...) // kritický tok, foreign-flow.spec.ts
test('záloha z avíza po fakturu, odeslání a vrácení', ...) // kritický tok, advances.spec.ts
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/resilience.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** pomůcky a oprav nálezy v kódu. Každá oprava má vlastní test.
- [ ] **Step 4: Ověř po částech:** `timeout 170 pnpm exec vitest run --project unit`, pak `timeout 170 pnpm exec vitest run --project backend --shard=N/4` pro N = 1 až 4, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`.
- [ ] **Step 5: Ověř e2e po souborech:** `timeout 170 pnpm build` a pro každý soubor v `tests/e2e` zvlášť `timeout 170 pnpm exec playwright test <soubor>`, kromě `docker-*`.
- [ ] **Step 6: Ověř obraz** po vrstvách s `timeout 170`: `--target deps`, `--target build`, celý obraz, pak `E2E_DOCKER_IMAGE=fakturan-ci timeout 170 pnpm exec playwright test docker-scheduler`. Když krok buildu sám přesáhne limit, zapiš „Docker neověřen“ a neběž na pozadí.
- [ ] **Step 7: Uzavři:** uprav `tests/spec-pending.txt` a `tests/spec-partial.txt`, `pnpm run test:coverage-spec`, PASS. Mutace `invoice-totals.ts`, `fx.ts`, `cnb-rates.ts`, `payments.ts`, `qr-payload.ts` přes dočasnou konfiguraci, každý aspoň 90 %.
- [ ] **Step 8: Commit** `test(invoices): add crash, flow and closing coverage for plan 6`

---

## Sebekontrola proti spec

| Oblast | Úkol | Poznámka |
|---|---|---|
| 7.1 Typy dokladů | 3, 6 | Řady, formulář, filtr, název **[R-10]** |
| FOR-001, 005, 007 | 5 | FOR-005 uzavírá partial e2e testem |
| FOR-002 | – | Hotové z plánu 2 a 3 |
| FOR-003, 004 | 4, 5 | Lístek, přenačtení, zamrznutí **[R-14]** až **[R-17]** |
| FOR-006 | 5 | Doložka předvyplněná, ověří poradce **[R-21]** |
| FOR-008 | 4 | Partial do plánu 7 **[R-25]** |
| FOR-009, 010 | 4, 5 | **[R-19]**, **[R-23]** |
| ADV-001, 003, 004, 006 | 6 | **[R-26]** až **[R-28]** |
| ADV-002 | 7 | **[R-29]**, **[R-30]** |
| ADV-005, 007 | 6 | Partial do plánu 7 a 8 **[R-32]** |
| CRN-001, 002, 004, 006 | 1, 2, 3 | **[R-1]** až **[R-8]** |
| CRN-003 | 3 | Partial do plánu 7 |
| CRN-005 | 2, 3 | Zůstatek a revize **[R-3]** |
| SET-011 | 5 | Přepínač existuje, doložka ho používá |
| SET-040 až 043 | 7 | Poslední ze čtyř automatik |
| PAY-006 | 4, 5 | **[R-24]** |
| QR-002 | 5 | Důvod i ve formuláři |
| CUS-008 | 5 | E2E tlačítka |
| REP-009 | 4 | Jen výpočet a `payment.rate_micros`, zůstává v pending pro plán 7 |
| TST-012 | 1, 4 | Záporné částky, přepočty, fast-check |
| TST-013 | 1, 4, 8 | Stryker nad `fx.ts`, `cnb-rates.ts`, `invoice-totals.ts` |
| TST-014 | 1, 5 | Ručně spočtené vzory, reference beze změny **[R-22]** |
| TST-016, 017, 018 | 2, 5, 6, 7, 8 | TST-018 přehledy plán 7 |
| Přenos z plánu 3 | 1, 2, 4, 5, 6 | Typy, přepínač, ČNB, EUR→USD, CZK s kurzem, `credited` v souhrnech, `computeTotals` |
| Přenos z plánu 4 | 2, 3, 4, 7 | Odeslání po záloze, TST-016, kurz pro pravidelné, šablony `advance` a `credit_note`, revize po CRN-005 |
| Přenos z plánu 5 | 2, 3, 4, 6, 7 | `amountDue` a SQL souhrny, CRN-004, CRN-006, `deriveStatus`, PAY-006, ADV-002, stejný VS |

Mimo rozsah zůstávají statistiky (REP, TAX), dashboard, import a export ISDOC. Otevřené body kap. 24 „Znění doložky FOR-006, náležitosti neplátce, TAX-001, použití pevného kurzu FOR-010“ zůstávají otevřené a tento plán je neuzavírá.

## Přenos do dalších plánů

- **Daňový poradce (před ostrým použitím):** znění doložky FOR-006 v obou jazycích **[R-21]**, text „Toto není daňový doklad.“ a anglická verze, název „Opravná faktura“ pro neplátce a povinné údaje opravy **[R-10]**, použití pevného kurzu **[R-23]**, zda identifikovaná osoba potřebuje na dokladu kurz nebo částku v CZK **[R-22]**, data na konečné faktuře a chybějící DUZP **[R-28]**. Po ověření upravit výchozí texty a uzavřít bod v kap. 24.
- **Plán 7:** uzavřít `CRN-003`, `ADV-005`, `ADV-007`, `FOR-008`, `REP-008`, `REP-009`. Fakturováno a obrat přes `documentCzkMinor`, s `type <> 'advance'`. Příjmy přes `paymentCzkMinor` včetně záporných plateb s `kind = 'payment'`. U `rate_micros = null` dopočítat z `exchange_rate`, nebo řádek označit, nikdy ho tiše nevynechat. Hlídání limitů počítá opravy se záporem a zálohy jen konečnou fakturou. Widget záloh z `advanceOpenMinor`. TST-018 má přehledy s `credits_minor` a `advance_minor`. `dueSql` použít i v dashboardu, nepočítat `total - paid`.
- **Plán 8:** ISDOC typ dokladu a odkaz: `credit_note` nese `related_invoice_id` a zápor, importované doklady nesmí spouštět `afterAdvancePaid` ani párovat bez rozhodnutí. Import dokladů bez kurzu v cizí měně nesmí selhat na `exchange_rate_source`. Záloha účtu nese `credits_minor`, `advance_minor`, `superseded_at`, `related_snapshot`, `exchange_rate_*` a `preferences.fixed_rates`, ale tabulka `exchange_rate` je instanční a do zálohy účtu nepatří, obnova ji znovu stáhne. Export uzavře INV-024. IMP-010 po obnově vrátí `advance_final_mode` na `draft`, ostatní automatiky jsou vypnuté. TAX-001 přebere znaménko vrácení a datum úhrady zálohy, s rozdílným rokem faktury.
- **Plán 9:** dokumentace zahraničních faktur a záloh, UI-012 s vysvětlením stavu „dobropisovaná“ a přeplatku. Rozhodnout o řadách, aby faktura a záloha neměly stejný VS, a vyhodnotit první ostrou zkušenost **[R-33]**. Hlídat, že `fx.fetch` na produkci běží, nejvhodněji přes stav instance ADM-008. Přidat `CNB_BASE_URL` do ukázek nastavení.
- **Známá rizika:** ČNB změní nebo zablokuje textový lístek, pak všechny nové kurzy jsou `last_known` s upozorněním a ruční zadání funguje **[R-12]**. Faktura vystavená ráno před 14:30 má předchozí lístek, je to platný kurz pro daný čas, ne chyba **[R-14]**. Kurz k historickému dni se dotahuje až při potřebě, takže při výpadku může být `last_known` i u starého data **[R-15]**. Faktura vystavená automaticky se nevrací po vrácení platby, jen upozorní **[R-31]**. Odeslanou fakturu po záloze nejde vzít zpět. Věta v `ADVANCE_FINAL_LINE` jde na konec textu za podpis, protože šablona je volná **[R-30]**. Službu od zboží aplikace nepozná, doložka je návrh, který musí člověk zkontrolovat **[R-21]**.
