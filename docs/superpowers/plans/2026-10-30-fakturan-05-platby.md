# Fakturan 5: Platby a avíza Fio – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uživatel zaznamená úhradu jedním klikem nebo ji aplikace sama spáruje z avíza Fio ve schránce uživatele. Stav faktury, QR, upomínky a karta zákazníka vycházejí z jednoho výpočtu, žádné avízo se nezapočítá dvakrát ani neztratí a klientovi nic neodejde bez zapnuté automatiky.

**Architecture:** Zdrojem pravdy je tabulka `payment`, `invoice.paid_minor` je její součet a zapisuje ho jediná funkce `applyPayments`, která zároveň odvodí stav a zvýší `revision`. Avíza jdou trubkou se třemi vrstvami: úloha `bank.poll` jen čte schránku přes `imapflow`, čistý parser v `src/lib/bank-notices` převede text na data a čistá funkce `matchNotice` rozhodne o spárování. Každá zpráva je jedna transakce přes `mutate`, kde řádek `bank_notification`, platba i případné potvrzení vzniknou spolu, takže pád mezi zprávami nic neztratí a opakované čtení nic nezdvojí.

**Tech Stack:** Next.js 16.4, Drizzle, better-sqlite3, Zod, `imapflow` (nově), `mailparser` (z dev do produkce), `croner`, `nodemailer`, Vitest, fast-check, Stryker, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`, kap. 13 (PAY, BNK), 5.5, QR-005, QR-006, CRN-005, INV-023, INV-024, CUS-006, SET-040 až 043, SEC-003, SEC-007, TST-006, TST-013, TST-016, TST-018, UI-011. Přenosy z konců plánů 3 a 4.

## Global Constraints

- Správce balíčků je pnpm. Práce probíhá na `main`. Nic se nepushuje a nic se nenasazuje.
- **Harness přesouvá příkazy nad 180 s na pozadí.** Každý příkaz v popředí proto běží nejvýš 170 s (`timeout 170 …`) a dlouhé běhy se dělí po částech: `pnpm exec vitest run --project unit`, `pnpm exec vitest run --project backend --shard=N/4` a Playwright po jednotlivých souborech. **Nikdy nečekej na úlohu na pozadí.** Běh, který se do limitu nevejde, rozděl jemněji. Když to nejde, zapiš do zprávy úkolu „neověřeno“ s příkazem a nepředstírej úspěch.
- `pnpm build` před Playwrightem, protože fixture spouští `next start`.
- `minimumReleaseAge` se neobchází: žádný `--config` ani změna `pnpm-workspace.yaml`. Když je nejnovější verze moc čerstvá, použij nejbližší starší, kterou pnpm přijme.
- Každá nová závislost s nativní částí nebo soubory čtenými za běhu se ověří v Docker obrazu. Docker je jediná build cesta.
- Implementeři neběží souběžně. Úkoly jdou po sobě a každý začíná z čistého stromu po commitu předchozího.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů. Agent staguje jen své soubory.
- Komentáře jen pro neočividné invarianty. **UI texty česky a v `src/lib/texts.ts`**, jen tokeny barev. Texty, které dostane klient, patří dokumentu: leží v `src/server/mail/defaults.ts`.
- **Migrace navazují po nejvyšší v `drizzle/`,** dnes `0026_reminder_offset`: `pnpm exec drizzle-kit generate --name <jméno>`, čísla podle úkolů níže. Ruční SQL jen tam, kde to úkol říká.
- Service kód běží v testech i přes type stripping Node (`tests/helpers/*-worker.mjs`), proto žádné `constructor(readonly x)` ani jiná syntaxe vyžadující transformaci. Vlastnost deklaruj zvlášť a přiřaď v konstruktoru, vzor `BlockedHostError`.
- Před kódem v App Routeru přečti příslušný návod v `node_modules/next/dist/docs/` (viz `AGENTS.md`).
- Název testu obsahuje ID požadavku, `tests/spec-pending.txt` se průběžně zmenšuje. ID splněné jen zčásti a bez testu v seznamu zůstává a `test:coverage-spec` selže na ID, které je zároveň v seznamu i v názvu testu, takže takový test ID v názvu nenese a nad testem je komentář proč. ID s testem, které ještě není splněné celé, jde do `tests/spec-partial.txt` (tři sloupce oddělené tabulátorem: ID, co chybí, plán). Úkoly to mají označené **[částečně]**.
- Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)`. Mutace je synchronní, IMAP ani SMTP v ní neběží.
- Plánovač jedná za aktéra `{ userId: ownerId, source: 'scheduler' }`.
- Každý dotaz na data účtu jde přes `scoped(ownerId)`. Každá nová tabulka s vlastníkem patří do `USER_OWNED_TABLES` před tabulky, na které nekaskádově odkazuje, a má test `assertIsolated` včetně `update` a `remove`. Server actions pokrývá `tests/backend/actions-isolation.test.ts`.
- Aktuální čas jen přes `clock`, „dnes“ přes `calendarDateInPrague`. V běhových službách není `new Date()` bez argumentu ani `Date.now()`.
- Úlohy nesou v `payload` jen ID a data. Adresy, hesla, text zprávy, protiúčet ani jméno protistrany do `payload`, logů, auditu ani Sentry nepatří.
- `registerJob` a tick úlohy se registrují jen v `src/server/scheduler/start.ts`, protože instrumentation má vlastní bundle. `registerDerivedAlerts` naopak běží v grafu tras jako vedlejší účinek importu, vzor `due-alerts.ts`.
- Nic neodejde klientovi bez kliknutí nebo zapnuté automatiky. Vstupy se validují na serveru sdíleným Zod schématem.

## Review Focus

1. Podvržené avízo: cizí e-mail s `From: automat@fio.cz`, vlastní hlavička `Authentication-Results`, DKIM cizí domény nebo prozatímní česká varianta nesmí fakturu automaticky uhradit, zastavit upomínky ani spustit potvrzení (Task 3, Task 5).
2. Dvojí započtení: stejná zpráva přečtená znovu, reset `UIDVALIDITY`, pád uprostřed dávky, retence po 90 dnech a dvě schránky. Každé ID pokynu dá nejvýš jednu platbu (Task 5, Task 8).
3. Soulad stavu: každý zápis platby zvýší `revision`, `partially_paid` zachová `sent_at`, zaplacení před odesláním neztratí pozdější `sent_at`, úprava a obnovení verze přepočítají stav, zpráva ve frontě se starou částkou neodejde (Task 1, Task 7).
4. Špatné spárování: stejný VS u faktury a zálohy, úvodní nuly, jiná částka, jiná měna, jiný cílový účet, už uhrazený doklad. Sporný případ jde vždy do fronty a vrácení vrátí vše včetně stavu (Task 5, Task 6).
5. IMAP jako cesta do sítě a únik bankovních dat: DNS rebinding, IPv4 v IPv6, port mimo IMAP, chybová hláška jako sonda, heslo a nemaskovaný obsah avíza v auditu, logu, Sentry nebo klientském bundle (Task 4, Task 5).

## Rozhodnutí plánu

Uživatel chtěl plány bez čekání, proto je plán rozhodl sám. Na `[R-n]` se odkazují úkoly. Čísla platí jen v tomto plánu.

- **[R-1] Zdroj pravdy je `payment`.** `invoice.paid_minor` je denormalizovaný součet `credited_minor`. Zapisuje ho jen `applyPayments`, vždy jako nový `SUM`, nikdy přičtením. Každé volání zvýší `revision` i bez změny stavu a netvoří verzi dokladu, platby nejsou obsahem verze.
- **[R-2] Odvození stavu.** Základ je `sent`, když je `sent_at` vyplněné, jinak `issued`. `paid` nastane při `total > 0` a nulovém nebo záporném zbývá, `partially_paid` při součtu plateb nad nulou a kladném zbývá, jinak základ. Výpočet bere zbývající částku z `amountDue`, ne z `total_minor`, a týká se jen `AWAITING_PAYMENT` a `paid`.
- **[R-3] `sent_at` se doplňuje i po platbě.** `applySent` dnes reaguje jen na `issued`, takže faktura zaplacená před odesláním by `sent_at` nikdy nedostala a smazání platby by ji vrátilo na `issued`, i když klient doklad má. Nově `applySent` u `partially_paid` a `paid` doplní prázdné `sent_at` beze změny stavu a `markSent` jde spustit i u těchto stavů s prázdným `sent_at`. Potvrzení platby ani upomínka `applySent` nespouštějí, podmínka `log.kind === kindForInvoice(row.type)` zůstává.
- **[R-4] Platba jen na `issued`, `sent`, `partially_paid`, `paid`.** Koncept, storno a dobropis platbu odmítnou. Storno doklad s řádkem v `payment` odmítne, i když součet vyšel nula. Mazání konceptu se netýká, koncept platby nemá.
- **[R-5] Platba je v tomto plánu kladná.** Schéma nemá `CHECK`, ale služba odmítne `amount_minor <= 0`. Vrácení peněz (CRN-004) a záporný zůstatek (CRN-006) přidá plán 6.
- **[R-6] Způsob úhrady má vlastní výčet** `PAYMENT_CHANNELS = ['transfer','cash','other']` podle PAY-003. `PAYMENT_METHODS` dokladu mají `card`, proto `markPaid` mapuje `transfer` a `cash` na sebe a `card` na `other`.
- **[R-7] PAY-006 bez ČNB.** Kurz je plán 6. U jiné měny formulář vyžaduje `credited_minor` ručně a nic nepředvyplňuje. Avízo v jiné měně jde vždy do fronty. ID jde do `tests/spec-partial.txt`.
- **[R-8] PAY-007 je řádek `payment` s `kind = 'difference'`,** `method = 'other'`, `source = 'manual'`, kladný a započtený do `paid_minor`. Díky tomu `amountDue`, QR, souhrny i SQL zůstávají beze změny a plán 7 oddělí skutečné příjmy filtrem `kind = 'payment'`. Akce jde jen na `partially_paid`, hodnotu počítá server a dialog ji ukáže před potvrzením. Pevný limit „malého rozdílu“ spec nezná a plán ho nevymýšlí. Řádek jde smazat jako každou ruční platbu.
- **[R-9] Změna měny dokladu s platbami je zakázaná.** `credited_minor` je v měně faktury, přepsání měny by částky tiše převedlo na jiné peníze. Stráž je v `applyChange`, platí proto pro úpravu i obnovení verze.
- **[R-10] Platba z avíza má zamčené částky.** Upravit jde datum, způsob a poznámka. Smazání je totéž co vrácení celého avíza **[R-22]**, jinak by po rozdělení zůstala část peněz bez evidence.
- **[R-11] Schránka je jen ke čtení.** `mailboxOpen` v režimu read-only, žádné příznaky, přesuny ani mazání. Nejdřív se stahuje jen obálka a tělo až po shodě odesílatele a předmětu, takže cizí pošta aplikací neprojde. Kurzor je `(uid_validity, last_uid)` a posouvá se až po uložení zprávy. První běh čte nejvýš 30 dní zpět. Limit je 50 zpráv na běh, 256 KiB na zprávu a tvrdý strop běhu 60 s, pod lease 120 s. Přebytek počká na další běh.
- **[R-12] IMAP má vlastní porty 143 a 993.** `assertPublicHost` dnes povoluje jen porty SMTP, proto dostane volbu `ports`, výchozí zůstává SMTP. TLS je povinné: 993 implicitně, 143 se STARTTLS a selhání STARTTLS je chyba. Spojení jde na ověřenou IP se `servername` původního hostitele. `ALLOW_PRIVATE_MAIL_HOSTS` obě omezení ruší jen pro privátní cíl, stejně jako u SMTP.
- **[R-13] Třídění zpráv.** Přesný odesílatel `automat@fio.cz` bez ohledu na velikost písmen, právě jedna adresa ve `From`. Tři předměty z BNK-004 jdou do parseru. Předmět Fio s výdajem (`výdaj`, `vydaj`, `expense`, `debit`, `outgoing`) se ignoruje a neukládá. Jiný předmět od Fio se založí jako `unrecognized` bez těla, aby změna formátu nezůstala bez povšimnutí (BNK-012). Jiný odesílatel se nestáhne ani nezaznamená.
- **[R-14] Parser je přísný.** Variantu určí předmět a locale se nikdy nezkouší náhradně, `1,234` nesmí být 1,23 ani 1234. Pole se hledají podle popisků, ne podle pozice řádku, popisky leží v jedné tabulce v `fio.ts`. Chybí-li cílový účet, částka, měna, datum nebo ID pokynu, výsledek je `null`, tedy `unrecognized`. Částka musí být nad nulou. Spec jmenuje jen `Protistrana`, `Variable symbol`, `Counterparty` a `Instruction ID`. Ostatní popisky jsou předpoklad a selžou bezpečně do BNK-012.
- **[R-15] Česká varianta se automaticky nepáruje.** `AUTO_MATCH_VARIANTS = ['en']` v `src/lib/bank-notices/index.ts`. Česká avíza se čtou a jdou do fronty s důvodem `provisional` a štítkem „Prozatímní formát, ověřte údaje“ v seznamu, detailu i v nastavení. Parser mimo ověřený formát nesmí sám měnit stav faktury a spouštět potvrzení. Po dodání vzorku se fixtury nahradí, konstanta se rozšíří a záznam zmizí z `tests/spec-partial.txt`. Otevřený bod ve spec kap. 24 zůstává.
- **[R-16] BNK-013: věří se jen nejvyšší hlavičce `Authentication-Results`,** kterou přidal server příjemce, nižší mohl poslat útočník. Prošlo znamená `dkim=pass` s `header.d` nebo `header.i` v doméně `fio.cz`, nebo `spf=pass` se `smtp.mailfrom` v `fio.cz`, nebo `dmarc=pass` s `header.from=fio.cz`. Výsledky `fail` jdou do fronty. Chybějící výsledek se řídí `require_confirmation`, výchozí **zapnuto**, tedy do fronty s důvodem `unverified`. Bezpečnější výchozí stav stojí nejvýš ruční klik, opačný by podvrženou zprávu uhradil fakturu. Fronta ukáže nápovědu k přepínači.
- **[R-17] Párování.** Normalizace VS odstraní úvodní nuly na obou stranách. Kandidáti jsou doklady s číslem ve stavu `AWAITING_PAYMENT` se stejným VS. Automaticky se páruje, když právě jeden kandidát má shodnou měnu a `amountDue` rovné částce avíza a jeho `bank_account_id` je cílový účet nebo prázdné. Stejný VS u faktury a zálohy (`{RRRR}-{NNN}` a `Z{RRRR}-{NNN}`) s různými částkami tak rozhodne částka, se shodnými jde do fronty. Důvody fronty: `unknown_vs`, `no_vs`, `amount`, `currency`, `multiple`, `other_account`, `closed` (VS patří jen uhrazenému dokladu), `provisional`, `unverified`, `auth_failed`, `undone`. Zaokrouhlení ani tolerance neexistují.
- **[R-18] Retence neotevře duplicitu.** Po 90 dnech se v `bank_notification` smažou text, jméno, zpráva a protiúčet a nastaví se `purged_at`. Řádek s `dedupe_key` zůstává navždy, jinak by zpráva přečtená po resetu `UIDVALIDITY` vznikla znovu a zaplatila podruhé. Nevyřízené `pending` a `unrecognized` se nečistí, uživatel o ně nesmí přijít (BNK-012). Klíč je `fio:<účet>:<ID pokynu>`, u nerozpoznaných `msg:<sha256 Message-ID nebo zdroje>`.
- **[R-19] Maskování.** `text_masked` má v souvislých číslech nad 6 číslic viditelné poslední 4, protiúčet se ukládá jen maskovaně. Plné číslo cílového účtu se neukládá, stačí `bank_account_id` a maskovaná podoba. VS, KS, jméno a zpráva pro příjemce zůstávají, jsou potřeba k ručnímu přiřazení, a mizí po 90 dnech. `Platba` nese vlastní datum, částku a poznámku, takže přežije čištění (BNK-017).
- **[R-20] Selhání schránky je provozní stav, ne chyba kódu.** Ukládá se jen kód `auth`, `blocked_host`, `timeout`, `tls`, `folder`, `decrypt`, `other`, nikdy text odpovědi serveru. Úloha neselhává a další pokus je další pětiminutovka. Po 3 selháních po sobě vznikne upozornění, první úspěch ho vyřeší. Sentry dostane jen pád parseru nebo služby, a to bez obsahu zprávy.
- **[R-21] Hlavní vypínač ani vypnutá automatika nezastaví čtení a párování,** řídí jen odesílání (SET-043). Deaktivovaný účet se nečte.
- **[R-22] Vrácení (BNK-014) je jedna funkce** `undoNotice`: smaže všechny platby avíza, přepočítá stav a avízo vrátí do fronty s důvodem `undone`, ze které se samo znovu nespáruje. Smazání platby zadrží případné potvrzení ve frontě **[R-24]**. Odeslané potvrzení vzít zpět nejde, UI na to před vrácením upozorní.
- **[R-23] Rozdělení musí sečíst celou částku avíza.** Zbytek by byly peníze bez evidence. Kdo chce zbytek ignorovat, přiřadí ho přeplatkem. Částky jsou v měně avíza. Přiřazení jde na `AWAITING_PAYMENT` a `paid`, přeplatek je povolený a ukázaný (PAY-004).
- **[R-24] Potvrzení platby automaticky jen u plateb z avíza,** automaticky spárovaných i přiřazených z fronty. Ruční platba a hromadné „označit jako uhrazené“ automaticky nic neposílají, nabídnou tlačítko „Poslat potvrzení“ přes dialog odeslání. Datum avíza starší 3 dnů potvrzení nezaloží, takže první běh s 30 dny historie nerozešle hromadu zpráv ani upozornění. Klíč `mail:receipt:<paymentId>`, `plannedFor` je datum platby, `automation: 'paymentReceipt'`. Klíč i záznam nesou id platby (`email_log.payment_id`). Dvě rychlé platby na jeden doklad jsou dvě potvrzení: nesmí narazit na `email_log_running_idx`, proto index dostane `payment_id` (`coalesce(payment_id, '')`), a druhá platba nesmí první potvrzení zadržet, protože sama zvýší `revision`. U `payment_receipt` proto `refusal` místo revize ověřuje, že platba záznamu pořád existuje.
- **[R-25] Proměnná `{{prijato}}`** existuje jen v šabloně `payment_receipt`, `{{zbyva}}` jde použít jako jinde. Výchozí texty ji uvádějí. Bez ní by potvrzení u dílčí platby neřeklo, co přišlo.
- **[R-26] Testovací IMAP server je vlastní pomůcka** `tests/helpers/imap.ts` nad `node:net`, jen příkazy, které `imapflow` skutečně pošle, zjištěné proti balíčku. Staré balíčky `hoodiecrow` a spol. nejsou udržované a TLS se testuje v `host-guard`. Pomůcka umí chybu přihlášení, zablokování, změnu `UIDVALIDITY` a výpis příkazů, takže test dokáže, že se nic nezapisuje.
- **[R-27] Upozornění.** Počty čekajících a nerozpoznaných jsou odvozené přes `registerDerivedAlerts` a samy zmizí po vyřízení. Událostmi v `notification` jsou výpadek napojení a potvrzení, které neodešlo. UI-011 má po tomto plánu test, „blížící se limity“ doplní plán 8, proto přechází do `tests/spec-partial.txt`.
- **[R-28] Průměrná doba úhrady (CUS-006)** počítá stav `paid` s `kind = 'payment'`: dny od `issue_date` do posledního `paid_on`, prostý průměr za všechny měny, bez dokladů s rozdílem. Bez dat je `null`.
- **[R-29] Staré úlohy `bank.poll` se mažou po 7 dnech.** Pětiminutový běh by za 90 dní dal desítky tisíc řádků. Idempotenci nedrží `job`, ale `dedupe_key` a slot v klíči, který se neopakuje.
- **[R-30] Vzorky.** Repo žádný skutečný vzorek avíza neobsahuje. Anglická fixtura je sestavená z popisků a formátů BNK-005, BNK-005 sám říká, že formát je ověřen jen z veřejných zmínek. Po prvním reálném avízu v angličtině je potřeba ji porovnat. Soubory jsou v `tests/fixtures/fio/`, české s předponou `cs-provisional-`.

---

### Task 1: Platby: model, stav a služba

**Files:**
- Create: `src/server/db/schema/payment.ts`, `drizzle/0027_payment.sql`, `src/lib/payments.ts`, `src/server/services/payments.ts`
- Modify: `src/server/db/schema/index.ts`, `src/server/services/users.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/services/invoice-versions.ts`, `src/server/services/invoices.ts`, `src/lib/qr-payload.ts` (jen je-li nutné pro CRN-005), `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `tests/helpers/consistency.ts`, `tests/fixtures/invoices.ts`, `stryker.config.json`
- Test: `tests/unit/payments.test.ts`, `tests/unit/payments.property.test.ts`, `tests/backend/payments.test.ts`, `tests/backend/consistency.test.ts`, `tests/backend/invoice-versions.test.ts`, `tests/backend/reminders.test.ts`, `tests/backend/invoices.test.ts`

**Interfaces:**
- Consumes: `amountDue`, `AWAITING_PAYMENT`, `mutate`, `findOwned`, `applyChange` (vnitřek `invoice-versions.ts`)
- Produces:
  - `PAYMENT_CHANNELS`, `PAYMENT_SOURCES = ['manual','notice','import']`, `PAYMENT_KINDS = ['payment','difference']`, `paymentInputSchema`
  - `deriveStatus(input: { status; sentAt: Date | null; totalMinor; paidMinor }): InvoiceStatus`, čistá
  - `canTakePayment(status): boolean`
  - `applyPayments(tx: Tx, userId: string, invoiceId: string): Invoice`, jediný zápis `paid_minor` **[R-1]**
  - `insertPayment(tx, audit, userId, invoiceId, input): { id: string }`, sdílené s Task 5 a 6
  - `listPayments(ownerId, invoiceId)`, `addPayment(actor, invoiceId, raw): { id }`, `updatePayment(actor, id, raw)`, `deletePayment(actor, id, revision)`
  - `markPaid(actor, invoiceId, opts: { revision; paidOn?: CalendarDate }): { id }`
  - `markPaidMany(actor, ids): { done; skipped }`
  - `closeDifference(actor, invoiceId, opts: { revision; confirmed: boolean }): { id; differenceMinor }`
  - `averagePaymentDays(ownerId, customerId): number | null`

`payment`: `id`, `user_id` (cascade), `invoice_id` (bez kaskády), `kind`, `paid_on`, `amount_minor`, `currency`, `credited_minor`, `method`, `note`, `source`, `created_at`, `updated_at`. Index `(user_id, invoice_id)`, `(user_id, paid_on)`. Do `USER_OWNED_TABLES` před `invoice`.

Spec: PAY-001 až 005, PAY-006 **[částečně]**, PAY-007, INV-023, INV-005, QR-005, QR-006, CRN-005 **[částečně]**, TST-018 **[částečně]**, AUD-001. Viz **[R-1]** až **[R-10]**.

Pravidla:
- Akce audit: `payment.create`, `payment.update`, `payment.delete`, `payment.mark_paid`, `payment.close_difference`. Audit nese ID, částku, měnu a stav před a po.
- `addPayment`, `updatePayment` a `markPaid` berou `revision` a při neshodě vrátí `TEXTS.invoices.stale`. Dvojklik tak nezaloží druhou platbu. Avízo mezitím otevřený formulář zastaralým udělá záměrně.
- `markPaid` vezme celé `amountDue`, při nule odmítne. Datum výchozí dnes, budoucí datum odmítá i `addPayment`.
- `markPaidMany` má limit `MAX_BULK_DOCUMENTS`, každý doklad vlastní `mutate`, přeskočí stavy mimo `canTakePayment` a nulové zbývá, po vzoru `markSentMany`.
- `applyChange` po změně dopočítá `status` přes `deriveStatus` z uloženého `paid_minor`, takže upravení i obnovení verze vrátí stav podle INV-023. Řádek `balanceWarningOf` dostane i stav před změnou: `underpaid` je přechod z `paid` na `partially_paid`, `overpaid` zůstává. `resendSuggested` platí pro doklad s `sent_at`, ne jen pro stav `sent`.
- Stráž **[R-9]** je v `applyChange` se zprávou `V.currencyHasPayments`.
- Stráž **[R-4]** v `cancelInvoice`: `V.hasPayments`. Oprav `applySent` a `markSent` podle **[R-3]**.
- `amountDue` zůstává jediný výpočet a `deriveStatus` ho používá. CRN-005 s opravnými fakturami přidá plán 6, ID zůstává v pending a testy ho v názvu nenesou.
- `invoices.ts`: `customerInvoiceStats` vrací `averageDays` **[R-28]**.
- `assertConsistent` přidá: `paid_minor` je součet plateb, stav odpovídá `deriveStatus`, platba má měnu a vlastníka dokladu, koncept ani storno nemají platbu. Testy, které dnes přepisují `paid_minor` přímo a volají `assertConsistent`, přejdou na pomůcku `seedPayment` v `tests/fixtures/invoices.ts`. Ostatní přímé zápisy mohou zůstat.
- Stryker mutuje `src/lib/payments.ts`.

- [ ] **Step 1: Napiš testy**

```ts
test('[PAY-002] dvě dílčí platby dají partially_paid a pak paid', ...)
test('[PAY-001] jedno kliknutí uhradí zbytek s dnešním datem a datum jde změnit', ...)
test('[PAY-003] platba nese datum, částku, měnu, způsob, poznámku a zdroj', ...)
test('[PAY-004] přeplatek nechá paid a ukáže se jako přeplatek', ...)
test('[PAY-005] úprava a smazání přepočítají stav, po poslední platbě je zpět sent', ...)
test('[PAY-006] jiná měna vyžaduje ručně připsanou částku', ...) // spec-partial
test('[PAY-007] uzavření uloží rozdíl, nic nezaokrouhlí a smazání ho vrátí', ...)
test('[INV-023] úprava uhrazené na vyšší částku dá partially_paid s upozorněním', ...)
test('[INV-023] úprava na nižší částku nechá paid s přeplatkem', ...)
test('[INV-023] obnovení verze přepočítá stav', ...)
test('[INV-005] platba zachová sent_at a smazání vrátí sent', ...)
test('[INV-005] odeslání po platbě doplní sent_at a stav zůstane', ...)
test('[REM-006] částečná platba nechá upomínku způsobilou se zapnutým přepínačem', ...) // skutečná platba, ne ruční stav
test('[QR-005] skutečně uhrazená faktura QR nemá, po smazání platby ano', ...)
test('[QR-006] částka v QR je zbytek po skutečné platbě', ...)
test('každý zápis platby zvýší revision o 1', ...)
test('upomínka ve frontě se po platbě zadrží a SMTP nic nedostane', ...)
test('změna měny dokladu s platbou je odmítnutá i při obnovení verze', ...)
test('storno dokladu s platbou je odmítnuté', ...)
test('platba na koncept, storno a dobropis je odmítnutá', ...)
test('[TST-012] pro libovolnou posloupnost plateb je stav funkcí součtu', ...) // fast-check, spec-partial zůstává kvůli měnám
test('[TST-018] nesoulad paid_minor a plateb kontrola odhalí', ...)
test('[TST-009] izolace plateb včetně update a remove', ...)
test('[AUD-001] každá změna platby je v auditu', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/payments tests/backend/payments.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci `--name payment`, čisté funkce, službu a úpravy `invoice-lifecycle.ts` a `invoice-versions.ts`.
- [ ] **Step 4: Ověř:** stejné testy, pak `timeout 170 pnpm exec vitest run tests/backend/invoice-versions.test.ts tests/backend/invoices.test.ts tests/backend/reminders.test.ts tests/backend/consistency.test.ts tests/backend/qr.test.ts tests/backend/users.test.ts`, PASS.
- [ ] **Step 5: Commit** `feat(payments): add payments and derived invoice status`

---

### Task 2: Platby v rozhraní

**Files:**
- Create: `src/components/invoices/payment-panel.tsx`, `src/components/invoices/payment-dialog.tsx`, `tests/e2e/payments.spec.ts`
- Modify: `src/app/(app)/faktury/actions.ts`, `src/app/(app)/faktury/[id]/page.tsx`, `src/components/invoices/invoice-actions.tsx`, `src/components/invoices/invoice-table.tsx`, `src/components/invoices/invoice-form.tsx`, `src/components/customers/customer-invoices.tsx`, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/backend/invoice-actions.test.ts`
- Test: `tests/e2e/payments.spec.ts`, `tests/backend/invoice-actions.test.ts`

**Interfaces:**
- Consumes: služby z Task 1
- Produces: actions `addPaymentAction`, `updatePaymentAction`, `deletePaymentAction`, `markPaidAction`, `markPaidManyAction`, `closeDifferenceAction`

Spec: PAY-001 až 007, INV-023, INV-024 **[částečně]**, CUS-006, QR-005, UI-009, SEC-002.

Pravidla:
- Detail: tlačítko „Označit jako uhrazené“ s dnešním datem a volbou data, jinak sekce plateb s přehledem, přidáním, úpravou a smazáním. Sekce je nad historií odeslání.
- Přeplatek je zvýrazněný tokenem varování a uvádí částku. Stávající `StatusSteps` zůstává, doplní se jen uzavřený rozdíl.
- „Uzavřít jako uhrazené“ je jen u `partially_paid`, dialog ukáže rozdíl a vyžaduje potvrzení.
- Formulář úpravy dokladu ukáže varování `balanceWarning` po uložení a stav po přepočtu. Výběr měny je u dokladu s platbou vypnutý s vysvětlením, stráž na serveru zůstává.
- Tlačítko storna se u dokladu s platbou nenabízí a vysvětlení uvede proč.
- Hromadně: „Označit jako uhrazené“ v panelu výběru, potvrzení ukáže počet a součet podle měn, výsledek počet hotových a přeskočených. Nic neodesílá. INV-024 čeká na export v plánu 8, ID zůstává v `tests/spec-partial.txt`, nové testy ho nesou v názvu.
- Karta zákazníka ukáže průměrnou dobu úhrady nebo pomlčku.

- [ ] **Step 1: Napiš testy**

```ts
test('[PAY-001] označení jako uhrazené změní stav, QR zmizí a nic neodejde', ...) // e2e, smtp.messages prázdné
test('[PAY-002] dílčí platba ukáže zbývající částku', ...) // e2e
test('[PAY-004] přeplatek je zvýrazněný', ...) // e2e
test('[PAY-005] smazání platby vrátí stav', ...) // e2e
test('[PAY-007] uzavření rozdílu vyžaduje potvrzení', ...) // e2e
test('[INV-023] úprava uhrazené faktury ukáže upozornění', ...) // e2e
test('[CUS-006] karta zákazníka ukáže uhrazeno, pohledávky a průměrnou dobu úhrady', ...)
test('hromadné označení přeskočí koncept a storno a nic neodešle', ...) // INV-024 částečně
test('[SEC-002] akce plateb odmítnou cizí ID', ...)
test('[SEC-006] akce plateb odmítnou nulovou částku a budoucí datum', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/invoice-actions.test.ts tests/backend/actions-isolation.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** akce a komponenty.
- [ ] **Step 4: Ověř:** stejné testy PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test payments`, `timeout 170 pnpm exec playwright test invoices`, `timeout 170 pnpm exec playwright test customers`, PASS.
- [ ] **Step 5: Commit** `feat(payments): add payment ui and bulk mark as paid`

---

### Task 3: Parser avíz Fio

**Files:**
- Create: `src/lib/bank-notices/index.ts`, `src/lib/bank-notices/types.ts`, `src/lib/bank-notices/fio.ts`, `src/lib/bank-notices/auth.ts`, `src/lib/bank-notices/mask.ts`, `tests/fixtures/fio/en-income.txt`, `tests/fixtures/fio/en-income-minimal.txt`, `tests/fixtures/fio/cs-provisional-block.txt`, `tests/fixtures/fio/cs-provisional-sentence.txt`, `tests/fixtures/fio/en-expense.txt`, `tests/fixtures/fio/en-changed-format.txt`
- Modify: `stryker.config.json`
- Test: `tests/unit/fio-parser.test.ts`, `tests/unit/fio-parser.property.test.ts`, `tests/unit/notice-auth.test.ts`, `tests/unit/notice-mask.test.ts`

**Interfaces:**
- Produces:
  - `type NoticeMeta = { from: string[]; subject: string }`
  - `type NoticeVariant = 'en' | 'cs_block' | 'cs_sentence'`
  - `type ParsedNotice = { variant; targetAccount: string; amountMinor: number; currency; occurredAt: { date: CalendarDate; time: string | null }; variableSymbol: string | null; constantSymbol: string | null; counterpartyAccount: string | null; counterpartyName: string | null; message: string | null; instructionId: string }`
  - `type BankNoticeParser = { bank: string; classify(meta: NoticeMeta): 'income' | 'expense' | 'unknown' | null; parse(text: string, meta: NoticeMeta): ParsedNotice | null }`
  - `BANK_PARSERS: readonly BankNoticeParser[]`, `parserFor(meta): { parser; kind } | null`
  - `AUTO_MATCH_VARIANTS`, `isProvisional(variant): boolean`
  - `checkAuthResults(topHeader: string | null, domain: string): 'pass' | 'fail' | 'none'`
  - `maskDigits(text: string): string`, `maskAccount(value: string): string`

Spec: BNK-004, BNK-005 **[částečně]**, BNK-012, BNK-013, BNK-016, BNK-017, TST-006 **[částečně]**, TST-013. Viz **[R-13]** až **[R-16]**, **[R-19]**, **[R-30]**.

Pravidla:
- Vše je čisté, bez `server-only`, žádný regex nesmí mít katastrofální backtracking na vstupu z e-mailu. Jde o nedůvěryhodný text, parser má limit délky vstupu 64 KiB a běží po řádcích.
- Mezery tisíců včetně NBSP jdou v obou variantách odstranit. Česká čárka a anglická tečka se nikdy nemísí. Datum česky `d.M.yyyy`, anglicky `m/d/yyyy`. Neplatné datum je `null`.
- Měna musí být v `CURRENCIES`. Jiná je `null`, avízo je tedy nerozpoznané.
- Účet se vrací ve tvaru `číslo/kód` nebo jen číslo, porovnání řeší Task 5. Parser neví nic o uživateli ani fakturách.
- Přidání banky znamená nový modul v `BANK_PARSERS`. Test ověří, že druhý falešný parser funguje bez změny jiného souboru (BNK-016).
- Fixtury mají smyšlené údaje. České soubory mají první řádek `# PROZATÍMNÍ: nesestaveno z reálného vzorku`, který test odstraní.
- Testy české varianty nesou v komentáři proč zůstává BNK-005 částečný. Záznamy do `tests/spec-partial.txt` přidá tento úkol a odstraní `BNK-005` a `TST-006` z pending, v Task 8 je zkontroluje.
- Stryker mutuje `fio.ts` a `auth.ts`.

- [ ] **Step 1: Napiš testy**

```ts
test('[BNK-005] anglická varianta dá všechna pole včetně data m/d/rrrr', ...)
test('[BNK-005] prozatímní česká bloková varianta s desetinnou čárkou', ...) // spec-partial
test('[BNK-005] prozatímní česká větná varianta', ...) // spec-partial
test('[TST-006] všechny fixtury v obou jazycích', ...) // spec-partial
test('[BNK-004] jen přesný odesílatel a tři předměty jdou do parseru', ...)
test('[BNK-004] výdajové avízo se ignoruje', ...)
test('[BNK-012] změněný formát dá null, nikdy částečná data', ...)
test('[BNK-012] neznámý předmět od Fio je unknown', ...)
test('[BNK-013] pass jen pro doménu fio.cz, cizí DKIM je fail', ...)
test('[BNK-013] lze číst jen nejvyšší hlavičku, podvržená nižší se neuplatní', ...)
test('[BNK-016] nový parser se přidá bez změny ostatních', ...)
test('[BNK-017] maskování nechá poslední 4 číslice', ...)
test('1,234 v anglické variantě ani 1.234,50 v české není částka', ...)
test('[TST-012] náhodný text nikdy nevyhodí výjimku a kladná částka se vrátí beze ztráty', ...) // fast-check
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/fio-parser tests/unit/notice-auth.test.ts tests/unit/notice-mask.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** moduly a fixtury. Popisky mimo spec jsou v tabulce jako předpoklad **[R-14]**.
- [ ] **Step 4: Ověř:** PASS, `timeout 170 pnpm run test:coverage-spec`, pak mutace přes dočasnou konfiguraci s `vitest.configFile` jen na tyto testy, aspoň 90 %. Když se běh do limitu nevejde, spouštěj po rozsazích řádků.
- [ ] **Step 5: Commit** `feat(bank): add fio notice parser`

---

### Task 4: Nastavení schránky a ochrana IMAP

**Files:**
- Create: `src/server/db/schema/bank.ts`, `drizzle/0028_bank_mailbox.sql`, `src/lib/bank-mailbox.ts`, `src/server/bank/imap.ts`, `src/server/services/bank-mailbox.ts`, `src/app/(app)/nastaveni/aviza/page.tsx`, `src/app/(app)/nastaveni/aviza/actions.ts`, `src/components/settings/bank-mailbox-form.tsx`, `src/components/settings/bank-guide.tsx`, `tests/helpers/imap.ts`, `tests/e2e/bank-settings.spec.ts`
- Modify: `src/server/mail/host-guard.ts`, `src/server/db/schema/index.ts`, `src/server/services/users.ts`, `src/server/rate-limit.ts`, `src/components/settings-tabs.tsx`, `next.config.ts`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `tests/backend/actions-isolation.test.ts`, `.env.example`, `package.json`, `pnpm-lock.yaml`
- Test: `tests/backend/bank-mailbox.test.ts`, `tests/unit/host-guard.test.ts`, `tests/e2e/bank-settings.spec.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret`, `assertPublicHost`, `enforceRateLimit`
- Produces:
  - `IMAP_PORTS = [143, 993]`, `assertPublicHost(host, port, { allowPrivate; ports? })` **[R-12]**
  - `bankMailboxSchema`, `getBankMailbox(ownerId)`, bez hesla, jen `hasCredentials`
  - `saveBankMailbox(actor, raw): Promise<void>`, `clearBankMailbox(actor)`, `testBankMailbox(actor): Promise<void>`
  - `openMailbox(settings, env): Promise<MailboxSession>`, `MailboxSession = { uidValidity: number; listSince(cursor, opts): Promise<MessageRef[]>; envelope(uid); download(uid, maxBytes): Promise<Buffer | null>; close(): Promise<void> }`
  - `classifyImapError(error: unknown): BankFailureCode`
  - `startImap(opts): Promise<TestImap>`, `TestImap = { port; messages; addMessage(raw); setUidValidity(n); failNext(kind); commands: string[]; close() }`
  - `RATE_RULES.bankTestUser = rule('bankTestUser', 10, 3600)`, `RATE_RULES.bankCheckUser = rule('bankCheckUser', 10, 60)`

`bank_mailbox`: `user_id` (PK, cascade), `host`, `port`, `tls` (`implicit`,`starttls`), `username`, `password_enc`, `folder` (výchozí `INBOX`), `enabled`, `require_confirmation` (výchozí zapnuto **[R-16]**), `uid_validity`, `last_uid`, `first_read_at`, `last_check_at`, `last_success_at`, `last_notice_at`, `failure_code`, `failures`, `verified_at`, `updated_at`.

Spec: BNK-001, BNK-002, BNK-015 **[částečně]**, SEC-003, SEC-007, SET-053, AUD-004, EXP-009 (tajemství zůstává jen v tomto sloupci). Viz **[R-11]**, **[R-12]**, **[R-20]**.

Pravidla:
- Před implementací ověř v `node_modules/imapflow` skutečné názvy voleb a chování read-only a STARTTLS. Volby nesmí vycházet z paměti, stejně jako v plánu 4 u `nodemailer`.
- `pnpm add imapflow` a `pnpm add mailparser` (přesun z dev). `logger: false`, aby se heslo nedostalo do logu. Oba balíčky přidej do `serverExternalPackages`, když bundlování instrumentation selže. Docker test v Task 8 to potvrdí.
- `assertPublicHost` proběhne při uložení i před každým spojením. `imapflow` dostane ověřenou IP a `servername` původního hostitele. `rejectUnauthorized` se nikdy nevypíná. U portů mimo `ports` je `BlockedHostError`, výchozí chování SMTP se nemění a stávající testy zůstanou zelené.
- Heslo je jen pro zápis a pravidla přebírá `saveMailSettings`: prázdné pole zachová, změna hostitele, portu nebo uživatele bez nového hesla je odmítnutá, aby ukradená relace nepřesměrovala uložené heslo. Audit nese `hasCredentials`, hostitele a port. Příznak změny hesla se nesmí jmenovat s `pass`, audit by ho zamaskoval.
- `testBankMailbox` testuje uložené nastavení, ověří přihlášení a existenci složky, nic nečte. Jedna obecná hláška a zvláštní jen pro zablokovaného hostitele, aby stránka nesloužila jako skener. Klientovi se nikdy nevrací text serveru.
- Návod BNK-002 je statický text podle spec. Stránka doporučí samostatnou schránku a u přepínače `require_confirmation` vysvětlí důsledek. Prozatímní česká varianta je tu popsaná **[R-15]**.
- `TestImap` ověř proti skutečnému `imapflow`. Když mu bude chybět příkaz, rozšiř pomůcku, nezjednodušuj klienta.
- Do stavu napojení patří jen zobrazení polí z tabulky, plnit je začne Task 5. BNK-015 zůstává v pending.

- [ ] **Step 1: Napiš testy**

```ts
test('[SEC-007] privátní adresa, IPv4 v IPv6 a metadata jsou pro IMAP odmítnuté', ...)
test('[SEC-007] port 22 je pro IMAP odmítnutý, 993 projde a SMTP dál neumí 993', ...)
test('[SEC-007] změna DNS po uložení odmítne spojení a jde se na ověřenou IP', ...)
test('[SEC-007] ALLOW_PRIVATE_MAIL_HOSTS povolí privátní cíl a jen pro něj nevyžaduje TLS', ...)
test('[SEC-003] heslo IMAP je v databázi šifrované a neopouští službu', ...)
test('[AUD-004] heslo IMAP se nedostane do auditu', ...)
test('[BNK-001] uložení a test připojení proti testovacímu serveru', ...)
test('[BNK-001] změna hostitele bez nového hesla je odmítnutá', ...)
test('[BNK-001] chyba přihlášení i sonda portu mají jednu obecnou hlášku', ...)
test('[BNK-002] stránka ukáže kroky nastavení ve Fio', ...) // e2e
test('[SEC-001] test schránky je omezený a překročení je v auditu', ...)
test('[TST-009] izolace schránky včetně update a remove', ...)
test('[SEC-002] akce schránky odmítnou cizí účet', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/bank-mailbox.test.ts tests/unit/host-guard.test.ts`, FAIL.
- [ ] **Step 3: Přidej závislosti.** Respektuj `minimumReleaseAge`.
- [ ] **Step 4: Implementuj** schéma, migraci `--name bank_mailbox`, ochranu, klienta, testovací server a stránku. Heslo šifruj přes `encryptSecret`.
- [ ] **Step 5: Ověř:** stejné testy a `tests/backend/mail-settings.test.ts tests/backend/users.test.ts tests/backend/actions-isolation.test.ts` PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test bank-settings`, `timeout 170 pnpm exec playwright test mail-settings`.
- [ ] **Step 6: Commit** `feat(bank): add imap mailbox settings with ssrf protection`

---

### Task 5: Čtení schránky a párování

**Files:**
- Create: `drizzle/0029_bank_notification.sql`, `src/lib/payment-matching.ts`, `src/server/services/bank-notices.ts`, `src/server/services/bank-poll.ts`
- Modify: `src/server/db/schema/bank.ts`, `src/server/db/schema/payment.ts`, `src/server/db/schema/job.ts`, `src/server/db/schema/invoice.ts`, `src/server/jobs/queue.ts`, `src/server/scheduler/start.ts`, `src/server/services/payments.ts`, `src/server/services/users.ts`, `src/lib/automation.ts`, `src/lib/notification-text.ts`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `stryker.config.json`, `tests/helpers/consistency.ts`
- Test: `tests/unit/payment-matching.test.ts`, `tests/backend/bank-poll.test.ts`, `tests/backend/bank-notices.test.ts`

**Interfaces:**
- Consumes: `openMailbox`, `parserFor`, `checkAuthResults`, `maskDigits`, `insertPayment`, `applyPayments`, `amountDue`, `notify`, `resolveNotification`, `enqueue`, `registerJob`, `registerTickTask`, `simpleParser`, `normalizeIban`, `czechAccountToIban`
- Produces:
  - `normalizeSymbol(value): string | null`
  - `matchNotice(notice, candidates, opts: { autoAllowed: boolean; targetAccountId: string }): { result: 'match'; invoiceId: string } | { result: 'queue'; reason: QueueReason; invoiceIds: string[] }`, čistá
  - `planBankPolls(now: Date): void` (tick), `pollMailbox(job: Job): Promise<void>` (úloha `bank.poll`)
  - `checkMailboxNow(actor, requestId): void`
  - `ingestNotice(actorUserId, input: IngestInput): IngestResult`, jedna transakce
  - `purgeNotices(now: Date): void` (denní tick)
  - `bankStatus(ownerId)`

`bank_notification`: `id`, `user_id` (cascade), `dedupe_key`, `bank`, `variant`, `status` (`matched`,`pending`,`ignored`,`unrecognized`,`dismissed`), `reason`, `auth_result`, `bank_account_id` (set null), `account_masked`, `amount_minor`, `currency`, `paid_on`, `paid_time`, `variable_symbol`, `constant_symbol`, `counterparty_masked`, `counterparty_name`, `message`, `instruction_id`, `text_masked`, `received_at`, `purged_at`, `created_at`, `updated_at`. Unikátní `(user_id, dedupe_key)`, index `(user_id, status, received_at)`. `payment` nově `notification_id` (set null). Sloupec přidej ručně `ALTER TABLE … ADD COLUMN … REFERENCES`, SQLite to s `NULL` povolí. `invoice` nově index `(user_id, variable_symbol)`. `bank_notification` jde do `USER_OWNED_TABLES` za `payment` a před `invoice`. `JOB_KINDS` získá `bank.poll`, sloupec nemá `CHECK`.

Spec: BNK-003, BNK-004, BNK-006, BNK-007, BNK-008, BNK-012, BNK-013, BNK-015, BNK-017, TST-006 **[částečně]**, TST-013. Viz **[R-11]**, **[R-13]** až **[R-21]**, **[R-29]**.

Průběh úlohy, každý krok je oddělený:

1. **Start:** účet není deaktivovaný, schránka `enabled`, heslo jde dešifrovat. Jinak zapiš kód a konec.
2. **Spojení:** `openMailbox`. Tvrdý strop 60 s pokrývá celý běh, po vypršení se spojení zavře a hotové zprávy zůstávají uložené.
3. **Kurzor:** nový `uid_validity` kurzor nuluje a čtení jde od dat `first_read_at`, duplicitu pohlídá `dedupe_key`.
4. **Třídění:** obálka každé zprávy a `parserFor`. `null` a výdaj jen posunou kurzor.
5. **Stažení:** tělo nejvýš 256 KiB, větší je `unrecognized` bez textu. `simpleParser` dostane limit, přílohy se zahodí. Ze surových hlaviček se vezme nejvyšší `Authentication-Results`.
6. **`ingestNotice`:** jedna transakce přes `mutate` s aktérem plánovače. Vloží `bank_notification` s `onConflictDoNothing` a když nic nevložil, skončí beze změny. Zjistí cílový účet, zamítne cizí jako `ignored` s důvodem `foreign_account`. Spočítá `matchNotice`, u shody `insertPayment` se `source: 'notice'` a `applyPayments`, jinak `pending`.
7. **Kurzor a stav:** `last_uid` po každé uložené zprávě, po běhu `last_check_at`, `last_success_at`, `last_notice_at`, vynulování `failures` a `resolveNotification`.

Pravidla:
- Cílový účet: převod obou stran na IBAN přes `czechAccountToIban`, `normalizeIban` a porovnání se všemi účty uživatele včetně skrytých, starý účet může stále přijímat. Zápis bez kódu banky znamená `2010`.
- `autoAllowed` je `isProvisional(variant) === false`, `auth_result === 'pass'`, nebo `none` s vypnutým `require_confirmation`. `fail` dává `auth_failed`.
- Tick zakládá úlohu s klíčem `bank:<userId>:<pětiminutový slot>`, jen pro nedeaktivované účty a povolené schránky. Výpadek přes několik slotů dá jeden běh. Ruční kontrola používá `bank:<userId>:now:<requestId>`, rate limit `bankCheckUser` a `kickWorker`.
- Selhání zpracování jedné zprávy kódem se ohlásí přes `reportFailure` bez obsahu a zpráva se uloží jako `unrecognized`, aby nezablokovala kurzor navždy. Selhání zápisu do databáze dávku zastaví bez posunu kurzoru.
- `purgeFinishedJobs` maže `bank.poll` po 7 dnech **[R-29]**. `purgeNotices` běží v noční údržbě **[R-18]**.
- Audit `notice.matched`, `notice.queued`, `notice.ignored`, `notice.unrecognized` nese jen ID, částku, měnu a důvod.
- `NOTIFICATION_KINDS` získá `bank_connection_failed` a texty v `notification-text.ts`.
- `assertConsistent` přidá: `matched` má aspoň jednu platbu, platby avíza sečtené sedí na částku, `dedupe_key` není dvakrát, `pending` nemá platbu.
- Stryker mutuje `payment-matching.ts`.

- [ ] **Step 1: Napiš testy**

```ts
test('[BNK-008] shoda VS, částky a měny na otevřené faktuře uhradí s datem z avíza', ...)
test('[BNK-008] dílčí zbytek se páruje proti amountDue', ...)
test('stejný VS faktury a zálohy rozhodne částka, při shodě jde do fronty', ...)
test('úvodní nuly ve VS se srovnají', ...)
test.each(QUEUE_REASONS)('[BNK-010] důvod %s jde do fronty bez platby', ...)
test('[BNK-006] znovu přečtená zpráva nic nezmění', ...)
test('[BNK-006] reset UIDVALIDITY nezaloží druhou platbu', ...)
test('[BNK-006] po 90 dnech a čištění se stejné avízo nezapočte znovu', ...)
test('[BNK-007] cizí cílový účet se ignoruje a zaznamená', ...)
test('[BNK-007] skrytý účet je účet uživatele', ...)
test('[BNK-003] plán založí běh každých 5 minut a výpadek dá jeden běh', ...)
test('[BNK-003] Zkontrolovat teď založí běh hned', ...)
test('[BNK-004] výdaj ani cizí odesílatel se nestáhnou', ...) // TestImap.commands
test('[BNK-012] nerozpoznané avízo zůstane a založí upozornění', ...)
test('[BNK-013] fail jde do fronty, none se řídí nastavením', ...)
test('[BNK-015] stav ukáže kontrolu a avízo, 3 selhání založí upozornění, úspěch ho vyřeší', ...)
test('[BNK-017] uložené údaje jsou maskované, po 90 dnech zmizí a platba zůstane', ...)
test('[BNK-017] nevyřízené avízo se nečistí', ...)
test('prozatímní česká varianta jde do fronty a neuhradí nic', ...)
test('[TST-006] tok přes testovací IMAP server od zprávy po uhrazenou fakturu', ...)
test('testovací server neviděl žádný zapisovací příkaz', ...) // STORE, EXPUNGE, MOVE, COPY, DELETE
test('hlavní vypínač čtení nezastaví a deaktivovaný účet se nečte', ...)
test('běh dodrží strop času na zablokovaném serveru', ...)
test('audit, log ani Sentry neobsahují protiúčet ani text zprávy', ...)
test('[TST-009] izolace avíz včetně update a remove', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/payment-matching.test.ts tests/backend/bank-poll.test.ts tests/backend/bank-notices.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci `--name bank_notification`, párování, úlohu a tick. `registerJob('bank.poll', { run: pollMailbox })` a tick úlohy v `start.ts`.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/scheduler.test.ts tests/backend/jobs.test.ts tests/backend/users.test.ts tests/backend/consistency.test.ts` PASS, mutace `payment-matching.ts` aspoň 90 %.
- [ ] **Step 5: Commit** `feat(bank): read fio notices and match payments`

---

### Task 6: Fronta nespárovaných plateb

**Files:**
- Create: `src/app/(app)/platby/actions.ts`, `src/components/payments/notice-queue.tsx`, `src/components/payments/notice-assign-dialog.tsx`, `src/components/payments/notice-split-dialog.tsx`, `src/components/payments/notice-list.tsx`, `src/components/payments/bank-status.tsx`, `src/server/services/payment-alerts.ts`, `tests/e2e/bank-queue.spec.ts`
- Modify: `src/app/(app)/platby/page.tsx`, `src/app/(app)/upozorneni/page.tsx`, `src/components/nav.ts`, `src/server/services/bank-notices.ts`, `src/server/services/payments.ts`, `src/lib/automation.ts`, `src/lib/notification-text.ts`, `src/components/invoices/payment-panel.tsx`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `tests/backend/actions-isolation.test.ts`, `tests/e2e/shell.spec.ts`
- Test: `tests/backend/bank-notices.test.ts`, `tests/backend/notifications.test.ts`, `tests/e2e/bank-queue.spec.ts`

**Interfaces:**
- Consumes: `insertPayment`, `applyPayments`, `registerDerivedAlerts`, `bankStatus`, `isProvisional`
- Produces:
  - `listNotices(ownerId, filter)`, `noticeCandidates(ownerId, noticeId)`
  - `assignNotice(actor, id, raw: { invoiceId; creditedMinor? }): void`
  - `splitNotice(actor, id, raw: { parts: { invoiceId; amountMinor; creditedMinor? }[] }): void`
  - `dismissNotice(actor, id)`, `restoreNotice(actor, id)`
  - `undoNotice(actor, id)`
  - actions `assignNoticeAction`, `splitNoticeAction`, `dismissNoticeAction`, `restoreNoticeAction`, `undoNoticeAction`, `checkMailboxNowAction`

Spec: BNK-010, BNK-011, BNK-012, BNK-014, BNK-015, UI-009, UI-011 **[částečně]**, PAY-004, SEC-002, AUD-001. Viz **[R-10]**, **[R-15]**, **[R-22]**, **[R-23]**, **[R-27]**.

Pravidla:
- `/platby` přestává být `planned`. Stránka má stav napojení s tlačítkem „Zkontrolovat teď“, frontu, nerozpoznaná avíza a historii. Bez nastavené schránky je prázdný stav s odkazem do nastavení, ruční platby fungují dál.
- Fronta ukazuje důvod lidsky, datum, částku, VS, protistranu, zprávu a nabízené doklady. Prozatímní varianta má viditelný štítek v řádku i v dialogu **[R-15]**.
- Přiřazení znamená `insertPayment` se `source: 'notice'`, datum z avíza. Měna avíza jiná než dokladu vyžaduje `creditedMinor` **[R-7]**. Stav avíza je `matched`. Řádek `ignored` a `unrecognized` přiřadit nejde, nerozpoznané má jen zahození.
- Dílčí platba z fronty (BNK-011) je totéž přiřazení na doklad s vyšším zbývá, stav se odvodí sám.
- `deletePayment` nad platbou s `notification_id` volá `undoNotice` **[R-10]**. `updatePayment` odmítne změnu částek. Panel plateb ukáže u takové platby odkaz na avízo a vrácení.
- Vrácení a přiřazení jsou odolné proti dvojkliku přes stav avíza: `matched` už přiřadit nejde a `pending` už vrátit nejde, v obou případech `ServiceError`.
- `payment-alerts.ts` registruje zdroj s kindy `payments_unmatched` a `notices_unrecognized`, import je v grafu `/upozorneni` a ověří ho e2e test.
- Plán 7 dostane `listNotices` pro systémový widget, tvar řádku proto neobsahuje UI.

- [ ] **Step 1: Napiš testy**

```ts
test('[BNK-010] přiřazení z fronty zapíše platbu s datem avíza', ...)
test('[BNK-010] rozdělení na dvě faktury musí dát celou částku', ...)
test('[BNK-010] zahození jde vrátit a nevznikne platba', ...)
test('[BNK-011] přijetí částečné platby z fronty dá partially_paid', ...)
test('[BNK-014] vrácení jedním kliknutím smaže platbu, vrátí stav a avízo jde do fronty', ...)
test('[BNK-014] vrácené avízo se samo znovu nespáruje', ...)
test('smazání platby z avíza vrátí celé avízo', ...)
test('částky platby z avíza nejde upravit', ...)
test('[UI-011] nespárované a nerozpoznané jsou v centru i na zvonku a po vyřízení zmizí', ...) // e2e
test('[BNK-015] stránka ukáže stav napojení a Zkontrolovat teď', ...) // e2e
test('prozatímní avízo má štítek v seznamu i dialogu', ...) // e2e
test('[SEC-002] akce avíz odmítnou cizí ID', ...)
test('[AUD-001] přiřazení, rozdělení, zahození a vrácení jsou v auditu', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/bank-notices.test.ts tests/backend/notifications.test.ts tests/backend/actions-isolation.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** služby, akce a stránku.
- [ ] **Step 4: Ověř:** stejné testy PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test bank-queue`, `timeout 170 pnpm exec playwright test shell`.
- [ ] **Step 5: Commit** `feat(bank): add unmatched payments queue and undo`

---

### Task 7: Potvrzení platby

**Files:**
- Create: `src/server/services/payment-receipt.ts`
- Modify: `src/lib/automation.ts`, `src/lib/template-vars.ts`, `src/lib/email-template.ts`, `src/server/mail/defaults.ts`, `src/server/services/email-templates.ts`, `src/server/services/invoice-mail.ts`, `src/server/services/mail-delivery.ts`, `src/server/services/bank-notices.ts`, `src/server/services/automation.ts`, `src/app/(app)/nastaveni/automatizace/page.tsx`, `src/components/settings/automation-panel.tsx`, `src/components/invoices/send-dialog.tsx`, `src/components/invoices/payment-panel.tsx`, `src/lib/notification-text.ts`, `src/lib/texts.ts`, `tests/backend/silence.test.ts`
- Test: `tests/backend/payment-receipt.test.ts`, `tests/backend/email-templates.test.ts`, `tests/backend/automation.test.ts`, `tests/backend/silence.test.ts`, `tests/e2e/payments.spec.ts`

**Interfaces:**
- Consumes: `queueMail`, `composeMail`, `automaticSendAllowed`, `notify`, `mailRecipients`, `sendInvoice`
- Produces:
  - `queueAutomaticReceipt(tx: Tx, audit: Audit, input: { userId; invoiceId; paymentId; paidOn; today }): void`
  - `composeMail(..., opts?: { payment?: { creditedMinor; paidOn } })`
  - `sendPrefill(ownerId, invoiceId, logId?, kind?)`, `kind: 'payment_receipt'`

Spec: BNK-009, SET-040, SET-041, SET-042, SET-043, MAIL-003, TST-016 **[částečně]**, AUD-001. Viz **[R-21]**, **[R-24]**, **[R-25]**.

Pravidla:
- `AUTOMATIONS`: `paymentReceipt` má `available: true`, `advanceInvoice` zůstává vypnutá do plánu 6. Dialog zapnutí řekne, co a komu odejde, a že zpráva jde jen u plateb z avíz. `automationImpact` uvede počet zákazníků s adresou.
- `queueAutomaticReceipt` běží ve stejné transakci jako `insertPayment`, až po `applyPayments`, takže `email_log.invoice_revision` nese novou revizi. Volá ji automatické spárování i přiřazení z fronty, u rozdělení jednou za doklad.
- Pořadí kontrol: `automaticSendAllowed`, datum nejvýš 3 dny staré, adresa zákazníka. Vypnutá automatika a staré datum tiše skončí. Chybějící adresa dá upozornění `receipt_no_address`.
- `queueMail` s výsledkem `null` je jen opakování téže platby (stejný klíč), nic se nepošle ani nehlásí. Běžící potvrzení jiné platby téhož dokladu výsledek `null` nedá **[R-24]**.
- `deliverMail` ověřuje svolení před SMTP beze změny. Revizi ověřuje u všech druhů kromě `payment_receipt`, tam `refusal` kontroluje existenci platby a že `paid_minor` je nad nulou **[R-24]**. Vrácení avíza dá `held`, další platba první potvrzení nezadrží, úprava dokladu ano jen u jiných druhů zpráv.
- `payment_receipt` nesmí spustit `applySent`, drží to stávající podmínka, nově to pokrývá test.
- Ruční tlačítko „Poslat potvrzení“ je v panelu plateb a otevírá `send-dialog.tsx` s druhem `payment_receipt` přes `sendPrefill`. Hlavní vypínač ho neblokuje, je to kliknutí.
- `{{prijato}}` validuje jen šablona `payment_receipt`, v jiném druhu je neznámá proměnná. Změna výchozích textů se netýká uložených vlastních šablon.
- Do `armed` v `tests/backend/silence.test.ts` přidej `paymentReceipt`. Maticí pak prochází každé spárování. TST-016 zůstává v `tests/spec-partial.txt` kvůli `advanceInvoice`.

- [ ] **Step 1: Napiš testy**

```ts
test('[BNK-009] spárování bez zapnutého potvrzení nic neodešle', ...)
test('[BNK-009] se zapnutým potvrzením odejde jedna zpráva s přijatou částkou', ...)
test('[BNK-009] hlavní vypínač potvrzení zastaví a po uvolnění se samo neodešle', ...)
test('[SET-041] potvrzení platby je na novém účtu vypnuté', ...)
test('[SET-042] zapnutí potvrzení vyžaduje potvrzení s popisem', ...)
test('[SET-040] stránka ukáže potvrzení platby jako dostupné', ...) // e2e
test('[MAIL-003] {{prijato}} jde použít jen v potvrzení platby', ...)
test('ruční platba a hromadné označení nic neodešlou', ...)
test('avízo staré 4 dny potvrzení nezaloží', ...)
test('vrácení avíza zadrží potvrzení ve frontě', ...)
test('dvě rychlé platby dají dvě potvrzení a druhá první nezadrží', ...)
test('zákazník bez adresy založí upozornění', ...)
test('potvrzení na vystavenou fakturu nenastaví sent_at', ...)
test('ruční potvrzení jde přes dialog a nic neodejde bez kliknutí', ...) // e2e
test.each(MATRIX)('automatika %s při %s nepošle klientovi nic', ...) // TST-016 částečně, zahrnuje paymentReceipt
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/payment-receipt.test.ts tests/backend/silence.test.ts tests/backend/automation.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** frontu potvrzení, proměnnou, přepínač a tlačítko.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/mail-delivery.test.ts tests/backend/invoice-mail.test.ts tests/backend/email-templates.test.ts` PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test automation`, `timeout 170 pnpm exec playwright test payments`.
- [ ] **Step 5: Commit** `feat(bank): add automatic payment receipts`

---

### Task 8: Odolnost, obraz a uzavření plánu

**Files:**
- Create: `tests/e2e/docker-imap.spec.ts`, `tests/e2e/bank-flow.spec.ts`
- Modify: `tests/backend/resilience.test.ts`, `tests/helpers/crash-worker.mjs`, `tests/helpers/run-workers.ts`, `tests/e2e/fixtures.ts`, `.github/workflows/ci.yml`, `README.md`, `.env.example`, `tests/spec-pending.txt`, `tests/spec-partial.txt`, `stryker.config.json`
- Test: `tests/backend/resilience.test.ts`, `tests/e2e/bank-flow.spec.ts`, `tests/e2e/docker-imap.spec.ts`

**Interfaces:**
- Consumes: všechny služby tohoto plánu, `runCrashWorker`, `TestImap`, `TestSmtp`
- Produces: `CrashPoint` rozšířený o `in_notice_tx` a `after_notice_tx`

Spec: TST-006 **[částečně]**, TST-013, TST-016 **[částečně]**, TST-017, TST-018 **[částečně]**, OPS-004, ADM-005.

Pravidla:
- `in_notice_tx`: `SIGKILL` uvnitř transakce avíza, po restartu vznikne právě jedna platba. `after_notice_tx`: po uložení a před posunem kurzoru, zpráva se přečte znovu a nic se nezdvojí. Obě kontrolují `assertConsistent`.
- Kritický tok e2e: nastavení schránky, zpráva v `TestImap`, „Zkontrolovat teď“, uhrazená faktura, zmizelé QR, vrácení, avízo ve frontě, přiřazení.
- `freshApp` předá `ALLOW_PRIVATE_MAIL_HOSTS=1` jen tam, kde běží testovací IMAP.
- Docker test ověří, že v obrazu jde načíst `imapflow` i `mailparser`, skutečným spojením na `TestImap` z kontejneru, stejně jako `docker-scheduler` u SMTP.
- `.env.example` a README: nastavení Fio, schránka jen ke čtení, doporučení samostatné schránky, význam `require_confirmation`, prozatímní česká varianta. Spec kap. 24 se nemění, otevřený bod zůstává.
- Z `tests/spec-pending.txt` vypadnou: PAY-001 až 005, PAY-007, BNK-001 až 004, BNK-006 až 017, CUS-006, INV-023. PAY-006, BNK-005 a TST-006 přecházejí do `tests/spec-partial.txt`. V pending zůstává CRN-005 a vše z jiných plánů.
- `tests/spec-partial.txt` po uzavření, sloupce jsou odděleny tabulátorem:
  - přidat `BNK-005`: Česká varianta je prozatímní bez reálného vzorku a nepáruje se automaticky; plán: po dodání vzorku od zadavatele
  - přidat `TST-006`: České fixtury jsou prozatímní, anglická není porovnaná s reálným avízem; plán: po dodání vzorku od zadavatele
  - přidat `PAY-006`: Chybí předvyplnění kurzem ČNB; plán: plán 6
  - upravit `UI-011`: Chybí blížící se limity, spec je nedefinuje; plán: plán 8
  - odebrat `QR-005`, `QR-006`, `SEC-007`, `REM-006`, po změřeném skóre i `TST-013`
  - `TST-018` přepsat na „Kontrola nepokrývá přehledy“, plán 7
- Když skóre jádra 90 % nejde v limitu ověřit, `TST-013` zůstává s přesným důvodem a výčtem změřených souborů.

- [ ] **Step 1: Napiš testy**

```ts
test('[TST-017] SIGKILL v transakci avíza: po restartu jedna platba', ...)
test('[TST-017] SIGKILL po transakci před kurzorem: žádná druhá platba', ...)
test('[TST-017] nedostupná schránka: po obnovení se vše doplní jednou', ...)
test('[TST-017] plný disk při zápisu avíza: kurzor stojí a nic se neztratí', ...)
test('[TST-018] po každém scénáři projde kontrola souladu', ...)
test('[ADM-005] deaktivace zruší běhy čtení, po reaktivaci se pokračuje od kurzoru', ...)
test('avízo od zprávy po vrácení a přiřazení', ...) // kritický tok, bank-flow.spec.ts
test('[OPS-004] obraz: čtení schránky běží a health je ok', ...) // docker-imap.spec.ts
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/resilience.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** pomůcky a oprav nálezy v kódu. Každá oprava má vlastní test.
- [ ] **Step 4: Ověř po částech:** `timeout 170 pnpm exec vitest run --project unit`, pak `timeout 170 pnpm exec vitest run --project backend --shard=N/4` pro N = 1 až 4, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`.
- [ ] **Step 5: Ověř e2e po souborech:** `timeout 170 pnpm build` a pro každý soubor v `tests/e2e` zvlášť `timeout 170 pnpm exec playwright test <soubor>`, kromě `docker-*`.
- [ ] **Step 6: Ověř obraz** po vrstvách s `timeout 170`: `--target deps`, `--target build`, celý obraz, pak `E2E_DOCKER_IMAGE=fakturan-ci timeout 170 pnpm exec playwright test docker-imap` a `docker-scheduler`. Když krok buildu sám přesáhne limit, zapiš „Docker neověřen“ a neběž na pozadí.
- [ ] **Step 7: Uzavři:** uprav `tests/spec-pending.txt` a `tests/spec-partial.txt`, `pnpm run test:coverage-spec`, PASS. Mutace `payments.ts`, `payment-matching.ts`, `fio.ts`, `auth.ts` přes dočasnou konfiguraci, každý aspoň 90 %.
- [ ] **Step 8: Commit** `test(bank): add crash, flow and image coverage`

---

## Sebekontrola proti spec

| Oblast | Úkol | Poznámka |
|---|---|---|
| PAY-001 až 005, PAY-007 | 1, 2 | **[R-1]** až **[R-8]** |
| PAY-006 | 1, 2, 6 | Bez kurzu ČNB, partial do plánu 6 **[R-7]** |
| BNK-001, 002, SEC-003, SEC-007 | 4 | SEC-007 tím končí i pro IMAP |
| BNK-003, 004, 006, 007, 008, 013, 015, 017 | 3, 4, 5, 6 | |
| BNK-005 | 3 | Partial: česká varianta prozatímní **[R-15]** |
| BNK-009 | 7 | Ve spojení s SET-040 až 043 |
| BNK-010, 011, 012, 014, 016 | 3, 5, 6 | |
| QR-005, QR-006 | 1, 2 | Testy nad skutečnými platbami, ruší partial |
| CRN-005 | 1 | Připravený přes `amountDue` a `deriveStatus`, opravné faktury přinese plán 6, zůstává v pending |
| INV-023 | 1, 2 | Stav v `applyChange`, platí i pro obnovení verze |
| INV-024 | 2 | Označení uhrazené hotové, export v plánu 8, zůstává v partial |
| CUS-006 | 1, 2 | **[R-28]** |
| 5.5, SET-050 až 054 | 7 | Potvrzení jde stejným `resolveTransport`, Cc a Bcc z `composeMail` |
| SET-040 až 043 | 7 | Třetí ze čtyř automatik, poslední v plánu 6 |
| UI-011 | 5, 6 | Partial, limity plán 8 **[R-27]** |
| TST-006 | 3, 5, 8 | Partial do dodání vzorku **[R-30]** |
| TST-013 | 1, 3, 5, 8 | Stryker nad párováním |
| TST-016 | 7 | `advanceInvoice` chybí, plán 6 |
| TST-017, TST-018 | 1, 5, 8 | TST-018 přehledy plán 7 |
| Přenos z plánu 3 | 1, 2, 5 | `paid_minor`, stavy, INV-023, zákaz storna, CUS-006, hromadně, stejný VS, změna měny |
| Přenos z plánu 4 | 1, 4, 5, 6, 7 | `revision`, `sent_at`, `paymentReceipt`, `registerDerivedAlerts`, `assertPublicHost`, `registerTickTask`, `mailparser`, TST-016, `assertConsistent` |

Mimo rozsah zůstávají CRN-001 až 004 a 006, ADV, FOR, dashboard (DSH) a přehledy (REP, TAX). Otevřený bod „Vzorek českého avíza Fio“ v kap. 24 zůstává otevřený a tento plán ho neuzavírá.

## Přenos do dalších plánů

- **Dodání českého vzorku (zadavatel):** nahradit `tests/fixtures/fio/cs-provisional-*`, upravit tabulku popisků, přidat varianty do `AUTO_MATCH_VARIANTS`, odebrat štítek v UI a záznamy `BNK-005` a `TST-006` z `tests/spec-partial.txt`, uzavřít bod v kap. 24. Prvním reálným anglickým avízem ověřit i anglickou fixturu **[R-30]**. Dokud to neproběhne, česká avíza se párují jen ručně **[R-15]**.
- **Plán 6:** `amountDue` a SQL souhrny `total_minor - paid_minor` rozšířit o součet opravných faktur a uzavřít CRN-005, v `invoices.ts` jsou tyto výpočty na více místech. Záporné platby CRN-004 **[R-5]**, přeplatek k vrácení CRN-006, `deriveStatus` pro `credited`. Předvyplnění kurzu PAY-006. Po uhrazení zálohy navázat ADV-002 na `applyPayments` a dostupnost `advanceInvoice`, uzavřít TST-016. První ostré použití záloh ověří výběr **[R-17]** u stejného VS.
- **Plán 7:** widget nespárovaných plateb z `listNotices`, „uhrazeno“ v přehledech a TST-018 počítat s `kind = 'payment'`, řádky `difference` nejsou příjem **[R-8]**. Hodnota `paidMinor` v `customerInvoiceStats` rozdíl obsahuje, karta zákazníka to tak ukazuje.
- **Plán 8:** `source: 'import'` pro platby z importu, importované doklady nesmí párovat ani spouštět potvrzení bez výslovného rozhodnutí, `external` musí vstoupit do `matchNotice`. Export INV-024 a EXP-009 bez `password_enc`. IMP-010: po obnově vyplnit schránku znovu, ADM-009 zálohuje `payment` a `bank_notification` včetně `dedupe_key`, jinak obnova otevře **[R-18]**. UI-011 limity.
- **Plán 9:** ukázka schránky v dokumentaci, ověřit na reálném poskytovateli, že nejvyšší `Authentication-Results` opravdu přidává příjemce, a vyhodnotit, zda výchozí `require_confirmation` nepřináší zbytečné ruční kliky **[R-16]**. Rozhodnout o řadách, aby faktura a záloha neměly stejný VS.
- **Známá rizika:** odeslané potvrzení nejde vzít zpět **[R-22]**. Pomalá schránka může zdržet worker až o 60 s, protože worker je jediný **[R-11]**. Popisky avíz mimo spec jsou předpoklad **[R-14]**, chyba v nich dá nerozpoznaná avíza, ne špatné platby.
