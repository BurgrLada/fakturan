# Fakturan 4: E-mail, upomínky, pravidelné faktury a plánovač – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uživatel odešle fakturu klientovi jedním potvrzeným krokem s archivem odeslaného PDF, nastaví si pravidelné faktury a upomínky, a plánovač běží spolehlivě i po výpadku, aniž by cokoli odešlo dvakrát nebo bez svolení.

**Architecture:** Automatika je trubka se třemi vrstvami: `croner` jen spouští `tick()`, `tick()` podle injektovaných hodin zakládá úlohy v tabulce `job` s idempotenčním klíčem a worker je vykonává. Doručení e-mailu je stavový automat nad `email_log`: stav `sending` se zapíše před SMTP, takže přerušené odeslání skončí jako `unknown`, nikdy jako druhý pokus. Svolení se ověřuje těsně před SMTP, ne při zařazení do fronty. Termíny plánů počítá čistá funkce v `src/lib`, služby v `src/server/services` jsou jediná cesta ke změně dat.

**Tech Stack:** Next.js 16.4, Drizzle, better-sqlite3, Zod, `nodemailer` 10, `croner` (nově), `@react-pdf/renderer`, Sentry SDK, Vitest, fast-check, Stryker, Playwright, `smtp-server`, dev: `mailparser`.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`, kap. 5.4, 5.5, 10, 11, 12, dotyčné části 13, ARC-007, SEC-001, SEC-007, MON-003, OPS-004, OPS-005, ADM-005, UI-011, TST-005, 007, 010, 016, 017.

## Global Constraints

- Správce balíčků je pnpm. Práce probíhá na `main`. Nic se nepushuje a nic se nenasazuje.
- **Harness přesouvá příkazy nad 180 s na pozadí.** Každý příkaz v popředí proto běží nejvýš 170 s (`timeout 170 …`) a dlouhé běhy se dělí po částech: `pnpm exec vitest run --project unit`, `pnpm exec vitest run --project backend --shard=N/4` a Playwright po jednotlivých souborech. **Nikdy nečekej na úlohu na pozadí.** Běh, který se do limitu nevejde, rozděl jemněji. Když to nejde, zapiš do zprávy úkolu „neověřeno“ s příkazem a nepředstírej úspěch.
- `pnpm build` před Playwrightem, protože fixture spouští `next start`.
- `minimumReleaseAge` se neobchází: žádný `--config` ani změna `pnpm-workspace.yaml`. Když je nejnovější verze moc čerstvá, použij nejbližší starší, kterou pnpm přijme.
- Každá nová závislost s nativní částí nebo soubory čtenými za běhu se ověří v Docker obrazu. Docker je jediná build cesta.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů. Agent staguje jen své soubory.
- Komentáře jen pro neočividné invarianty. **UI texty česky a v `src/lib/texts.ts`**, jen tokeny barev. Texty, které dostane klient, patří dokumentu: leží v `src/server/mail/defaults.ts` po vzoru `src/server/pdf/labels.ts`.
- **Migrace navazují po `0018_invoice_template`:** `pnpm exec drizzle-kit generate --name <jméno>`, čísla podle úkolů níže. Ruční SQL jen tam, kde to úkol říká.
- Před kódem v App Routeru přečti příslušný návod v `node_modules/next/dist/docs/` (viz `AGENTS.md`).
- Název testu obsahuje ID požadavku, `tests/spec-pending.txt` se průběžně zmenšuje. ID splněné jen zčásti v seznamu zůstává a `test:coverage-spec` selže na ID, které je zároveň v seznamu i v názvu testu, takže takový test ID v názvu nenese a nad testem je komentář proč (vzor `tests/backend/invoices-list.test.ts:414`). Úkoly to mají označené **[částečně]**.
- Každá zapisující služba jde přes `mutate(actor, action, (tx, audit) => T)`. Mutace je synchronní, PDF ani SMTP v ní neběží. Fronta a plánovač žijí mimo `src/server/services`, protože jejich provozní zápisy nejsou auditované události. Každý doménový výsledek běhu ale jde přes `mutate`.
- Plánovač jedná za aktéra `{ userId: ownerId, source: 'scheduler' }`, instanční práce za `{ userId: null, source: 'scheduler' }`.
- Každý dotaz na data účtu jde přes `scoped(ownerId)`. Každá nová tabulka s vlastníkem patří do `USER_OWNED_TABLES` před tabulky, na které nekaskádově odkazuje, a má test `assertIsolated` včetně `update` a `remove`. Server actions pokrývá `tests/backend/actions-isolation.test.ts`.
- Aktuální čas jen přes `clock`, „dnes“ přes `calendarDateInPrague`. V `src/server/jobs`, `src/server/scheduler`, `src/lib/recurrence.ts` ani v běhových službách není `new Date()` bez argumentu ani `Date.now()`.
- Úlohy nesou v `payload` jen ID a data. Adresy, předměty ani tajemství do `payload`, logů ani Sentry nepatří.
- Nic neodejde klientovi bez kliknutí nebo zapnuté automatiky. Vstupy se validují na serveru sdíleným Zod schématem.

## Review Focus

1. Proces spadne po přijetí zprávy SMTP serverem, ale před zápisem výsledku: klient nedostane druhou zprávu, doklad ukáže „nevíme, zda odešlo“ a uživatel rozhodne (Task 6, Task 12).
2. Mezi zařazením a doručením se změní svolení nebo doklad: vypnutá automatika, hlavní vypínač, storno, úprava, deaktivace účtu. Nic neodejde a po opětovném zapnutí se nic zadržené samo neuvolní (Task 3, Task 6, Task 9, Task 11).
3. Dva souběžné ticky, restart, starý kontejner při nasazení, výpadek přes hranici 3 dnů, přechod času, 31. den: každý termín vznikne právě jednou a starý termín se klientovi nepošle (Task 1, Task 8, Task 9).
4. Vlastní SMTP jako cesta do sítě instance: DNS rebinding, IPv4 v IPv6, `169.254.169.254`, port mimo poštu, chybová hláška jako sonda a heslo v auditu, logu nebo Sentry (Task 4).
5. Archiv musí být přesně to, co odešlo: opakovaný pokus po úpravě dokladu neodešle staré PDF a pozdě vystavený doklad má období z plánu, ne z běhu (Task 6, Task 9).

## Rozhodnutí plánu

Uživatel chtěl plány bez čekání, proto je plán rozhodl sám. Na `[R-n]` se odkazují úkoly.

- **[R-1] Doručení je nejvýš jednou.** SMTP není transakční, takže při přerušení po začátku odesílání dostane přednost riziko „nedoručeno“ před duplicitou (spec 2.2). Nejasný výsledek je stav `unknown` bez automatického opakování a s upozorněním.
- **[R-2] Klasifikace chyb SMTP:** 4xx a selhání spojení před `DATA` se opakují, 5xx je trvalé selhání, přerušení během nebo po `DATA` je `unknown`.
- **[R-3] Opakování:** REC-013 „opakovaný pokus maximálně 3krát“ znamená 1 + 3 pokusy, odstup 5 min, 30 min, 2 h. Platí i pro ruční odeslání (MAIL-005). Pokus po změně revize dokladu se neprovede, záznam přejde do `held`.
- **[R-4] Svolení se ověřuje těsně před SMTP.** Automatické odeslání znovu kontroluje automatiku, vypínač, stav a revizi dokladu. Zadržené zůstává `held` a samo se neuvolní. Ruční kliknutí hlavní vypínač neblokuje, protože SET-043 mluví o automatice.
- **[R-5] Ochrana proti dvojímu nasazení:** i při ARC-008 drží plánovač lease v `scheduler_state`, protože při přenasazení se starý a nový kontejner chvíli překrývají nad jedním svazkem. Lease 120 s. Převzetí po cizím držiteli spustí obnovu přerušených úloh.
- **[R-6] Hlavní vypínač a režimy:** vypínač pošle režimy „vystavit“ i „vystavit a odeslat“ do konceptu (doslova REC-007). Vypnutá automatika `recurringSend` se týká jen režimu „vystavit a odeslat“.
- **[R-7] Stránka Automatizace ukazuje všechny 4 automatiky ze SET-040.** Sloupce vzniknou hned a jsou vypnuté. Potvrzení platby a odeslání po záloze jsou do plánů 5 a 6 viditelné, ale nejdou zapnout.
- **[R-8] Automatizace je vlastní tabulka `automation_settings`, ne `preferences`.** Obecný `savePreferences` tak nemůže zapnout nic vůči klientovi a zapnutí bez `confirmed: true` odmítne služba, nejen dialog.
- **[R-9] Jeden denní čas účtu.** `send_time` (výchozí 9:00, REM-008) platí pro upomínky i pravidelné faktury. Denní práce běží „první tick po čase a jednou za den“ s klíčem data, nikdy podle přesné shody minuty, takže přežije výpadek i přechod času.
- **[R-10] Upomínka po pauze se nedohání.** Stupeň se pošle automaticky jen s datem větším než `reminders_open_since` (přísně větším) a nejvýš 3 dny starý. Zapnutí tedy nerozešle upomínky na staré dluhy a REC-007 je splněné i při zapnutí a vypnutí v jeden den. Zmeškané stupně ukazuje seznam „Ke kontrole“.
- **[R-11] Automatické upomínky jdou jen na stav `sent` (a povolený `partially_paid`).** Klient nesmí dostat upomínku na doklad, který nikdy nedostal. Ruční upomínka jde i na `issued`.
- **[R-12] Zákazník `remindersEnabled = true` nezapíná nic navíc.** Blokuje jen `false`, účetní automatika musí být zapnutá vždy.
- **[R-13] `reminder_sent` spotřebuje stupeň při zařazení,** ve stejné transakci jako fronta. Selhání odeslání se nezkouší novým stupněm, ale upozorněním. Ruční upomínka vyžaduje potvrzení, když už stupeň odešel, a automatika pak tento stupeň přeskočí.
- **[R-14] Plán drží vlastní kopii dokumentu** ve tvaru `TemplateDocument`. Vytvoření ze šablony ji zkopíruje, takže úprava nebo smazání šablony nezmění, co automaticky odchází klientovi.
- **[R-15] Období je uložené na faktuře** (`period_from`, `period_to`). Koncept z plánu tak v náhledu i při pozdním vystavení dá období z plánu a `variablesFor` padá na `monthPeriod` jen bez uloženého období.
- **[R-16] Definice období:** měsíc, čtvrtletí, pololetí a rok jsou kalendářní, týden je pondělí až neděle. „Každých N“ jsou bloky od měsíce nebo týdne začátku. „Konkrétní den“ D se kotví na začátek plánu: rozhoduje první datum se dnem D (s oříznutím na konec měsíce, u týdne den v týdnu 1 až 7), které je ≥ `startsOn`, a jeho pozice v období, měsíc nebo týden, se opakuje v každém dalším. Od 14. 2. s dnem 20 je to ročně 20. 2., čtvrtletně 20. 2., 20. 5., 20. 8., 20. 11.; od 25. 2. ročně 20. 3. Když datum vypadne z období 0 (start 25. 12. ročně), plán začíná v prvním měsíci dalšího období. Stejně se kotví první pracovní den. Poslední pracovní den a poslední den období se počítají od konce období a kotvení nemají. Plány se startem na začátku období to nemění. `period_key` je první den plánovacího období, období zůstávají kalendářní.
- **[R-17] Pracovní den** je pondělí až pátek bez českých státních svátků včetně Velkého pátku a Velikonočního pondělí.
- **[R-18] Vznik plánu nedohání minulost.** Termíny před dnem založení nevznikají ani jako zmeškané. Počet v REC-003 počítá termíny plánu, ne úspěšné běhy.
- **[R-19] Doběh:** termín starý přesně 3 dny ještě doběhne, starší je `missed`. Po pauze a reaktivaci je každý minulý termín `missed`, dnešní běží. Zmeškaný termín jde vytvořit jako koncept nebo přeskočit, nikdy neodešle.
- **[R-20] Doklad, který nejde vystavit, se neztratí.** Běh v savepointu spadne na koncept s upozorněním a číslo se nespotřebuje. Týká se i plánu bez zákazníka a cizí měny bez kurzu (ČNB je plán 6).
- **[R-21] Deaktivace zruší čekající úlohy účtu** a záznamy pošty převede na `cancelled`. Claim navíc deaktivované účty přeskakuje. Pokus běžící v okamžiku deaktivace doběhne, nejde vzít zpět.
- **[R-22] Pošta je jen prostý text.** Bez HTML je SEC-011 i MAIL-007 splněné konstrukcí. Předmět nesmí obsahovat konec řádku.
- **[R-23] Proměnné e-mailů** rozšiřují 10.3 o `{{castka}}`, `{{zbyva}}`, `{{splatnost}}`, `{{vs}}`, `{{dodavatel}}`, jinak by REM-006 neměl jak uvést zbývající částku. V dokladech dál platí jen seznam z 10.3.
- **[R-24] Příjemce se bere z aktuální karty zákazníka,** snapshot je jen záloha po smazaném zákazníkovi. Doklad si drží starou adresu pro tisk, ne pro doručení.
- **[R-25] Vlastní SMTP:** povolené porty 25, 465, 587, 2525 a povinné TLS. Spojení jde na ověřenou IP s `servername` původního hostitele kvůli rebindingu. `ALLOW_PRIVATE_MAIL_HOSTS` obě omezení ruší jen pro privátní cíl. Instanční SMTP vybral provozovatel, SEC-007 se ho netýká.
- **[R-26] Přehled po splatnosti se počítá při čtení,** není uložený, takže sám zmizí po úhradě. V `notification` jsou jen události. „Blížící se splatnost“ znamená do 3 dnů.
- **[R-27] Hlavní vypínač se netýká zpráv uživateli** (denní přehled, REC-012). SET-040 vyjmenovává jen automatiky vůči klientovi a při potížích jsou tyto zprávy potřeba nejvíc.
- **[R-28] Záloha je atomická:** `VACUUM INTO` do `.tmp`, `integrity_check`, přejmenování a teprve pak úklid nad 14 kopií. Běží po 2:30 Prague, po selhání nejvýš jednou za hodinu.
- **[R-29] Health:** `stale` (poslední tick před více než 5 min) vrátí 503. Neúspěšný start plánovače je stejně fatální jako selhání migrace.
- **[R-30] Sentry dostává jen pády kódu, ne provozní selhání.** Selhané SMTP klienta je upozornění uživateli, ne chyba aplikace. Do události jde druh úlohy a ID, nikdy text odpovědi serveru.
- **[R-31] ISDOC příloha přijde v plánu 8** s generátorem a validací. Dialog má prostor pro přílohy, MAIL-001 v pending zůstává **[částečně]**.
- **[R-32] Nová proměnná `SCHEDULER_TICK_SECONDS`** (výchozí 60, rozsah 1 až 60) slouží e2e testům. Spec 19.5 se o ni doplní.

---

### Task 1: Fronta úloh a plánovač

**Files:**
- Create: `src/server/db/schema/job.ts`, `drizzle/0019_job.sql`, `src/server/jobs/queue.ts`, `src/server/jobs/registry.ts`, `src/server/jobs/worker.ts`, `src/server/scheduler/lease.ts`, `src/server/scheduler/tick.ts`, `src/server/scheduler/start.ts`, `src/server/scheduler/report.ts`, `tests/helpers/job-worker.mjs`
- Modify: `src/server/db/schema/index.ts`, `src/instrumentation.ts`, `src/server/health.ts`, `src/server/env.ts`, `src/server/services/users.ts`, `src/server/services/instance-status.ts`, `src/app/(app)/administrace/page.tsx`, `src/lib/number-format.ts`, `src/lib/texts.ts`, `tests/helpers/run-workers.ts`, `tests/helpers/smtp.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/health.spec.ts`, `tests/backend/ops.test.ts`, `.env.example`, `package.json`, `pnpm-lock.yaml`, `docs/superpowers/specs/2026-10-30-fakturan-design.md` (jen řádek tabulky 19.5)
- Test: `tests/backend/jobs.test.ts`, `tests/backend/scheduler.test.ts`, `tests/backend/scheduler-concurrency.test.ts`

**Interfaces:**
- Produces:
  - `JOB_KINDS`, `type Job`, `type JobPayload`
  - `enqueue(tx: Tx, input: { kind; key: string; userId: string | null; payload; runAt?: Date; maxAttempts?: number }): { id: string; created: boolean }`
  - `claimNext(worker: string): Job | null`, `completeJob(id, worker)`, `retryJob(id, worker, { runAt, reason })`, `failJob(id, worker, reason)`, `cancelUserJobs(tx: Tx, userId: string): string[]`
  - `registerJob(kind, { run: (job: Job) => Promise<void>; recover?: (job: Job) => void })`, `class RetryLater extends Error { delayMs; report }`
  - `drainJobs(worker: string): Promise<number>`, `kickWorker(): void`
  - `acquireLease(holder: string): 'held' | 'taken_over' | 'busy'`, `releaseLease(holder)`
  - `type TickTask = { name: string; run: (now: Date) => void | Promise<void> }`, `registerTickTask(task)`, `tick(holder: string): Promise<{ ran: boolean }>`
  - `startScheduler()`, `stopScheduler()`, `schedulerHealth(q): 'not_started' | 'starting' | 'running' | 'stale'`
  - `reportFailure(error: unknown, ctx: { task: string; jobId?: string; kind?: string; userId?: string }): void`
  - `timeInPrague(value: Date): string` (`HH:MM`), `isDailyDue(now: Date, at: string): boolean`
  - `Health.scheduler` rozšířené o nové stavy, `getInstanceStatus().scheduler` stejně
  - `TestSmtp`: `rejectNext(code)`, `dropDuringData()`, `holdData(): release`, parsované `attachments` přes `mailparser`

Datový model:

| Tabulka | Sloupce |
|---|---|
| `job` | `id`, `user_id` (null = instance, cascade), `kind`, `key` (unikátní), `payload` (JSON), `status` (`pending`,`running`,`done`,`dead`,`cancelled`), `run_at`, `attempts`, `max_attempts`, `locked_by`, `reason`, `created_at`, `updated_at`; index `(status, run_at)` |
| `scheduler_state` | `id` (vždy 1), `holder`, `lease_until`, `started_at`, `last_tick_at`, `last_ok_at`, `last_backup_at`, `last_backup_try_at` |

Spec: ARC-004, ARC-007, ARC-008, OPS-004, MON-003, TST-010, ADM-005, AUD-002.

Pravidla:
- `croner` s `protect: true` jen volá `tick()`. Všechna logika jde testovat voláním `tick()` s posunutými hodinami. Vzor: `*/N * * * * *` podle `SCHEDULER_TICK_SECONDS`.
- Pořadí `tick()`: lease, při `taken_over` obnova přerušených úloh, `last_tick_at`, registrované úlohy po jedné v `try/catch` (selhání jedné nezastaví ostatní a jde do `reportFailure`), `drainJobs`, `last_ok_at`, až nakonec.
- Worker je jediný běžící, `kickWorker()` ho spustí hned po zařazení, `running` se chrání příznakem. Lease se obnovuje před každou úlohou **[R-5]**.
- Claim je atomický `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING` v `immediate` transakci, zvýší `attempts` a přeskočí účty s `banned` **[R-21]**.
- Obnova: `running` bez živého držitele projde `recover`, výchozí chování je návrat do `pending`. `mail.send` si `recover` zaregistruje v Task 6.
- `attempts >= max_attempts` je `dead` a `reportFailure`. `RetryLater` a běžná výjimka spotřebují pokus stejně, jen `RetryLater` není hlášený.
- `startScheduler` v `register()` běží v bloku fail-fast za migracemi **[R-29]**, je chráněný přes `globalThis` proti dvojímu startu v dev a zapíše řádek `scheduler_state` synchronně. `SIGTERM` uvolní lease.
- `reportFailure` zapíše `logger.error` a s `SENTRY_DSN` zavolá `Sentry.captureException`. Text výjimky jde přes stávající `beforeSend` **[R-30]**.
- Hotové úlohy se mažou po 90 dnech v denní údržbě. Idempotenci po té době drží `recurring_run`, `reminder_sent` a `email_log`.
- `deactivateUser` zavolá `cancelUserJobs` ve své transakci. `job` jde do `USER_OWNED_TABLES`.
- Stav v administraci jde přes `TEXTS`, ne natvrdo v `page.tsx`.

- [ ] **Step 1: Napiš testy**

```ts
test('[ARC-007] stejný klíč založí jednu úlohu a druhý enqueue vrátí created: false', ...)
test('[ARC-007] selhaná transakce úlohu nezaloží', ...)
test('[ARC-007] běžící úloha po pádu projde recover a doběhne', ...)
test('[ARC-007] po max_attempts je úloha dead a hlášená', ...)
test('[ARC-004] úloha s run_at v budoucnu neběží, po posunu hodin ano', ...)
test('[ARC-004] kód plánovače nepoužívá Date.now ani new Date() bez argumentu', ...) // textová kontrola
test('[ARC-008] druhý držitel při živém lease nespustí nic, po vypršení převezme', ...)
test('[TST-010] 8 souběžných workerů vykoná každou ze 100 úloh právě jednou', ...) // job-worker.mjs
test('[TST-010] souběžné ticky nezaloží duplicitu', ...)
test('[OPS-004] health: running, po 5 min bez ticku stale a status error', ...)
test('[OPS-004] /api/health hlásí běžící plánovač bez citlivých údajů', ...) // e2e, expect.poll
test('[MON-003] selhání úlohy zavolá Sentry s druhem a ID, bez adres a textu odpovědi', ...)
test('[MON-003] selhání jedné tick úlohy nezastaví další', ...)
test('[ADM-005] deaktivace zruší čekající úlohy, claim je nepřevezme', ...)
test('[TST-009] úlohy cizího účtu nejsou v jeho výpisu a mizí se smazáním účtu', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/jobs.test.ts tests/backend/scheduler.test.ts`, FAIL.
- [ ] **Step 3: Přidej závislosti** `pnpm add croner` a `pnpm add -D mailparser`. Respektuj `minimumReleaseAge`: balíček `croner` byl naposledy upraven 27. 10. 2026, takže nejnovější verze nemusí projít. Při odmítnutí vezmi nejbližší starší.
- [ ] **Step 4: Implementuj** schéma, migraci `--name job` a rozhraní výše. Rozšiř `TestSmtp`. `freshApp` dostane `SCHEDULER_TICK_SECONDS=1` a volitelné SMTP z testovacího serveru.
- [ ] **Step 5: Ověř:** `timeout 170 pnpm exec vitest run tests/backend/jobs.test.ts tests/backend/scheduler.test.ts tests/backend/scheduler-concurrency.test.ts tests/backend/ops.test.ts tests/backend/users.test.ts`, PASS. Pak `timeout 170 pnpm build` a `timeout 170 pnpm exec playwright test health`.
- [ ] **Step 6: Commit** `feat(scheduler): add job queue and scheduler`

---

### Task 2: Denní záloha

**Files:**
- Create: `src/server/scheduler/backup.ts`
- Modify: `src/server/scheduler/start.ts`, `src/server/audit/record.ts`, `src/server/services/instance-status.ts`, `src/lib/audit-labels.ts`, `README.md`
- Test: `tests/backend/backup.test.ts`

**Interfaces:**
- Consumes: `registerTickTask`, `isDailyDue`, `reportFailure`
- Produces: `createBackup(now: Date): { path: string; bytes: number }`, `listBackups(): { name; at: CalendarDate; bytes }[]`, `pruneBackups(keep: number): void`, `BACKUP_KEEP = 14`, `backupTask: TickTask`

Spec: OPS-005, ADM-008, AUD-002, MON-003. Viz **[R-28]**. Složka `DATA_DIR/backups`, soubor `fakturan-YYYY-MM-DD.db`, oprávnění `0600`. `VACUUM INTO` nesmí běžet v transakci a přepsat existující soubor, proto je cíl vždy `.tmp` po úklidu staré `.tmp`. Kontrola otevře kopii jen pro čtení a čeká `integrity_check = ok`. Klíčem dne je existence souboru, takže restart nepřidá druhou kopii. Do `INSTANCE_ENTITIES` přibude `backup`. Audit `backup.create` a `backup.failed` je `scope: 'instance'`, aktér `{ userId: null, source: 'scheduler' }`. Selhání zapíše `last_backup_try_at`, oznámí `reportFailure` a nesmaže žádnou starou kopii. Šifrovaná tajemství zůstávají v záloze šifrovaná.

README: obnova znamená zastavit kontejner, nahradit `fakturan.db` zálohou, smazat `-wal` a `-shm`, spustit se stejným `ENCRYPTION_KEY`. Složka `files/` v záloze není a záloha leží na stejném svazku, proto ji provozovatel kopíruje mimo. Nahraď větu „se připravuje“.

- [ ] **Step 1: Napiš testy**

```ts
test('[OPS-005] po 2:30 vznikne jedna záloha a druhý tick stejného dne nic nepřidá', ...)
test('[OPS-005] před 2:30 záloha nevznikne, v den přechodu času ano', ...)
test('[OPS-005] 15. záloha smaže nejstarší', ...)
test('[OPS-005] selhání nechá staré kopie, žádné .tmp a je hlášené, další pokus po hodině', ...)
test('[OPS-005] obnovená kopie má shodná data', ...) // TST-019 zůstává pro upgrade migrací
test('[ADM-008] stav instance ukáže čas poslední zálohy', ...)
test('[AUD-002] záloha je v auditu instance', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/backup.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** rozhraní a pravidla, zaregistruj `backupTask`.
- [ ] **Step 4: Ověř:** `timeout 170 pnpm exec vitest run tests/backend/backup.test.ts tests/backend/ops.test.ts`, PASS.
- [ ] **Step 5: Commit** `feat(ops): add daily database backup`

---

### Task 3: Automatizace a centrum upozornění

**Files:**
- Create: `src/server/db/schema/automation.ts`, `src/server/db/schema/notification.ts`, `drizzle/0020_automation.sql`, `src/lib/automation.ts`, `src/server/services/automation.ts`, `src/server/services/notifications.ts`, `src/app/(app)/nastaveni/automatizace/page.tsx`, `src/app/(app)/nastaveni/automatizace/actions.ts`, `src/components/settings/automation-panel.tsx`, `src/app/(app)/upozorneni/page.tsx`, `src/app/(app)/upozorneni/actions.ts`, `src/components/notifications/notification-bell.tsx`, `src/components/notifications/notification-list.tsx`
- Modify: `src/server/db/schema/index.ts`, `src/server/services/users.ts`, `src/components/settings-tabs.tsx`, `src/app/(app)/layout.tsx`, `src/components/app-shell.tsx`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`
- Test: `tests/backend/automation.test.ts`, `tests/backend/notifications.test.ts`, `tests/e2e/automation.spec.ts`

**Interfaces:**
- Produces:
  - `AUTOMATIONS`: pole `{ key: 'recurringSend'|'reminders'|'paymentReceipt'|'advanceInvoice'; available: boolean }` **[R-7]**
  - `getAutomation(ownerId): AutomationSettings`, bez řádku vše vypnuté a `sendTime: '09:00'`
  - `setAutomation(actor, key, enabled, opts: { confirmed: boolean })`, `setPaused(actor, paused, opts: { confirmed: boolean })`, `setSendTime(actor, value)`, `setDailyDigest(actor, enabled)`
  - `automaticSendAllowed(ownerId, key): boolean`, jediné místo pro test svolení
  - `notify(tx: Tx, input: { userId; kind: NotificationKind; dedupeKey: string; params; entity?: { type; id } }): void`
  - `listNotifications(ownerId, page)`, `unreadCount(ownerId)`, `markRead(actor, id)`, `markAllRead(actor)`, `resolveNotification(tx, userId, dedupeKey)`
  - `registerDerivedAlerts(source: (ownerId, today) => Alert[])` pro Task 11, plány 5 a 8 ji rozšíří

Datový model:

| Tabulka | Sloupce |
|---|---|
| `automation_settings` | `user_id` (PK, cascade), `recurring_send`, `reminders`, `payment_receipt`, `advance_invoice`, `paused`, `reminders_open_since`, `send_time`, `daily_digest`, `updated_at` |
| `notification` | `id`, `user_id` (cascade), `kind`, `dedupe_key`, `params` (JSON), `entity_type`, `entity_id`, `read_at`, `resolved_at`, `created_at`; unikátní `(user_id, dedupe_key)`, index `(user_id, read_at, created_at)` |

Spec: SET-040 až 043, REM-001, UI-011 **[částečně]**, AUD-001. Viz **[R-4]**, **[R-7]**, **[R-8]**, **[R-10]**.

Pravidla:
- Zapnutí bez `confirmed: true` je `ServiceError`. Vypnutí potvrzení nepotřebuje. Dialog popisuje, co a komu odejde, a uvádí počet dotčených plánů nebo zákazníků.
- Vypnutí pozastavení potvrzení vyžaduje a dialog říká, že se nic zadržené samo neodešle. `reminders_open_since` se nastaví na dnešek při zapnutí upomínek i při zrušení pozastavení se zapnutými upomínkami.
- `automaticSendAllowed` vrací `false`, když je `paused`, když je automatika vypnutá nebo když je účet `banned`.
- `notify` je `onConflictDoNothing`. Texty se skládají z `kind` a `params` až při zobrazení, takže `TEXTS` zůstává jediný zdroj. Hodnoty jsou prostý text, React je escapuje.
- Zvonek s počtem nepřečtených je v shellu v `Suspense`. Stránka `/upozorneni` má prázdný stav (UI-009).

UI-011 vyžaduje i nespárované platby, avíza a limity, ID zůstává v pending a testy ho v názvu nenesou.

- [ ] **Step 1: Napiš testy**

```ts
test.each(AUTOMATIONS)('[SET-041] %s je na čisté databázi vypnutá', ...)
test('[REM-001] upomínky jsou na novém účtu vypnuté', ...)
test('[SET-042] zapnutí bez potvrzení je odmítnuté službou', ...)
test('[SET-042] dialog popíše, co a komu se pošle', ...) // e2e
test('[SET-043] hlavní vypínač zavře automaticSendAllowed všem automatikám', ...)
test('[SET-040] stránka ukáže všechny 4 automatiky a jejich stav', ...) // e2e
test('[AUD-001] každé přepnutí je v auditu', ...)
test('[TST-009] izolace nastavení a upozornění včetně update a remove', ...)
test('stejný dedupeKey založí jedno upozornění', ...)
test('zvonek ukáže počet a přečtení ho sníží', ...) // UI-011 částečně
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/automation.test.ts tests/backend/notifications.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci `--name automation`, služby a UI.
- [ ] **Step 4: Ověř:** stejné testy PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test automation`, `timeout 170 pnpm exec vitest run tests/backend/users.test.ts`, PASS.
- [ ] **Step 5: Commit** `feat(automation): add automation settings and notification center`

---

### Task 4: Vlastní SMTP a ochrana proti SSRF

**Files:**
- Create: `src/server/db/schema/mail.ts`, `drizzle/0021_mail_settings.sql`, `src/server/mail/host-guard.ts`, `src/server/mail/transport.ts`, `src/server/services/mail-settings.ts`, `src/app/(app)/nastaveni/posta/page.tsx`, `src/app/(app)/nastaveni/posta/actions.ts`, `src/components/settings/mail-settings-form.tsx`
- Modify: `src/server/mail/instance.ts`, `src/server/db/schema/index.ts`, `src/server/services/users.ts`, `src/components/settings-tabs.tsx`, `src/server/rate-limit.ts`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`
- Test: `tests/backend/mail-settings.test.ts`, `tests/unit/host-guard.test.ts`, `tests/e2e/mail-settings.spec.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret`, `isInstanceMailConfigured`, `enforceRateLimit`
- Produces:
  - `isPrivateAddress(ip: string): boolean`
  - `assertPublicHost(host: string, port: number, opts: { allowPrivate: boolean }): Promise<{ address: string; isPrivate: boolean }>`, vyhodí `BlockedHostError`
  - `type MailMessage = { messageId?: string; from; replyTo?; to; cc?; bcc?; subject; text; attachments? }`
  - `resolveTransport(ownerId): Promise<MailTransport | null>`, `MailTransport = { source: 'user'|'instance'; identity: { from; replyTo?; cc: string[]; bcc: string[] }; send(msg): Promise<{ accepted: string[]; rejected: string[] }> }`
  - `mailAvailability(ownerId): { available: boolean; source: 'user'|'instance'|null }`
  - `getMailSettings(ownerId)`, bez hesla, jen `hasCredentials`
  - `saveMailSettings(actor, raw)`, `clearOwnSmtp(actor)`, `sendTestMail(actor): Promise<void>`
  - `RATE_RULES.sendBulkUser = rule('sendBulkUser', 5, 3600)` pro Task 7

`mail_settings`: `user_id` (PK, cascade), `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password_enc`, `from_email`, `sender_name`, `reply_to`, `cc` (JSON), `bcc` (JSON), `verified_at`, `updated_at`.

Spec: SET-050 až 054, SEC-003, SEC-007 **[částečně, IMAP je plán 5]**, SEC-001, SEC-006, AUD-004. Viz **[R-25]**.

Pravidla:
- `assertPublicHost` kontroluje všechny záznamy z `dns.lookup({ all: true })`, jeden privátní stačí k odmítnutí. Rozsahy jsou v `net.BlockList`: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `::1`, `::`, `fc00::/7`, `fe80::/10`, `ff00::/8`. IPv4 v IPv6 (`::ffff:a.b.c.d`) se rozbalí před testem.
- Kontrola proběhne při uložení i před každým spojením, protože DNS se může změnit. `nodemailer` dostane `host: address` a `tls: { servername: host }`.
- `secure` pro 465, jinak `requireTLS: true`, s výjimkou povoleného privátního cíle. Časové limity: spojení 15 s, pozdrav 10 s, socket 30 s. `logger` a `debug` vypnuté, aby se heslo nedostalo do logu.
- Heslo je jen pro zápis. Prázdné pole při uložení zachová stávající. Audit nese `hasCredentials`, hostitele a port, nikdy heslo. Zašifrovaný sloupec se v audit snapshotu nepoužívá.
- `SET-051`: zkušební zpráva jde výhradně na e-mail účtu, adresa není vstup. Testuje se uložené nastavení. Rate limit `sendUser`. Chyba má jednu obecnou hlášku a zvláštní jen pro zablokovaného hostitele, aby stránka nesloužila jako skener sítě.
- `identity`: u instančního SMTP je adresa `SMTP_FROM`, jméno odesílatele a `reply_to` z nastavení účtu. U vlastního `from_email`. Vlastní `cc` a `bcc` se přidají ke každé zprávě klientovi.
- Selhání dešifrování je v `resolveTransport` `null`, ne pád.
- `SET-053`: bez dostupného SMTP stránka vysvětlí proč. Dialog odeslání a jeho test přidá Task 7.

Testy hostitele ID v názvu nenesou, SEC-007 zůstává v pending do IMAP.

- [ ] **Step 1: Napiš testy**

```ts
test.each(PRIVATE_ADDRESSES)('%s je privátní', ...) // SEC-007 částečně
test('hostitel s jedním privátním záznamem je odmítnutý', ...)
test('::ffff:127.0.0.1 je odmítnutý', ...)
test('port 22 je odmítnutý, 587 projde', ...)
test('ALLOW_PRIVATE_MAIL_HOSTS povolí privátní cíl a jen pro něj nevyžaduje TLS', ...)
test('změna DNS po uložení odmítne spojení, jde se na ověřenou IP', ...)
test('[SEC-003] heslo je v databázi šifrované a neopouští službu', ...)
test('[AUD-004] heslo SMTP se nedostane do auditu', ...)
test('[SET-050] vlastní SMTP přebije instanční', ...)
test('[SET-051] test odejde na e-mail účtu a klient nic nedostane', ...)
test('[SET-052] smazání vrátí instanční SMTP a jméno odesílatele zůstane', ...)
test('[SET-054] jméno, Reply-To, Cc a Bcc jsou ve zprávě', ...)
test('[SEC-001] test SMTP je omezený a překročení je v auditu', ...)
test('[TST-009] izolace nastavení pošty', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/mail-settings.test.ts tests/unit/host-guard.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci `--name mail_settings`, ochranu, transport a formulář. `sendInstanceMail` převeď na stejný `buildTransport`, pozvánky a reset hesla se chovat nesmí jinak.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/invitations.test.ts tests/backend/auth.test.ts` PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test mail-settings`.
- [ ] **Step 5: Commit** `feat(mail): add per-account smtp with ssrf protection`

---

### Task 5: Šablony e-mailů a proměnné

**Files:**
- Create: `drizzle/0022_email_template.sql`, `src/server/mail/defaults.ts`, `src/server/services/email-templates.ts`, `src/app/(app)/nastaveni/posta/sablony/page.tsx`, `src/app/(app)/nastaveni/posta/sablony/actions.ts`, `src/components/settings/email-template-form.tsx`
- Modify: `src/server/db/schema/mail.ts`, `src/lib/template-vars.ts`, `src/server/services/users.ts`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `src/components/settings/mail-settings-form.tsx`
- Test: `tests/backend/email-templates.test.ts`, `tests/unit/template-vars.test.ts`

**Interfaces:**
- Consumes: `variablesFor`, `loadInvoiceDocument`, `amountDue`, `getCustomer`
- Produces:
  - `MESSAGE_KINDS = ['invoice','advance','credit_note','reminder','payment_receipt']`, `kindForInvoice(type): MessageKind`
  - `MAIL_VARIABLE_NAMES`, `renderVariables(text, ctx, extra?: Record<string, string>)`, `validateVariables(text, names?: readonly string[])`
  - `getEmailTemplate(ownerId, kind, language): { subject; body }`, `saveEmailTemplate(actor, raw)`, `resetEmailTemplate(actor, kind, language)`
  - `composeMail(ownerId, invoiceId, kind, override?: { subject; body }): MailDraft`, `MailDraft = { to: string[]; cc: string[]; bcc: string[]; subject; body; attachmentName }`
  - `mailRecipients(ownerId, row): string[]` **[R-24]**

`email_template`: `id`, `user_id` (cascade), `kind`, `language`, `subject`, `body`, `updated_at`, unikátní `(user_id, kind, language)`.

Spec: MAIL-002, MAIL-003, MAIL-007, REC-024, SEC-011, TPL-004. Viz **[R-22]**, **[R-23]**. Výchozí texty pro všech 5 druhů v `cs` i `en` jsou v `defaults.ts`. Řádek v databázi je jen vlastní úprava, smazání vrací výchozí. Proměnné jdou jedním průchodem, hodnota `{{rok}}` od zákazníka se dál nerozvine. Neznámá proměnná je chyba při uložení s jejím názvem. Předmět nad 200 znaků nebo s koncem řádku je odmítnutý, tělo do 10 000 znaků. Částky jsou formátované `formatMoney` a `{{zbyva}}` používá `amountDue`, datum `dateFormat` dokladu. Faktura má vlastní jazyk, UI zůstává česky. Výchozí texty neobsahují odkaz na potvrzení přijetí.

- [ ] **Step 1: Napiš testy**

```ts
test('[MAIL-002] předvyplnění je v jazyce faktury s dosazenými proměnnými', ...)
test('[MAIL-003] každý z 5 druhů jde upravit v obou jazycích a vrátit na výchozí', ...)
test('[MAIL-003] neznámá proměnná je odmítnutá s názvem', ...)
test('[REC-024] {{mesic_nazev}} v anglické faktuře je July', ...)
test('{{zbyva}} je jen v e-mailu, v dokladu zůstává text', ...)
test('[SEC-011] jméno zákazníka s {{rok}} a <script> zůstane doslova', ...)
test('[MAIL-007] výchozí texty neobsahují sledování ani potvrzení přijetí', ...)
test('[TST-009] izolace šablon e-mailů', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/email-templates.test.ts tests/unit/template-vars.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci `--name email_template`, služby a stránku.
- [ ] **Step 4: Ověř:** stejné testy PASS, `timeout 170 pnpm exec vitest run tests/backend/users.test.ts tests/backend/invoices-issue.test.ts`, PASS.
- [ ] **Step 5: Commit** `feat(mail): add editable email templates`

---

### Task 6: Fronta odeslání a archiv PDF

**Files:**
- Create: `drizzle/0023_email_log.sql`, `src/lib/smtp-errors.ts`, `src/server/services/invoice-mail.ts`, `src/server/services/mail-delivery.ts`, `src/app/(app)/faktury/[id]/odeslani/[logId]/route.ts`, `tests/helpers/fixtures-mail.ts`
- Modify: `src/server/db/schema/mail.ts`, `src/server/db/schema/file.ts`, `src/server/services/files.ts`, `src/server/services/users.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/scheduler/start.ts`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `tests/helpers/consistency.ts`
- Test: `tests/backend/mail-delivery.test.ts`, `tests/backend/invoice-mail.test.ts`, `tests/unit/smtp-errors.test.ts`

**Interfaces:**
- Consumes: `enqueue`, `registerJob`, `RetryLater`, `kickWorker`, `resolveTransport`, `composeMail`, `invoicePdf`, `automaticSendAllowed`, `notify`
- Produces:
  - `EMAIL_STATUSES = ['queued','sending','sent','failed','unknown','held','cancelled']`, `SENDABLE_STATUSES = ['issued','sent','partially_paid','paid']`
  - `classifySmtpError(error: unknown): 'retry' | 'permanent' | 'ambiguous'`
  - `sendInvoice(actor, invoiceId, raw: SendInput): { logId: string }`, `SendInput = { requestId; to; cc; bcc; subject; body }`
  - `queueMail(tx: Tx, audit, input: QueueInput): { logId: string } | null`, `QueueInput = { userId; invoiceId; kind; trigger: 'manual'|'automatic'|'bulk'; key: string; message; plannedFor?: CalendarDate; automation?: AutomationKey }`
  - `deliverMail(job: Job): Promise<void>`, `recoverMail(job: Job): void`
  - `listEmailLog(ownerId, invoiceId)`, `archivedPdf(actor, logId): { data; fileName }`, `resendFromLog(actor, logId, opts: { confirmedUnknown: boolean; requestId }): { logId }`
  - `archiveSentPdf(actor, logId, data: Buffer, name: string)` v `files.ts`
  - `applySent(tx, userId, invoiceId)` v `invoice-lifecycle.ts`

`email_log`: `id`, `user_id`, `invoice_id` (cascade), `kind`, `trigger`, `to`, `cc`, `bcc` (JSON), `subject`, `body`, `status`, `reason`, `file_id` (set null), `invoice_revision`, `planned_for`, `automation`, `attempts`, `message_id`, `created_at`, `sent_at`, `updated_at`. Index `(user_id, invoice_id, created_at)`. Unikátní částečný `(invoice_id, kind) WHERE status IN ('queued','sending')`, ruční SQL v migraci, pokud ho `drizzle-kit` nevygeneruje. `email_log` je v `USER_OWNED_TABLES` před `invoice` a `file`.

Spec: MAIL-004, 005, 006, 007, PDF-010, INV-005, REC-013, REC-032, TST-005, SEC-001, AUD-001, MON-003. Viz **[R-1]**, **[R-2]**, **[R-3]**, **[R-4]**, **[R-30]**.

Jeden pokus doručení má tvrdý limit pod 120 s (timeouty SMTP i renderu PDF), aby nepřečkal lease a obnova nesáhla na běžící úlohu.

Doručení, kroky jdou v tomto pořadí a každý je samostatná transakce:

1. **Kontrola:** záznam je `queued`, doklad v `SENDABLE_STATUSES`, stejná revize, jakou má záznam. U `automatic` navíc `automaticSendAllowed` a `today − planned_for ≤ 3` (REC-032). Nesplněné dává `held` s důvodem a upozorněním, úloha je hotová.
2. **Archiv:** bez `file_id` vyrenderuj `invoicePdf` a ulož přes `archiveSentPdf`, který zapíše blob, řádek `file` s druhem `sent_pdf` a vazbu v jedné transakci. Opakovaný pokus PDF znovu neskládá. Plný disk tu spadne před SMTP a spotřebuje pokus.
3. **`sending`:** zapiš stav a `attempts`. Až teď smí proběhnout SMTP.
4. **SMTP:** příloha z archivu, stabilní `messageId` `<logId@doména odesílatele>`.
5. **Výsledek přes `mutate`:** `sent` (`mail.sent`, `applySent`, `resolveNotification`), `queued` a `RetryLater` při `retry`, `failed` při `permanent` nebo posledním pokusu, `unknown` při `ambiguous`. Každý konečný stav jiný než `sent` zakládá upozornění.

`recoverMail`: záznam ve stavu `sending` přejde na `unknown` s upozorněním a úloha končí. Záznam `queued` se vrátí do fronty. Výjimka po kroku 3, třeba při selhání zápisu výsledku, nikdy nevede k novému pokusu: `deliverMail` ji převede na `unknown` a záznam v jiném stavu než `queued` úlohu rovnou ukončí. Tím je pád kdekoli mezi kroky 3 a 5 ošetřený bez druhé zprávy.

Pravidla:
- `requestId` z dialogu tvoří klíč `mail:<requestId>`, dvojklik nebo opakování akce založí jedno odeslání. Částečný unikátní index odmítne druhé paralelní odeslání stejného druhu: `sendInvoice` textem z `TEXTS`, `queueMail` vrátí `null` při obsazeném klíči i při běžícím odeslání.
- `sendInvoice` vyžaduje `SENDABLE_STATUSES`, dostupné SMTP, 1 až 20 příjemců, platné adresy, rate limit `sendUser`. Audit `invoice.send` nese počet příjemců a předmět.
- Klasifikaci ověř proti skutečnému chování `nodemailer` 10 přes testovací server, balíček je sbalený v `dist` a vlastnosti chyby nesmí vycházet z paměti. Text odpovědi se ukládá do `reason` oříznutý na 200 znaků.
- Částečné odmítnutí příjemců je `sent` s výpisem v `reason` a upozorněním.
- `deactivateUser` převede `queued` záznamy účtu na `cancelled` ve své transakci **[R-21]**.
- `FILE_KINDS` získá `sent_pdf`. `storeFile` zůstává jen pro obrázky a `archiveSentPdf` ověří hlavičku `%PDF-`. Sloupec `kind` nemá `CHECK`, migrace se ho netýká.
- Trasa archivu vrací `attachment`, `nosniff`, cizí 404, rate limit `pdfUser` a audit `invoice.pdf_download` s příznakem archivu.
- `assertConsistent` přidá: každý `sent` má archiv, žádný záznam nezůstal `sending` bez běžící úlohy, doklad s `sent` záznamem kindu faktury není `issued`.

- [ ] **Step 1: Napiš testy**

```ts
test('[TST-005] zpráva má příjemce, kopie, předmět, text a přílohu PDF', ...)
test('[PDF-010] archivované PDF je bajt od bajtu příloha a pozdější úprava ho nezmění', ...)
test('[MAIL-006] historie ukáže čas, příjemce, předmět, výsledek a archiv', ...)
test('[MAIL-004] vystavení ani uložení nepošle nic', ...)
test('[MAIL-005] 421 se opakuje a po 3 opakováních je failed s důvodem, spojení právě 4', ...)
test('[MAIL-005] 550 je trvalé selhání bez opakování', ...)
test('[REC-013] selhání nechá doklad vystavený a založí upozornění', ...)
test('[INV-005] úspěšné odeslání nastaví stav odeslaná', ...)
test('[MAIL-007] zpráva je prostý text bez HTML, pixelu a Disposition-Notification-To', ...)
test('[REC-032] automatické odeslání starší 3 dnů se zadrží', ...)
test('zrušený doklad, změněná revize a vypnutá automatika ve frontě dají held a SMTP nic nedostane', ...)
test('přerušení při DATA je unknown a druhé spojení nenastane', ...)
test('recover ze sending je unknown, z queued nový pokus', ...)
test('stejný requestId odešle jednu zprávu, souběžný druhý požadavek je odmítnutý', ...)
test('[SEC-001] odesílání je omezené a překročení je v auditu', ...)
test('[SEC-001] cizí uživatel dostane na archiv 404', ...)
test('[TST-009] izolace historie odeslání', ...)
test('[MON-003] pád při skládání PDF je hlášený, selhání SMTP klienta ne', ...)
test('skutečný tok doručí Cc a Bcc z transport.identity', ...) // send identitu sám nepřidává
test('jedno odeslání dodrží celkový strop času i na zablokovaném serveru', ...) // instanční transport nemá limity vlastního SMTP
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/mail-delivery.test.ts tests/backend/invoice-mail.test.ts tests/unit/smtp-errors.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci `--name email_log`, klasifikaci a kroky doručení v uvedeném pořadí. `registerJob('mail.send', …)` v `start.ts`.
- [ ] **Step 4: Ověř:** stejné testy, `tests/backend/consistency.test.ts tests/backend/files.test.ts`, PASS.
- [ ] **Step 5: Commit** `feat(mail): add reliable invoice delivery with pdf archive`

---

### Task 7: Odeslání z faktury a hromadně

**Files:**
- Create: `src/components/invoices/send-dialog.tsx`, `src/components/invoices/email-history.tsx`, `src/components/invoices/bulk-send-dialog.tsx`, `tests/e2e/send.spec.ts`
- Modify: `src/app/(app)/faktury/actions.ts`, `src/app/(app)/faktury/[id]/page.tsx`, `src/components/invoices/invoice-actions.tsx`, `src/components/invoices/invoice-form.tsx`, `src/components/invoices/version-list.tsx`, `src/components/invoices/invoice-table.tsx`, `src/server/services/invoice-mail.ts`, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/backend/invoice-actions.test.ts`
- Test: `tests/e2e/send.spec.ts`, `tests/backend/invoice-mail.test.ts`

**Interfaces:**
- Consumes: `sendInvoice`, `composeMail`, `listEmailLog`, `resendFromLog`, `mailAvailability`, `MAX_BULK_DOCUMENTS`
- Produces:
  - actions `sendPrefillAction`, `sendInvoiceAction`, `resendFromLogAction`, `bulkSendPreviewAction`, `bulkSendAction`
  - `bulkSendPreview(actor, ids): { ready: { id; number; customer; to: string[] }[]; skipped: { id; number; reason }[] }`
  - `bulkSend(actor, ids, requestId): { queued: number; skipped: number }`

Spec: MAIL-001 **[částečně]** **[R-31]**, MAIL-008, INV-020, INV-024 **[částečně]**, SET-053, SEC-001, SEC-002, UI-009.

Pravidla:
- Tlačítko „Odeslat klientovi“ je v `InvoiceActions` pro každý stav ze `SENDABLE_STATUSES`. Dialog má příjemce, kopii, skrytou kopii, předmět, text a název přílohy, předvyplněné z `composeMail`. Název přílohy je jen ke čtení, určuje ho `invoicePdf` při doručení. `requestId` vzniká při otevření dialogu.
- Po vystavení `invoice-form.tsx:330` přejde na `/faktury/<id>?vystaveno=1` a detail ukáže nabídku s tlačítkem. Parametr jen otevírá nabídku, nikdy neodesílá. Stejně `?odeslat=1` po úpravě nebo obnovení verze a `resendSuggested` ve formuláři.
- Odeslání je jen ve frontě, UI ukáže „Odesílá se“ a po doručení `router.refresh`. Detail ukáže poslední selhání, `held` a `unknown` s důvodem. `unknown` nabízí ruční odeslání až po potvrzení, že uživatel ví o riziku duplicity.
- `sendInvoice` odmítne doklad s nevyřešeným `unknown` stejného druhu textem `E.unknownPending`, dokud nepřijde `confirmedUnknown: true`. Dialog to zjistí přes `hasUnresolvedUnknown` už při otevření a nabídne výslovné potvrzení rizika duplicity. Bez potvrzení neodesílá.
- `resendFromLog` se volá jen přes tento dialog, nikdy jedním klikem z historie: dialog ukáže příjemce a předmět záznamu a u `unknown` žádá stejné potvrzení. `confirmedUnknown` posílá akce jen po tomto potvrzení.
- Bez SMTP je tlačítko vypnuté a vedle něj je vysvětlení SET-053 s odkazem na nastavení, stažení PDF funguje.
- Historie je sekce detailu nad historií změn.
- Hromadně: akce v panelu výběru. Náhled ukáže souhrn příjemců a přeskočené s důvodem (stav, bez adresy, už odesílá se, nejasný výsledek předchozího odeslání). Doklad s `hasUnresolvedUnknown` hromadné odeslání vždy přeskočí, `bulkSend` nikdy neposílá `confirmedUnknown`. Do hromadného odeslání jde jen `issued`. Potvrzení je povinné, server znovu vyhodnotí stav a text je výchozí šablona. Rate limit `sendBulkUser` a `sendUser`, limit `MAX_BULK_DOCUMENTS`. Selhání jednoho dokladu nezastaví ostatní.
- INV-024 čeká na úhradu a export, ID zůstává v pending a MAIL-001 kvůli ISDOC také. Odpovídající testy ID v názvu nenesou.

- [ ] **Step 1: Napiš testy**

```ts
test('tlačítko Odeslat klientovi je na detailu vystavené i odeslané faktury a chybí na konceptu a stornu', ...) // MAIL-001 částečně
test('po vystavení se nabídne odeslání a nic neodejde bez kliknutí', ...) // e2e, smtp.messages prázdné
test('odeslání z dialogu s upraveným předmětem a přílohou PDF', ...) // e2e, kontrola přes TestSmtp
test('skutečné doručení přes frontu v produkčním buildu', ...) // povinné e2e nad next start: klik, worker v instrumentation, render PDF, TestSmtp dostane přílohu, doklad je odeslaný, archiv jde stáhnout
test('dialog při nevyřešeném unknown bez potvrzení neodešle, po potvrzení ano', ...) // e2e
test('hromadné odeslání přeskočí doklad s unknown s důvodem', ...)
test('znovu odeslání z historie jde přes dialog a nic neodejde bez potvrzení', ...) // e2e
test('[INV-020] po úpravě odeslané faktury se nabídne opětovné odeslání a nic neodejde', ...)
test('resendSuggested po obnovení verze otevře nabídku, ne odeslání', ...)
test('[SET-053] bez SMTP dialog vysvětlí nedostupnost a PDF jde stáhnout', ...) // e2e
test('[MAIL-008] souhrn příjemců ukáže přeskočené a vyžaduje potvrzení', ...)
test('[MAIL-008] hromadné odeslání 3 dokladů pošle 3 zprávy a přeskočí koncept', ...)
test('[MAIL-006] detail ukáže historii a archiv jde stáhnout', ...) // e2e
test('[SEC-002] akce pošty odmítnou cizí ID', ...)
test('[SEC-006] akce pošty odmítnou neplatnou adresu a předmět s koncem řádku', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/invoice-mail.test.ts tests/backend/actions-isolation.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** akce, dialogy a nabídky.
- [ ] **Step 4: Ověř:** stejné testy PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test send`, `timeout 170 pnpm exec playwright test invoices`, PASS.
- [ ] **Step 5: Commit** `feat(mail): add send dialog, resend offer and bulk sending`

---

### Task 8: Výpočet plánů

**Files:**
- Create: `src/lib/recurrence.ts`, `src/lib/czech-holidays.ts`
- Modify: `stryker.config.json`, `src/lib/invoice.ts` (jen je-li potřeba sdílet `addDays`)
- Test: `tests/unit/recurrence.test.ts`, `tests/unit/recurrence.property.test.ts`, `tests/unit/czech-holidays.test.ts`

**Interfaces:**
- Consumes: `CalendarDate`, `addDays`, `VariablePeriod`, `renderVariables`
- Produces:
  - `RECURRENCE_FREQUENCIES = ['weekly','monthly','quarterly','half_yearly','yearly','every_weeks','every_months']`
  - `ISSUE_RULES = ['day','period_end','first_working_day','last_working_day']`
  - `type RecurrenceRule = { frequency; every: number; issueRule; issueDay: number | null; startsOn; endsOn: CalendarDate | null; maxCount: number | null; periodOffset: number }`
  - `type Occurrence = { index: number; periodKey: string; issueDate: CalendarDate; schedulePeriod: VariablePeriod; billedPeriod: VariablePeriod }`
  - `occurrencesBetween(rule, after: CalendarDate | null, through: CalendarDate): Occurrence[]`
  - `nextOccurrences(rule, after: CalendarDate | null, count: number): Occurrence[]`
  - `validateRule(rule): string[]`
  - `isWorkingDay(date)`, `easterSunday(year)`, `czechHolidays(year)`

Spec: REC-001, 002, 003, 006, 020, 021, 023, 024, TST-007, TST-012, TST-013. Viz **[R-16]**, **[R-17]**, **[R-18]**.

Pravidla:
- Vše jsou čisté funkce nad `CalendarDate`, žádný `Date` s časem, takže letní čas se nemůže projevit výpočtem. Přechod času se ověřuje na hranici tick úlohy v Task 9.
- `periodKey` je `schedulePeriod.from`. `billedPeriod` je plánovací období posunuté o `periodOffset` období, záporné jde do minulosti.
- Termíny před `startsOn` a po `endsOn` se nepočítají, ale `index` čísluje jen termíny od začátku, takže `maxCount` je přesný.
- `every` je 1 pro pevné četnosti, 1 až 52 pro `every_weeks` a 1 až 24 pro `every_months`. `issueDay` je 1 až 31, u týdenních 1 až 7, jinde `null`. `periodOffset` je -12 až 12. Omezené rozsahy zaručí konec každého cyklu.
- Stryker mutuje `recurrence.ts` a `czech-holidays.ts`.

- [ ] **Step 1: Napiš testy**

```ts
test.each(FREQUENCIES)('[REC-001] %s dá očekávaných 6 termínů', ...)
test('[REC-002] 31. v únoru je poslední únorový den, v přestupném 29.', ...)
test('[REC-002] poslední den čtvrtletí, první a poslední pracovní den', ...)
test('[REC-002] první pracovní den ledna přeskočí Nový rok a víkend', ...)
test('[REC-003] konec datem a počtem, bez konce', ...)
test('[REC-006] období se počítá z kalendářních dat bez závislosti na TZ procesu', ...) // TZ=UTC i America/New_York
test('[REC-020] faktura za {{ctvrtleti}}. čtvrtletí {{rok}} dá 3. čtvrtletí 2026', ...)
test('[REC-021] vystavení 1. 10. s posunem -1 fakturuje 3. čtvrtletí', ...)
test('[REC-021] posun přes hranici roku', ...)
test('[TST-007] přelom roku, čtvrtletí, 31. den a týden s přechodem času', ...)
test('[TST-012] termíny rostou, periodKey je unikátní a datum leží v období', ...) // fast-check
test('[TST-012] pokračování od after dá stejnou posloupnost jako celý výpočet', ...)
test('Velikonoce 2024 až 2030 odpovídají tabulce', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/recurrence tests/unit/czech-holidays.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** rozhraní, přidej soubory do `stryker.config.json`.
- [ ] **Step 4: Ověř:** PASS, `timeout 170 pnpm exec stryker run --mutate src/lib/recurrence.ts`, aspoň 90 %. Když se běh do limitu nevejde, spusť po rozsazích řádků (`--mutate src/lib/recurrence.ts:1-120`).
- [ ] **Step 5: Commit** `feat(recurring): add schedule calculation`

---

### Task 9: Pravidelné faktury: služba a běh

**Files:**
- Create: `src/server/db/schema/recurring.ts`, `drizzle/0024_recurring.sql`, `src/server/services/recurring.ts`, `src/server/services/recurring-run.ts`
- Modify: `src/server/db/schema/invoice.ts`, `src/server/db/schema/index.ts`, `src/server/services/invoices.ts`, `src/server/services/invoice-lifecycle.ts`, `src/server/services/invoice-document.ts`, `src/server/services/invoice-templates.ts`, `src/server/services/users.ts`, `src/server/scheduler/start.ts`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `tests/helpers/consistency.ts`
- Test: `tests/backend/recurring.test.ts`, `tests/backend/recurring-run.test.ts`, `tests/backend/recurring-outage.test.ts`

**Interfaces:**
- Consumes: `occurrencesBetween`, `nextOccurrences`, `validateRule`, `validateVariables`, `TemplateDocument`, `enqueue`, `registerTickTask`, `registerJob`, `queueMail`, `composeMail`, `automaticSendAllowed`, `notify`
- Produces:
  - `RECURRING_MODES = ['draft','issue','send']`, výchozí `draft`
  - `createDraftIn(tx, audit, userId, input: ParsedDraft, extra?: { recurringId; periodFrom; periodTo }): SavedDraft`
  - `issueIn(tx, audit, userId, id, opts): { id; number }`, `issueInvoice` je tenký obal
  - `draftInputFromDocument(ownerId, document, customerId, dates): DraftInput`, sdílený s `draftFromTemplate`
  - `saveRecurring(actor, raw): { id }`, `deleteRecurring(actor, id)`, `getRecurring(ownerId, id)`, `listRecurring(ownerId)`, `listRuns(ownerId, id)`, `recurringFromTemplate(actor, templateId): { id }`
  - `pauseRecurring(actor, id)`, `resumeRecurring(actor, id)`
  - `previewRecurring(ownerId, raw, count = 12): { issueDate; billedPeriod; texts }[]`
  - `planRecurringRuns(now: Date): void` (tick), `processOccurrence(ownerId, recurringId, occurrence): RunResult` (úloha `recurring.run`)
  - `markMissed(tx, audit, plan, today)`, `resolveMissed(actor, runId, action: 'draft'|'skip'): { invoiceId: string | null }`
  - `planRecurringNotices(now: Date): void` (REC-012)

Datový model:

| Tabulka | Sloupce |
|---|---|
| `recurring_invoice` | `id`, `user_id`, `name`, `customer_id` (set null), `document` (JSON `TemplateDocument`), `frequency`, `every`, `issue_rule`, `issue_day`, `starts_on`, `ends_on`, `max_count`, `period_offset`, `mode`, `notify_days_before`, `status` (`active`,`paused`,`finished`), `cursor_date`, `send_confirmed_at`, `created_at`, `updated_at` |
| `recurring_run` | `id`, `user_id`, `recurring_id` (cascade), `period_key`, `planned_date`, `period_from`, `period_to`, `status` (`created`,`issued`,`queued`,`fallback`,`missed`,`skipped`), `invoice_id` (set null), `reason`, `created_at`; unikátní `(recurring_id, period_key)` |
| `invoice` nově | `recurring_id` (set null), `period_from`, `period_to` |

Spec: REC-005, 007, 010, 011, 012, 013, 014, 021, 023, 030, 031, 032, TPL-004, ADM-005, AUD-002, TST-007, TST-010. Viz **[R-6]**, **[R-9]**, **[R-14]**, **[R-15]**, **[R-18]**, **[R-19]**, **[R-20]**, **[R-21]**.

Pravidla:
- **Plánování v ticku** běží pro aktivní plány účtů bez `banned`, po `send_time` účtu. V jedné transakci vezme termíny v `(cursor_date, dnes]`: staré do 3 dnů dostanou úlohu s klíčem `recurring:<id>:<periodKey>`, starší běh `missed` s upozorněním, `cursor_date` se posune. Dokud není `send_time`, je horní mez včerejšek. Bez dalšího termínu je plán `finished`.
- **`processOccurrence` je jedna transakce:** vloží `recurring_run` s `onConflictDoNothing`, a když nic nevložil, skončí. Tím REC-030 stojí na unikátním indexu, ne na lease. Pak `createDraftIn` s datem z plánu, období z výskytu, splatnost `issueDate + dueDays`, účet přes `usableAccountId`.
- **Efektivní režim:** `paused` dává u `issue` i `send` koncept, `send` s vypnutou `recurringSend` dává koncept, obojí s upozorněním **[R-6]**. `issue` a `send` jdou přes `issueIn` v `tx.transaction` (savepoint). `ServiceError` savepoint vrátí, běh je `fallback` a upozornění jmenuje problémy.
- **`send`:** `queueMail` s `trigger: 'automatic'`, `automation: 'recurringSend'`, `plannedFor: occurrence.issueDate`, klíč `mail:recurring:<runId>`. Zpráva přebírá `to`, `cc` a `bcc` z `composeMail`, jinak stálé kopie neodejdou. Zákazník bez adresy: faktura zůstane vystavená, upozornění.
- `saveRecurring` odmítne `mode: 'send'` bez zapnuté `recurringSend` a bez `confirmSend: true`, potvrzení uloží do `send_confirmed_at` (REC-011). Validuje `validateRule` a `validateVariables` všech textů. `{{cislo_faktury}}` a `{{zakaznik}}` jsou povolené. Nový plán dostane `cursor_date = max(startsOn, dnes) − 1 den` **[R-18]**, úprava kurzor nemění.
- `variablesFor` čte `periodFrom` a `periodTo` z řádku **[R-15]**, stejně náhled, `issuedTexts` i `composeMail`. `duplicateInvoice` a `saveDraft` je nekopírují ani nepřepisují. Úprava data konceptu období nezmění, REC-023.
- **Pauza a reaktivace:** `pauseRecurring` kurzor nechá. `resumeRecurring` a `reactivateUser` (pro každý aktivní plán účtu) volají `markMissed`, který minulé termíny zapíše jako `missed` a kurzor nastaví na včerejšek. Upozornění je jedno na plán s počtem.
- **Změna `startsOn`** u „každých N“ posouvá bloky a tím `period_key`, takže unikátní index duplicitu nezachytí. `saveRecurring` nesmí dovolit, aby vznikl termín pro období překrývající se s už existujícím `recurring_run`.
- **`maxCount` se počítá od prvního termínu po založení plánu**, ne od `startsOn`: `index` z výpočtu počítá od začátku plánu, takže plán se začátkem v minulosti musí odečíst termíny před založením **[R-18]**.
- Proměnné čtou měsíc, čtvrtletí, pololetí a rok z `billedPeriod.from`. U bloku přes hranici čtvrtletí nebo roku tedy platí začátek bloku; Task 10 to řekne v nápovědě formuláře.
- `resolveMissed('draft')` jde přes `processOccurrence` s vynuceným konceptem a stejným `recurring_run`, status přepíše. Automatika k němu nikdy nesáhne.
- REC-012: `notify_days_before` u `send` založí upozornění a úlohu `user.notice` s klíčem `notice:<id>:<periodKey>`, zpráva jde jen na e-mail účtu **[R-27]**.
- `assertConsistent` přidá: `recurring_run.invoice_id` vede na vlastní doklad, na jeden `(recurring_id, period_key)` nejvýš jedna faktura.

- [ ] **Step 1: Napiš testy**

```ts
test('[REC-010] nový plán je koncept, režim vystavit dá číslo, nic neodejde', ...)
test('[REC-011] režim odeslat bez zapnuté automatiky a bez potvrzení je odmítnutý', ...)
test('[REC-030] druhý běh stejného období nic nevytvoří', ...)
test('[REC-030] 8 souběžných běhů stejného termínu dá jednu fakturu a jedno číslo', ...) // worker
test('[REC-031] 3 dny starý termín doběhne, 4 dny starý je missed a nabídne se', ...)
test('[REC-032] zmeškaný termín v režimu odeslat nic nepošle', ...)
test('[REC-023] běh se 2 dny zpožděním dá období z plánu', ...)
test('[REC-021] koncept z plánu ukáže v náhledu i po pozdním vystavení posunuté období', ...)
test('[REC-007] vypnutá automatika v termínu dá koncept bez čísla a upozornění', ...)
test('[REC-007] hlavní vypínač dá koncept i u režimu vystavit', ...)
test('[REC-007] po opětovném zapnutí se koncept sám nevystaví ani neodešle', ...)
test('[REC-005] obnovení ukáže zmeškané ke kontrole a nic nevytvoří', ...)
test('[REC-012] upozornění N dní předem jde jen uživateli', ...)
test('[REC-013] selhání odeslání nechá fakturu vystavenou a run queued s upozorněním', ...)
test('[REC-014] faktura odkazuje na plán a plán ji má v seznamu', ...)
test('[REC-004] náhled 12 termínů s vygenerovanými popisy', ...)
test('[REC-022] neznámá proměnná je chyba při uložení', ...)
test('[REC-003] počet se u plánu se začátkem v minulosti počítá od prvního termínu po založení', ...)
test('[REC-030] změna začátku u každých N nevytvoří druhou fakturu za stejné období', ...)
test('[ADM-005] deaktivovaný účet nic nevytvoří, po reaktivaci jsou termíny missed', ...)
test('[TST-007] tick těsně před a po send_time v den přechodu času', ...)
test('chybějící zákazník a cizí měna bez kurzu spadnou na koncept bez spotřeby čísla', ...)
test('úprava šablony nezmění plán', ...)
test('[TST-009] izolace plánů a běhů včetně update a remove', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/recurring`, FAIL.
- [ ] **Step 3: Refaktoruj** `saveDraft` a `issueInvoice` na `createDraftIn` a `issueIn` beze změny chování. Ověř `timeout 170 pnpm exec vitest run tests/backend/invoices tests/backend/invoice-templates.test.ts`, PASS, a commitni `refactor(invoices): split draft and issue into transaction steps`.
- [ ] **Step 4: Implementuj** schéma, migraci `--name recurring`, služby a tick úlohy.
- [ ] **Step 5: Ověř:** `timeout 170 pnpm exec vitest run tests/backend/recurring tests/backend/users.test.ts tests/backend/consistency.test.ts`, PASS.
- [ ] **Step 6: Commit** `feat(recurring): add recurring invoice runs`

---

### Task 10: Pravidelné faktury: rozhraní

**Files:**
- Create: `src/app/(app)/pravidelne/actions.ts`, `src/app/(app)/pravidelne/nova/page.tsx`, `src/app/(app)/pravidelne/[id]/page.tsx`, `src/components/recurring/recurring-form.tsx`, `src/components/recurring/recurring-list.tsx`, `src/components/recurring/schedule-preview.tsx`, `src/components/recurring/run-list.tsx`, `src/components/recurring/variable-picker.tsx`, `tests/e2e/recurring.spec.ts`
- Modify: `src/app/(app)/pravidelne/page.tsx`, `src/components/nav.ts`, `src/proxy.ts`, `src/app/(app)/faktury/[id]/page.tsx`, `src/components/invoices/template-list.tsx`, `src/lib/texts.ts`, `tests/backend/actions-isolation.test.ts`, `tests/e2e/shell.spec.ts`
- Test: `tests/e2e/recurring.spec.ts`

**Interfaces:**
- Consumes: služby z Task 9, `line-editor.tsx`, `customer-picker.tsx`
- Produces: actions `saveRecurringAction`, `previewRecurringAction`, `pauseRecurringAction`, `resumeRecurringAction`, `deleteRecurringAction`, `resolveMissedAction`, `recurringFromTemplateAction`

Spec: REC-001 až 005, 010, 011, 012, 014, 022, UI-007, UI-009, SEC-002. Navigace spec 20: `recurring` přestává být `planned`. `/pravidelne/nova` a `/pravidelne/[id]` jdou do proxy tak, aby cizí ID vrátilo 404 před vykreslením, stejně jako `DETAIL`.

Pravidla:
- Formulář: zákazník, položky, texty, měna, splatnost, četnost, den, začátek a konec, posun období, režim, upozornění předem. Volby „Každých N“ a „Konkrétní den“ se zobrazí jen pro relevantní četnost.
- Volba „vystavit a odeslat“ je bez zapnuté automatiky vypnutá s odkazem na Automatizaci. Výběr otevře potvrzení, co a komu odejde.
- Náhled 12 termínů se obnovuje při změně s odstupem, přes `previewRecurringAction`, data počítá jen server.
- Nápověda u proměnných říká, že měsíc, čtvrtletí, pololetí a rok se berou ze začátku fakturovaného období.
- Vkládání proměnných tlačítky do naposledy aktivního textového pole na pozici kurzoru, ovladatelné klávesnicí. Serverová chyba ukáže neznámou proměnnou.
- Seznam ukazuje další termín, režim a stav. Detail ukazuje vydané faktury, běhy a sekci „Ke kontrole“ se zmeškanými termíny.
- Šablona má akci „Vytvořit pravidelnou“. Detail faktury odkazuje na plán.

- [ ] **Step 1: Napiš testy**

```ts
test('[REC-004] změna četnosti obnoví náhled 12 termínů', ...)
test('[REC-005] pozastavení, obnovení a kontrola zmeškaného termínu', ...)
test('[REC-011] výběr vystavit a odeslat vyžaduje potvrzení', ...)
test('[REC-014] detail plánu a faktury se odkazují navzájem', ...)
test('[REC-022] proměnná jde vložit klikem i klávesnicí', ...)
test('čtvrtletní pravidelná faktura od plánu po vystavený doklad s předchozím čtvrtletím', ...) // kritický tok, send_time 00:00
test('vypnutá automatika nepošle pravidelnou fakturu', ...) // TST-016 částečně, viz Task 12
test('[TST-009] cizí plán je 404 a akce ho odmítnou', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm build`, pak `timeout 170 pnpm exec playwright test recurring`, FAIL.
- [ ] **Step 3: Implementuj** stránky, akce a komponenty.
- [ ] **Step 4: Ověř:** `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test recurring`, `timeout 170 pnpm exec playwright test shell`, `timeout 170 pnpm exec vitest run tests/backend/actions-isolation.test.ts`, PASS.
- [ ] **Step 5: Commit** `feat(recurring): add recurring invoices ui`

---

### Task 11: Upomínky a upozornění na splatnost

**Files:**
- Create: `src/server/db/schema/reminder.ts`, `drizzle/0025_reminder.sql`, `src/lib/reminders.ts`, `src/server/services/reminders.ts`, `src/server/services/due-alerts.ts`, `src/components/settings/reminder-rules.tsx`, `src/components/invoices/reminder-panel.tsx`, `src/components/overview/due-alerts.tsx`, `tests/e2e/reminders.spec.ts`
- Modify: `src/server/db/schema/invoice.ts`, `src/server/db/schema/index.ts`, `src/server/services/users.ts`, `src/server/services/customers.ts`, `src/server/services/mail-delivery.ts`, `src/server/scheduler/start.ts`, `src/app/(app)/nastaveni/automatizace/page.tsx`, `src/app/(app)/nastaveni/automatizace/actions.ts`, `src/app/(app)/faktury/actions.ts`, `src/app/(app)/faktury/[id]/page.tsx`, `src/app/(app)/page.tsx`, `src/lib/texts.ts`, `src/lib/audit-labels.ts`, `tests/backend/actions-isolation.test.ts`
- Test: `tests/unit/reminders.test.ts`, `tests/backend/reminders.test.ts`, `tests/backend/due-alerts.test.ts`, `tests/e2e/reminders.spec.ts`

**Interfaces:**
- Consumes: `queueMail`, `composeMail`, `automaticSendAllowed`, `getAutomation`, `registerTickTask`, `registerJob`, `registerDerivedAlerts`, `resolveTransport`, `amountDue`, `isOverdue`
- Produces:
  - `dueStage(input: { invoice; rules; sentStages: string[]; today; openSince }): ReminderRule | null`, čistá funkce
  - `isEligibleForReminder(invoice, customer): boolean`
  - `saveReminderRule(actor, raw): { id }`, `deleteReminderRule(actor, id)`, `listReminderRules(ownerId)`
  - `sendManualReminder(actor, invoiceId, raw: SendInput & { stageKey: string | null; confirmedRepeat: boolean }): { logId }`
  - `snoozeReminders(actor, invoiceId, until: CalendarDate | null)`, `setRemindersOff(actor, invoiceId, off)`, `setPartialReminders(actor, invoiceId, on)`
  - `planReminders(now: Date): void`, `remindersForReview(ownerId, today)`
  - `dueAlerts(ownerId, today): { overdue: AlertRow[]; dueSoon: AlertRow[] }`, `DUE_SOON_DAYS = 3`
  - `planDigests(now: Date): void`, úloha `user.digest`

Datový model:

| Tabulka | Sloupce |
|---|---|
| `reminder_rule` | `id`, `user_id`, `position`, `offset_days` (záporné před splatností), `texts` (JSON `{ cs?, en? }` s předmětem a textem, null = šablona `reminder`), `created_at`, `updated_at`; unikátní `(user_id, offset_days)` |
| `reminder_sent` | `id`, `user_id`, `invoice_id` (cascade), `stage_key`, `trigger`, `email_log_id` (set null), `created_at`; unikátní částečný `(invoice_id, stage_key) WHERE trigger = 'automatic'` |
| `invoice` nově | `reminders_off`, `reminders_snooze_until`, `reminders_partial` |

Spec: REM-001 až 009, CUS-003, UI-011 **[částečně]**, AUD-001, TST-005. Viz **[R-9]**, **[R-10]**, **[R-11]**, **[R-12]**, **[R-13]**, **[R-26]**, **[R-27]**.

Pravidla:
- `dueStage`: datum stupně je `due_date + offset`, s odkladem `max(datum stupně, snooze_until)`. Způsobilý je jen stupeň s datem `> openSince`, `<= today` a nejvýš 3 dny starým. Z několika se vezme nejpozdější a stupeň se přeskočí, když už odešel pozdější, aby upomínky nešly mimo pořadí.
- `isEligibleForReminder`: typ `invoice` nebo `advance`, `amountDue > 0`, stav `sent`, nebo `partially_paid` s `reminders_partial`, bez `reminders_off`, zákazník nemá `remindersEnabled = false`. Stavy `paid`, `cancelled`, `credited` nikdy. Plán 5 teprve vytvoří platby, test nastaví stav přímo.
- `stage_key` je `rule.id` jako text bez cizího klíče, smazání pravidla neotevře dávno poslaný stupeň.
- Tick po `send_time` účtu s otevřenou automatikou. V jedné transakci nejdřív `queueMail` s klíčem `reminder:<invoiceId>:<stageKey>` a `automation: 'reminders'`, teprve po něm `reminder_sent`. Zpráva přebírá `to`, `cc` a `bcc` z `composeMail`, jinak stálé kopie neodejdou. Výsledek `null` znamená konec bez spotřeby stupně, konflikt indexu také. `deliverMail` u druhu `reminder` před SMTP znovu ověří `isEligibleForReminder`, aby upomínka neodešla na doklad uhrazený mezitím. Příloha je aktuální PDF, QR má zbývající částku (QR-006).
- REM-003: ruční upomínka jde z detailu přes stejný dialog `send-dialog.tsx`, vyžaduje `SENDABLE_STATUSES` s `amountDue > 0`. Hlavní vypínač ji neblokuje **[R-4]**, opakování vyžaduje `confirmedRepeat`. Rate limit `sendUser`.
- REM-004: odklad nejvýš dnes + 30, jinak `ServiceError`. Odklad i vypnutí nemění `revision` a netvoří verzi, jsou to organizační údaje jako štítky.
- `remindersForReview` jsou stupně způsobilé podle stavu, ale minulé před `openSince` nebo starší 3 dnů, při existujícím pravidle. Přehled je na stránce Automatizace, do centra jde jeden odvozený souhrn.
- REM-009: `dueAlerts` je zdroj pro `registerDerivedAlerts` a karta na Přehledu nad prázdným stavem, nejvýš 5 řádků s odkazem na filtr. Beze vztahu ke svolení, vždy zapnuté. Plán 7 kartu převezme do widgetu.
- Denní přehled: `daily_digest`, klíč `digest:<userId>:<datum>`, `send_time`. Adresát je výhradně `user.email`, úloha nepřijímá adresu v `payload`. Prázdný den nic. Zpráva nemá přílohu a nezapisuje `email_log`, protože nejde klientovi, ale má audit `mail.digest`.
- Oprav zastaralý komentář v `src/server/services/customers.ts:319` podle **[R-12]**.

- [ ] **Step 1: Napiš testy**

```ts
test('[REM-001] bez zapnutí neodejde nic, ani s pravidly a dlužnými fakturami', ...)
test('[REM-002] stupně před i po splatnosti s vlastním textem', ...)
test('[REM-003] ruční upomínka z faktury', ...) // e2e
test('[REM-004] odklad o 30 dní projde, o 31 je odmítnutý, stupeň odejde po odkladu', ...)
test('[REM-004] vypnutí na faktuře zastaví stupně', ...)
test('[REM-005] vypnutí na zákazníkovi blokuje a true nepřebije vypnutou automatiku', ...)
test('[REM-006] uhrazená a stornovaná nikdy, částečná jen po zapnutí se zbývající částkou', ...)
test('[REM-007] 8 souběžných ticků pošle stupeň jednou', ...)
test('[REM-008] odchází po nastaveném čase, výchozí 9:00', ...)
test('[REM-009] po splatnosti a blížící se splatnost jsou v centru i na Přehledu', ...) // e2e
test('[REM-009] denní e-mail je vypnutý a jde jen uživateli, nikdy klientovi', ...)
test('zapnutí upomínek nepošle nic na staré dluhy, zůstanou ke kontrole', ...)
test('hlavní vypínač zapnutý a vypnutý v jeden den dnešní stupeň neuvolní', ...)
test('upomínka na stav vystavená bez odeslání automaticky neodejde', ...)
test('stupně neodejdou mimo pořadí po výpadku', ...)
test('[TST-009] izolace pravidel a upomínek včetně update a remove', ...)
test('[SEC-002] akce upomínek odmítnou cizí ID', ...)
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/unit/reminders.test.ts tests/backend/reminders.test.ts tests/backend/due-alerts.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** schéma, migraci `--name reminder`, službu, tick úlohy a UI.
- [ ] **Step 4: Ověř:** stejné testy a `tests/backend/users.test.ts tests/backend/actions-isolation.test.ts` PASS, `timeout 170 pnpm build`, `timeout 170 pnpm exec playwright test reminders`.
- [ ] **Step 5: Commit** `feat(reminders): add reminders and due alerts`

---

### Task 12: Odolnost, obraz a uzavření plánu

**Files:**
- Create: `tests/helpers/crash-worker.mjs`, `tests/backend/resilience.test.ts`, `tests/backend/silence.test.ts`, `tests/e2e/docker-scheduler.spec.ts`
- Modify: `tests/helpers/run-workers.ts`, `tests/e2e/fixtures.ts`, `.github/workflows/ci.yml`, `README.md`, `.env.example`, `tests/spec-pending.txt`, `stryker.config.json`
- Test: `tests/backend/resilience.test.ts`, `tests/backend/silence.test.ts`, `tests/e2e/docker-scheduler.spec.ts`

**Interfaces:**
- Consumes: všechny služby tohoto plánu, `runAllocateWorkers`, `TestSmtp`
- Produces: `runCrashWorker(input: { databasePath; dataDir; smtpPort; killAt: CrashPoint }): Promise<void>`, `CrashPoint = 'after_sending' | 'after_smtp' | 'in_run_tx'`

Spec: TST-005, TST-016 **[částečně]**, TST-017, TST-018, MAIL-004, OPS-004, ADM-005.

Pravidla:
- `crash-worker.mjs` staví na hácích `allocate-worker.mjs`, ale je to `child_process.fork`, aby šel skutečný `SIGKILL`. Designy jsou JSX a stub je neumí vykreslit, proto test zakládá záznam s hotovým archivem a krok skládání přeskočí.
- `killAt` je řízený proměnnou prostředí jen v testovacím hácku, ne v produkčním kódu. Po smrti procesu test zavolá `tick()` s novým držitelem po vypršení lease a kontroluje `TestSmtp.messages`, stav dokladu a `assertConsistent`.
- Maticí ticha je `tests/backend/silence.test.ts`: pro každou dostupnou automatiku × (vypnutá, hlavní vypínač, deaktivovaný účet, doběh po výpadku, zmeškaný termín) posouvá hodiny přes 40 dní a kontroluje, že `TestSmtp.messages` je prázdné pro adresu klienta. Nedostupné automatiky čekají na plány 5 a 6, TST-016 zůstává v pending a test ID v názvu nenese.
- Docker test: `dockerApp` s `SCHEDULER_TICK_SECONDS=1`, `expect.poll` na `scheduler: running`, ověří i `croner` a skutečný `nodemailer` odesláním zkušební zprávy na stub. `freshApp` a `dockerApp` předají `ALLOW_PRIVATE_MAIL_HOSTS=1` jen tam, kde běží testovací SMTP. CI přidá spec do docker běhu.
- `.env.example` obsahuje `SCHEDULER_TICK_SECONDS`, `ALLOW_PRIVATE_MAIL_HOSTS`. README popíše Automatizaci, SMTP a SEC-007.
- `docker build` běží po vrstvách s `timeout 170`: `--target deps`, `--target build`, pak celý obraz. Hotové vrstvy zůstávají v cache, proto přerušený příkaz opakuj. Když krok `pnpm run build` v obraze sám přesáhne limit, nespouštěj ho na pozadí, zapiš do zprávy „Docker neověřen“ a řídící agent to ověří samostatně.
- Z pending vypadnou: ARC-004, ARC-007, ARC-008, MAIL-002 až 008, MON-003, OPS-004, OPS-005, PDF-010, REC-001 až 032, REM-001 až 009, SET-040 až 043, SET-050 až 054, TST-005, TST-007, TST-010, TST-017. Zůstávají: MAIL-001, INV-024, INV-023, SEC-007, UI-011, TST-016, TST-019 a vše z jiných plánů.

- [ ] **Step 1: Napiš testy**

```ts
test('[TST-017] SIGKILL po zápisu sending: žádná zpráva, stav unknown, žádné opakování', ...)
test('[TST-017] SIGKILL po přijetí SMTP: právě jedna zpráva, stav unknown, doklad nevystaven dvakrát', ...)
test('[TST-017] SIGKILL v transakci běhu: žádná faktura, číslo nespotřebované, další tick ji vytvoří jednou', ...)
test('[TST-017] nedostupné SMTP: doklad zůstane, po obnovení se doručí jednou', ...)
test('[TST-017] plný disk při archivu: ENOSPC, nic neodejde, doklad zůstane', ...)
test('[TST-017] plný disk při záloze: stará kopie zůstane', ...)
test('[TST-018] po každém scénáři projde kontrola souladu', ...)
test.each(MATRIX)('automatika %s při %s nepošle klientovi nic', ...) // TST-016 částečně
test('[MAIL-004] žádná akce bez kliknutí nebo automatiky nevede na SMTP', ...)
test('[OPS-004] obraz: plánovač běží a health je ok', ...) // docker-scheduler.spec.ts
```

- [ ] **Step 2: Ověř selhání:** `timeout 170 pnpm exec vitest run tests/backend/resilience.test.ts tests/backend/silence.test.ts`, FAIL.
- [ ] **Step 3: Implementuj** pomůcky a oprav nálezy v kódu. Každá oprava má vlastní test.
- [ ] **Step 4: Ověř po částech:** `timeout 170 pnpm exec vitest run --project unit`, pak `timeout 170 pnpm exec vitest run --project backend --shard=N/4` pro N = 1 až 4, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`.
- [ ] **Step 5: Ověř e2e po souborech:** `timeout 170 pnpm build` a pro každý soubor v `tests/e2e` zvlášť `timeout 170 pnpm exec playwright test <soubor>`, kromě `docker-*`.
- [ ] **Step 6: Ověř obraz** po vrstvách podle pravidla výše, pak `E2E_DOCKER_IMAGE=fakturan-ci timeout 170 pnpm exec playwright test docker-scheduler` a `docker-pdf`.
- [ ] **Step 7: Uzavři:** zmenši `tests/spec-pending.txt`, `pnpm run test:coverage-spec`, PASS. `timeout 170 pnpm exec stryker run --mutate src/lib/czech-holidays.ts`, aspoň 90 %.
- [ ] **Step 8: Commit** `test(scheduler): add crash, silence and image coverage`

---

## Sebekontrola proti spec

| Oblast | Úkol | Poznámka |
|---|---|---|
| SET-040 až 043 | 3 | 2 ze 4 automatik čekají na plány 5 a 6 **[R-7]** |
| SET-050 až 054, SEC-003 | 4 | |
| REC-001 až 003, 006, 020, 021, 023, 024 | 8, 9 | |
| REC-004, 005, 010 až 014, 022 | 9, 10 | |
| REC-007, 030 až 032 | 9, 12 | |
| MAIL-001 | 7 | Bez ISDOC, zůstává v pending **[R-31]** |
| MAIL-002, 003 | 5 | |
| MAIL-004 až 007 | 6, 12 | |
| MAIL-008, INV-024 | 7 | INV-024 čeká na plány 5 a 8 |
| REM-001 až 009 | 3, 11 | |
| PDF-010, INV-005, INV-020 | 6, 7 | |
| ARC-004, 007, 008, TST-010 | 1 | |
| SEC-001, SEC-002, AUD-001, AUD-002 | 1, 2, 4, 6, 7, 11 | Přenos z plánu 1 |
| SEC-007 | 4 | Plné pro SMTP, IMAP je plán 5 |
| MON-003, OPS-004, OPS-005, ADM-005, ADM-008 | 1, 2, 9 | Přenos z plánu 1 |
| UI-011 | 3, 11 | Nespárované platby a avíza plán 5, limity plán 8 |
| TST-005, 007, 016, 017, 018 | 6, 8, 12 | TST-016 pro 2 automatiky v plánech 5 a 6 |
| Přenos z plánu 3 | 6, 7, 9 | Tlačítko, archiv, `resendSuggested`, hromadně, období, šablony |

13 PAY se plánu týká jen stavy `partially_paid` a `paid` v REM-006 a `SENDABLE_STATUSES`. Platby samotné jsou plán 5. Nedotčené zůstávají AUTH, CUS mimo CUS-003 a kap. 14 a dál.

## Přenos do dalších plánů

- **Plán 5:** přepínač potvrzení platby v Automatizaci a odeslání přes `queueMail` s `automation: 'paymentReceipt'`. Šablona `payment_receipt` je hotová. Stavy `partially_paid` a `paid` pro `dueStage` a `REM-006`, hromadné „označit jako uhrazené“, zdroje nespárovaných plateb a avíz do `registerDerivedAlerts` (UI-011). `assertPublicHost` pro IMAP a vyřazení SEC-007 z pending. Úlohy avíz přes `registerTickTask`. `mailparser` přesunout z dev do produkčních závislostí. TST-016 pro novou automatiku.
- **Plán 6:** přepínač odeslání faktury po záloze, TST-016 uzavřít. Kurz ČNB, aby pravidelné faktury v cizí měně nekončily v `fallback`. Šablony `advance` a `credit_note` se začnou používat.
- **Plán 7:** karta `dueAlerts` na Přehledu jako widget, další termíny a stav automatiky na dashboardu. Karta REM-009 nesmí zmizet.
- **Plán 8:** ISDOC příloha v dialogu odeslání a vyřazení MAIL-001. Export uzavře INV-024. Importované doklady nesmí spouštět upomínky bez výslovného zapnutí a `external` musí vstoupit do `isEligibleForReminder`. Záloha účtu (ADM-009) musí zahrnout archivy `sent_pdf`. UI-011 „blížící se limity“ doplnit až po upřesnění, spec je nedefinuje. TST-019 přidá upgrade migrací.
- **Plán 9:** retence a velikost archivů `sent_pdf`, kopie záloh mimo svazek, ukázky nastavení v dokumentaci.
- **ARC-005:** první `use cache` s daty účtu stále chybí, plán 4 ji nezavádí.
- **Známé riziko:** pokus běžící v okamžiku deaktivace účtu doběhne **[R-21]**. `VACUUM INTO` krátce blokuje proces, protože `better-sqlite3` je synchronní, proto běží v noci.
