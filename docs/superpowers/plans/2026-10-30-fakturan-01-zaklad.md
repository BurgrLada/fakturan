# Fakturan 1: Základ – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Běžící aplikace se značkou Fakturan, databází, přihlašováním s pozvánkami, administrací, audit logem a kompletní testovací infrastrukturou, na které staví všechny další části.

**Architecture:** Next.js 16.4 s Cache Components. Doménová logika ve službách v `src/server/services`, které berou explicitní `Actor` a nezávisí na Next.js. SQLite přes Drizzle, každá mutace zapisuje audit ve stejné transakci.

**Tech Stack:** Next.js 16.4, TypeScript strict, Tailwind, shadcn/ui, Drizzle, better-sqlite3, Better Auth, Zod, Vitest, Playwright, oxlint, oxfmt, @sentry/nextjs.

**Spec:** `docs/superpowers/specs/2026-10-30-fakturan-design.md`

## Plán celku

Specifikace je rozdělená na samostatné plány. Každý se píše až po dokončení předchozího, aby vycházel ze skutečného kódu.

| Plán | Obsah (kapitola spec 23) | Stav |
|---|---|---|
| 1 Základ | krok 1 a monitoring | tento dokument |
| 2 Evidence | nastavení, zákazníci, ceník, číselné řady | čeká |
| 3 Faktury | faktury, PDF, QR, designy | čeká |
| 4 Komunikace | e-mail, upomínky, pravidelné faktury, plánovač | čeká |
| 5 Platby | platby, avíza Fio | čeká |
| 6 Doklady | zálohy, opravné a zahraniční faktury | čeká |
| 7 Dashboard | dashboard, přehledy | čeká |
| 8 Data | import, export, daňový přehled | čeká |
| 9 Dokončení | provozní doplňky, dokumentace | čeká |

## Global Constraints

- Node 24, npm, TypeScript strict.
- Práce probíhá na `main`. Nic se nepushuje.
- Commity: Conventional Commits, jen předmět, bez těla a trailerů.
- Komentáře v kódu jen pro neočividné invarianty, UI texty česky.
- Název každého testu obsahuje ID požadavku, např. `test('[AUD-006] ...')`.
- Peníze jako celé číslo v nejmenší jednotce, čas v UTC, aktuální čas jen přes `Clock` (ARC-002 až 004).
- Formát a lint: oxfmt a oxlint, žádný ESLint ani Prettier.
- Žádná externí načítání fontů za běhu, fonty se bundlují.
- Skutečné faktury ani osobní údaje se do repozitáře nedávají.

## Review Focus

1. Dvě souběžné první registrace: administrátor vznikne jen jeden, druhá selže srozumitelnou chybou (Task 6).
2. Přihlášení přes poskytovatele s nepozvaným e-mailem: účet nevznikne a odpověď neprozradí, zda e-mail existuje (Task 6).
3. Vypršelá nebo už použitá pozvánka, otevřená znovu v jiném prohlížeči: odmítnutí s vysvětlením (Task 8).
4. Chybějící nebo krátký `ENCRYPTION_KEY`, nezapisovatelná složka dat: start selže s názvem problému, ne s nečitelným stack trace (Task 3).
5. Deaktivovaný uživatel s otevřenou záložkou: další požadavek ho odhlásí a server action selže (Task 8).

---

### Task 1: Projekt, preset, nástroje

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `src/app/*`, `components.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `LICENSE`, `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: skripty `dev`, `build`, `lint`, `format`, `format:check`, `typecheck`.

- [ ] **Step 1: Commitni stávající stav**

```bash
git add .gitignore .impeccable brand docs
git commit -m "docs: add specification and brand assets"
```

- [ ] **Step 2: Vygeneruj Next.js do prázdné složky mimo repo**

Repo není prázdné, proto generátor běží ve scratchpadu a výsledek se přesune:

```bash
npx create-next-app@latest fakturan --ts --tailwind --app --src-dir --cache-components --import-alias "@/*" --use-npm --disable-git --agents-md
```

Přesuň vše včetně skrytých souborů do repa. Do `.gitignore` sluč výstup generátoru s `.superpowers/`. Přidej `data/`.

- [ ] **Step 3: Odstraň ESLint, pokud ho generátor přidal, a nainstaluj nástroje**

Přidej `oxlint` a `oxfmt` jako devDependencies. Skripty: `lint: oxlint`, `format: oxfmt`, `format:check: oxfmt --check`, `typecheck: tsc --noEmit`.

- [ ] **Step 4: Aplikuj preset**

Run: `npx shadcn@latest init --preset b5aa4wfToO --yes`
Expected: vznikne `components.json` a upravený `src/app/globals.css`.

- [ ] **Step 5: Ověř build a nástroje**

Run: `npm run build && npm run lint && npm run format:check && npm run typecheck`
Expected: vše projde, v `next.config.ts` je `cacheComponents: true`.

- [ ] **Step 6: Přidej `LICENSE` (MIT, Fakturan contributors) a stručný `README.md` a commitni**

```bash
git add -A
git commit -m "chore: scaffold next app with shadcn preset and oxc tooling"
```

### Task 2: Značka a tokeny

**Files:**
- Modify: `src/app/globals.css`, `src/app/layout.tsx`
- Create: `src/app/favicon.ico`, `src/app/icon.svg`, `src/app/apple-icon.png`, `public/brand/logo.svg`, `public/brand/logo-dark.svg`, `public/brand/logo-mono.svg`, `src/components/logo.tsx`, `src/lib/fonts.ts`
- Test: `tests/unit/brand-tokens.test.ts`

**Interfaces:**
- Produces: `<Logo className? />` volí světlou nebo tmavou variantu podle motivu. CSS tokeny shadcn namapované na značku.

Spec: UI-001 až UI-005. Zdroj: `brand/README.md`, `brand/tokens.css`. `brand/` zůstává zdrojem, do běhu se kopírují jen hotové soubory.

Mapování po aplikaci presetu (hodnoty presetu se přepíší, poloměry a styl zůstanou):

| Token shadcn | Světlý | Tmavý |
|---|---|---|
| `--background`, `--card`, `--popover` | `#F7F4EE` | `#1E1A1C` |
| `--foreground`, `--card-foreground`, `--popover-foreground` | `#1E1A1C` | `#F7F4EE` |
| `--primary`, `--ring` | `#652335` | `#C9708A` |
| `--primary-foreground` | `#F7F4EE` | `#1E1A1C` |
| `--accent` | `#E7C469` | `#4D4026` |
| `--accent-foreground` | `#1E1A1C` | `#F7F4EE` |
| `--brand-tile`, `--brand-tile-foreground` | `#C6EC3E`, `#1E1A1C` | stejné |

Tokeny `--secondary`, `--muted`, `--border`, `--input` se odvodí z papíru přes `color-mix` s textem, aby zůstala jediná změna na jednom místě. Zelená `--brand-tile` se nesmí použít jako barva textu.

- [ ] **Step 1: Napiš test**

```ts
test('[UI-001] tokeny značky jsou v globals.css', () => { /* načte soubor, ověří hodnoty z tabulky pro :root i .dark */ })
test('[UI-008] kontrast primary/foreground splňuje WCAG AA v obou režimech', () => { /* spočítá poměr ≥ 4.5 */ })
```

- [ ] **Step 2: Spusť, očekávej FAIL**

Run: `npx vitest run tests/unit/brand-tokens.test.ts` (vitest přidej zde jako dev závislost, konfigurace v Task 3)

- [ ] **Step 3: Přepiš tokeny, zkopíruj ikony a loga, nastav `metadata` a Space Grotesk přes `next/font/local` z `brand/zdroj/fonts/`**

Soubory v `src/app` (`favicon.ico`, `icon.svg`, `apple-icon.png`) přebírá Next.js automaticky. Logo jako `<img>` ze SVG, nepřekreslovat textem.

- [ ] **Step 4: Spusť test, očekávej PASS, a vizuálně zkontroluj světlý i tmavý režim v prohlížeči**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ui): apply fakturan brand tokens, logo and favicon"
```

### Task 3: Konfigurace, databáze, šifrování, hodiny

**Files:**
- Create: `src/server/env.ts`, `src/server/db/index.ts`, `src/server/db/schema/index.ts`, `src/server/db/migrate.ts`, `drizzle.config.ts`, `src/server/crypto.ts`, `src/server/clock.ts`, `.env.example`
- Test: `tests/backend/env.test.ts`, `tests/backend/crypto.test.ts`, `tests/backend/db.test.ts`, `tests/helpers/db.ts`

**Interfaces:**
- Produces:
  - `env: Env` validovaná přes Zod, `parseEnv(source): Env`
  - `db`, `createDb(path: string): Db`, `runMigrations(db: Db): void`
  - `encryptSecret(plain: string): string`, `decryptSecret(blob: string): string`
  - `clock: Clock` (`{ now(): Date }`), `setClockForTests(c: Clock | null): void`
  - `createTestDb(): Db` v `tests/helpers/db.ts`: dočasný soubor s migracemi.

- [ ] **Step 1: Napiš testy**

```ts
test('[OPS-003] chybějící ENCRYPTION_KEY hlásí název proměnné', () => {
  expect(() => parseEnv({ BETTER_AUTH_URL: 'http://x', BETTER_AUTH_SECRET: 'x'.repeat(32) })).toThrow(/ENCRYPTION_KEY/)
})
test('[OPS-003] krátký ENCRYPTION_KEY je odmítnut', ...)
test('[OPS-003] nezapisovatelná složka dat hlásí cestu', ...)
test('[SEC-003] šifrování je AES-256-GCM s náhodným IV', () => { /* dvě šifrování se liší, dešifrování vrátí originál */ })
test('[SEC-003] pozměněný šifrový text selže', ...)
test('[ARC-003] databáze běží ve WAL a s foreign_keys', ...)
```

- [ ] **Step 2: Spusť, očekávej FAIL**

Run: `npx vitest run tests/backend`

- [ ] **Step 3: Implementuj**

`ENCRYPTION_KEY`: 32 bajtů v base64. Formát šifry: `v1.<iv>.<tag>.<data>`, base64url. PRAGMA: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. Výchozí `DATA_DIR` je `./data`, `DATABASE_PATH` je `<DATA_DIR>/fakturan.db`. `.env.example` obsahuje všechny proměnné ze spec 19.5.

- [ ] **Step 4: Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(db): add env validation, sqlite, secret encryption and clock"
```

### Task 4: Testovací infrastruktura

**Files:**
- Create: `vitest.config.ts`, `playwright.config.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/smoke.spec.ts`, `scripts/spec-coverage.ts`, `tests/spec-pending.txt`
- Modify: `package.json`

**Interfaces:**
- Produces: skripty `test`, `test:e2e`, `test:coverage-spec`. Fixture `freshApp` spustí aplikaci s prázdnou databází v dočasném `DATA_DIR`.

Spec: TST-001 až TST-004.

- [ ] **Step 1: Napiš test skriptu**

```ts
test('[TST-002] nalezne ID bez testu', () => {
  expect(findMissing({ specIds: ['A-1', 'A-2'], tested: ['A-1'], pending: [] })).toEqual(['A-2'])
})
test('[TST-002] ID ve spec-pending nevadí, ale ID s testem v pending je chyba', ...)
```

- [ ] **Step 2: Implementuj `scripts/spec-coverage.ts`**

ID se čtou ze spec regexem `\*\*([A-Z]{2,3}-\d{3})\*\*`, testy z názvů `[ID]`. `tests/spec-pending.txt` obsahuje na začátku všechna dosud neimplementovaná ID a každý plán ho zmenšuje. Na konci plánu 9 musí být prázdný.

- [ ] **Step 3: Nakonfiguruj Vitest (projekty `unit`, `backend`) a Playwright a přidej smoke test**

```ts
test('[UI-001] domovská stránka ukazuje logo a favicon', async ({ page }) => { ... })
```

- [ ] **Step 4: Spusť `npm test && npm run test:e2e && npm run test:coverage-spec`, očekávej PASS. Commit**

```bash
git add -A
git commit -m "test: add vitest, playwright and spec coverage check"
```

### Task 5: Audit log

**Files:**
- Create: `src/server/db/schema/audit.ts`, `src/server/audit/record.ts`, `src/server/audit/redact.ts`, `src/server/audit/context.ts`, `src/server/services/mutation.ts`
- Test: `tests/backend/audit.test.ts`, `tests/helpers/audit-guard.ts`

**Interfaces:**
- Produces:
  - `type Actor = { userId: string | null; source: 'web' | 'scheduler' | 'import' | 'system'; ip?: string; userAgent?: string; requestId?: string }`
  - `recordAudit(tx, entry: AuditEntry): void`
  - `mutate<T>(actor: Actor, action: AuditAction, fn: (tx, audit: (e) => void) => T): T` je jediná povolená cesta pro zápis ve službách; bez záznamu vyhodí chybu.
  - `redact(value: unknown): unknown`
  - `AuditEntry = { action, entity, entityId, before?, after?, ownerId: string | null, scope: 'user' | 'instance' }`

Spec: AUD-001 až AUD-006, AUD-011. Triggery `BEFORE UPDATE` a `BEFORE DELETE` na `audit_log` volají `RAISE(ABORT)`. Výjimka AUD-010 (mazání uživatele) přijde v plánu s mazáním: dočasné povolení přes hodnotu v tabulce `audit_purge`, kterou trigger kontroluje.

- [ ] **Step 1: Napiš testy**

```ts
test('[AUD-005] selhání zápisu auditu vrátí změnu zpět', ...)
test('[AUD-006] UPDATE a DELETE audit_log selžou', ...)
test('[AUD-004] redact skryje klíče password, secret, token, smtpPassword, imapPassword i vnořené a v polích', () => {
  expect(redact({ a: { smtpPassword: 'x' }, b: [{ token: 'y' }] }))
    .toEqual({ a: { smtpPassword: '[skryto]' }, b: [{ token: '[skryto]' }] })
})
test('[AUD-003] záznam obsahuje aktéra, zdroj, ip, user agent a request id', ...)
test('[AUD-011] mutace bez auditu vyhodí chybu', ...)
```

- [ ] **Step 2: Spusť, očekávej FAIL**

- [ ] **Step 3: Implementuj schéma, trigger v migraci a funkce. `mutate` používá `db.transaction(...).immediate()`**

Redakce se vyhodnocuje přes podřetězec klíče bez ohledu na velikost písmen: `password`, `secret`, `token`, `apikey`, `privatekey`.

- [ ] **Step 4: Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(audit): add append-only audit log and mutation guard"
```

### Task 6: Better Auth, první účet, zákaz veřejné registrace

**Files:**
- Create: `src/server/auth/index.ts`, `src/server/auth/signup-guard.ts`, `src/server/auth/session.ts`, `src/server/auth/providers.ts`, `src/app/api/auth/[...all]/route.ts`, `src/lib/auth-client.ts`, `src/app/(auth)/prihlaseni/page.tsx`, `src/app/(auth)/registrace/page.tsx`, `src/app/(auth)/reset-hesla/page.tsx`, `src/server/db/schema/auth.ts`, `src/server/mail/instance.ts`, `tests/helpers/smtp.ts`
- Test: `tests/backend/auth.test.ts`, `tests/e2e/auth.spec.ts`

**Interfaces:**
- Consumes: `mutate`, `Actor`, `env`, `clock`.
- Produces:
  - `auth`, `requireSession(): Promise<Session>`, `requireAdmin(): Promise<Session>`, `actorFromRequest(): Promise<Actor>`
  - `canRegister(tx, email, inviteToken?): { allowed: true; role: 'admin' | 'user' } | { allowed: false }`
  - `enabledProviders(env): ProviderId[]`
  - `sendInstanceMail(msg): Promise<void>`, `isInstanceMailConfigured(): boolean`

Spec: AUTH-001 až AUTH-005, AUTH-008 až AUTH-015. Plugin `admin()` pro role a ban. Vstup `databaseHooks.user.create.before` volá `canRegister`. Souběh prvního účtu řeší tabulka `instance_meta` s unikátním klíčem `first_admin_claimed`, zápis v `immediate` transakci. Apple client secret se generuje přes `jose` při startu z `APPLE_PRIVATE_KEY`. Pokud `canRegister` odmítne sociální přihlášení, uživatel vidí obecné „Přístup je jen na pozvánku“.

- [ ] **Step 1: Napiš testy**

```ts
test('[AUTH-001] první účet je admin a registrace se zavře', ...)
test('[AUTH-001] dvě souběžné první registrace vytvoří jediného admina', ...)
test('[AUTH-002] registrace bez pozvánky přes API selže', ...)
test('[AUTH-004] poskytovatel bez klíčů není v enabledProviders', ...)
test('[AUTH-005] sociální přihlášení bez pozvánky nezaloží účet', ...)
test('[AUTH-008] odkaz na reset je jednorázový a po hodině neplatí', ...)
test('[AUTH-009] první účet bez SMTP nepotřebuje ověření e-mailu', ...)
test('[AUTH-010] heslo pod 12 znaků a známé uniklé heslo jsou odmítnuty', ...)
test('[AUTH-011] ukončení ostatních relací', ...)
test('[AUTH-012] změna hesla ukončí ostatní relace', ...)
test('[AUTH-013] odhlášení zneplatní relaci', ...)
test('[AUD-002] úspěšné i neúspěšné přihlášení je v auditu', ...)
```

E2E: `[AUTH-001] první spuštění: registrace, přihlášení, odhlášení`.

- [ ] **Step 2: Spusť, očekávej FAIL**

- [ ] **Step 3: Implementuj**

Délka relace 30 dní (AUTH-014), cookie `HttpOnly`, `Secure` v produkci, `SameSite=Lax`. Seznam uniklých hesel je soubor 10 000 nejčastějších v `src/server/auth/common-passwords.txt`.

- [ ] **Step 4: Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(auth): add better auth with first admin and closed signup"
```

### Task 7: Rate limiting, hlavičky, izolace

**Files:**
- Create: `src/server/rate-limit.ts`, `src/server/db/scoped.ts`, `src/proxy.ts`
- Modify: `next.config.ts`
- Test: `tests/backend/rate-limit.test.ts`, `tests/backend/scoped.test.ts`, `tests/helpers/isolation.ts`, `tests/e2e/security-headers.spec.ts`

**Interfaces:**
- Produces:
  - `checkRateLimit(key: string, rule: RateRule): { allowed: boolean; retryAfterSeconds: number }`, pravidla v `RATE_RULES`
  - `scoped(ownerId: string)` vrací pomocné `where` pro tabulky s `userId`; služby jinak na data účtu nesahají
  - `assertIsolated(entityFactory)` v testech, opakovaně použitelná matice pro každý další typ entity

Spec: SEC-001, SEC-002, SEC-004, SEC-006, SEC-008, SEC-010. Limity jsou v SQLite tabulce. IP se čte z `x-forwarded-for` jen když je nastavené `TRUST_PROXY=1` (přidat do `.env.example` a spec 19.5). CSP bez nonce, protože statický shell Cache Components nonce nepřipouští: `script-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`, `object-src 'none'`.

- [ ] **Step 1: Napiš testy**

```ts
test('[SEC-001] šesté přihlášení za minutu vrátí 429 a zapíše audit', ...)
test('[SEC-001] limit přežije restart procesu', ...)
test('[SEC-002] scoped nevrátí řádek cizího uživatele', ...)
test('[SEC-004] odpověď má bezpečnostní hlavičky', ...)
test('[SEC-008] neexistující účet a špatné heslo vrátí stejnou chybu', ...)
```

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(security): add rate limiting, headers and owner scoping"
```

### Task 8: Administrace a pozvánky

**Files:**
- Create: `src/server/db/schema/invitation.ts`, `src/server/services/invitations.ts`, `src/server/services/users.ts`, `src/app/(app)/administrace/page.tsx`, `src/app/(app)/administrace/actions.ts`, `src/app/(auth)/pozvanka/[token]/page.tsx`
- Test: `tests/backend/invitations.test.ts`, `tests/backend/users.test.ts`, `tests/e2e/admin.spec.ts`

**Interfaces:**
- Consumes: `requireAdmin`, `mutate`, `sendInstanceMail`, `canRegister`.
- Produces:
  - `createInvitation(actor, email): { url: string }`, `revokeInvitation(actor, id)`, `resendInvitation(actor, id)`
  - `listUsers(actor)`, `setRole(actor, userId, role)`, `deactivateUser(actor, userId)`, `reactivateUser(actor, userId)`, `deleteUser(actor, userId, confirmEmail)`

Spec: ADM-001 až ADM-009, AUTH-006, AUTH-007, AUD-008. V databázi je jen SHA-256 tokenu pozvánky. Stránka pozvánky nastaví cookie, kterou čte `canRegister`, takže Apple a skryté e-maily fungují přes token. `deleteUser` smaže účet a audit přes `audit_purge` (AUD-010); data dalších plánů se přidají do jednoho seznamu `USER_OWNED_TABLES`.

- [ ] **Step 1: Napiš testy**

```ts
test('[ADM-001] běžný uživatel dostane 404 v administraci', ...)
test('[ADM-003] pozvánka platí 7 dní a odkaz funguje bez SMTP', ...)
test('[ADM-003] použitá a vypršelá pozvánka je odmítnuta s vysvětlením', ...)
test('[ADM-004] poslední admin nejde degradovat, deaktivovat ani smazat', ...)
test('[ADM-005] deaktivace okamžitě ukončí relace, otevřená záložka i server action selžou', ...)
test('[ADM-006] smazání vyžaduje shodný e-mail a odstraní data', ...)
test('[ADM-007] admin nemá přístup k datům jiného uživatele', ...)
test('[ADM-009] uživatel smaže vlastní účet, poslední admin s dalšími uživateli ne', ...)
test('[AUTH-007] pozvánka přes odkaz propojí účet s jiným e-mailem', ...)
test('[AUD-008] admin vidí jen události instance', ...)
```

E2E: `[ADM-003] pozvání uživatele, přijetí, oddělené účty`.

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(admin): add user administration and invitations"
```

### Task 9: Rozhraní aplikace a historie

**Files:**
- Create: `src/app/(app)/layout.tsx`, `src/components/app-shell.tsx`, `src/components/nav.ts`, `src/components/theme-toggle.tsx`, `src/lib/texts.ts`, `src/app/(app)/page.tsx`, `src/app/(app)/nastaveni/ucet/page.tsx`, `src/app/(app)/nastaveni/historie/page.tsx`, `src/server/services/audit-read.ts`
- Test: `tests/e2e/shell.spec.ts`, `tests/backend/audit-read.test.ts`

**Interfaces:**
- Produces: `listAudit(actor, filter): Page<AuditRow>`, `exportAuditCsv(actor, filter): string`, `TEXTS` s texty rozhraní, `NAV_ITEMS`.

Spec: UI-005 až UI-009, AUD-007, AUD-009, EXP-004, EXP-008, AUTH-006, SET-035, ARC-005. Navigace z kapitoly 20; položky bez hotové části vedou na prázdný stav „Připravujeme“ a skrývají se před vydáním. Layout má statický shell, data relace jsou v `Suspense`. Data účtu v `use cache` mají `userId` v klíči.

- [ ] **Step 1: Napiš testy**

```ts
test('[UI-005] přepínač motivu a volba podle systému přetrvá', ...)
test('[UI-007] navigace funguje na šířce 390 px bez vodorovného posunu', ...)
test('[AUD-007] uživatel filtruje vlastní audit a nevidí cizí', ...)
test('[EXP-008] CSV neutralizuje hodnoty začínající = + - @', ...)
test('[ARC-005] cache nepřekročí hranici účtu', ...)
```

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS. Commit**

```bash
git add -A
git commit -m "feat(ui): add app shell, account settings and audit history"
```

### Task 10: Provoz a monitoring

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `src/app/api/health/route.ts`, `src/server/logger.ts`, `src/instrumentation.ts`, `src/instrumentation-client.ts`, `sentry.server.config.ts`, `src/server/monitoring/before-send.ts`, `.github/workflows/ci.yml`
- Modify: `next.config.ts`, `README.md`
- Test: `tests/backend/before-send.test.ts`, `tests/e2e/health.spec.ts`

**Interfaces:**
- Produces: `logger.info|warn|error(msg, fields)`, `scrubEvent(event): event`.

Spec: OPS-001 až OPS-004, OPS-006, MON-001 až MON-004, ADM-008, TST-011, SEC-009. Next `output: 'standalone'`. Docker: Node 24, svazek `/data`, migrace ve startu, selhání zastaví proces. Sentry se inicializuje jen se `SENTRY_DSN`.

- [ ] **Step 1: Napiš testy**

```ts
test('[MON-001] bez SENTRY_DSN se SDK neinicializuje', ...)
test('[MON-004] scrubEvent odstraní e-mail, IP a zachová ID uživatele', ...)
test('[OPS-004] /api/health vrátí stav databáze bez citlivých údajů', ...)
test('[OPS-002] selhání migrace zastaví start', ...)
```

- [ ] **Step 2: Spusť, očekávej FAIL. Implementuj. Spusť, očekávej PASS**

- [ ] **Step 3: Ověř obraz**

Run: `docker build -t fakturan . && docker run --rm -e BETTER_AUTH_URL=http://localhost:3000 -e BETTER_AUTH_SECRET=... -e ENCRYPTION_KEY=... -p 3000:3000 -v fakturan-test:/data fakturan`
Expected: `/api/health` vrací 200 a data přežijí restart kontejneru.

- [ ] **Step 4: Spusť celou sadu**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run test:coverage-spec && npm run build`
Expected: vše projde.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ops): add docker image, health check, logging and sentry"
```

---

## Přenos do dalších plánů

- **SEC-006:** ověřit první server actions se vstupem (plán 2).
- **SEC-001, SEC-002, AUD-002:** brána je nehlídá, ale nejsou úplné. Pravidla pro odesílání, import a export, izolace přes server actions a události PDF a exportu potřebují testy v plánech 3, 4 a 8.
- **ADM-005:** zastavení úloh u deaktivovaného uživatele (plán 4).
- **ADM-009:** nabídka zálohy před smazáním účtu (plán 8).
- **MON-003, OPS-004, OPS-005:** chyby plánovače, stav plánovače v health checku, denní záloha (plán 4).
- **ARC-005:** prokázat na první skutečné položce `use cache`.
- **`USER_OWNED_TABLES`:** každá nová tabulka s vlastníkem do seznamu, jinak spadne strukturální test.
- **Známé drobnosti:** e2e `smoke.spec.ts` jednou selhal s „Execution context was destroyed“ a neopakoval se; omezený 429 na `/callback/:id` ukazuje surový JSON; `next build` varuje před `process.exit` v Edge, kód je hlídaný pro Node runtime.
