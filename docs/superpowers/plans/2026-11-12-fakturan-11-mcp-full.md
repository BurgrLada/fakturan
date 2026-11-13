# Fakturan 11: Plný přístup asistentů přes MCP – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Místo pěti přepínačů schopností jedna úroveň oprávnění (5 stupňů), log volání asistentů a zhruba 100 nástrojů MCP jako tenké obaly existujících služeb Fakturanu.

**Architecture:** Úroveň uživatele se čte při každém volání v obalu `runTool` (`src/server/mcp/tool.ts`) a `tools/list` ukazuje jen nástroje do této úrovně. Obal u každého volání zapíše řádek do nové tabulky `mcp_call_log` (když to uživatel nevypnul). Nástroje po doménách v `src/server/mcp/tools/*.ts` volají stejné služby jako web. Logika, která dnes žije ve web akcích, se nejdřív beze změny chování přesune do služeb.

**Tech Stack:** Next.js 16.4, Better Auth 1.7.14, `@modelcontextprotocol/server@2.4.0`, Drizzle + better-sqlite3 (`drizzle-kit generate`), Zod 4, Vitest, Playwright. Žádné nové závislosti.

**Spec:** `docs/superpowers/specs/2026-11-12-mcp-full-design.md` (MCP-050 až MCP-075, kap. 5 = závazný seznam nástrojů). Podklad s odkazy na soubory a řádky: `docs/superpowers/specs/2026-11-12-mcp-full-inventory.md` (dál „inventura“). Platí i `docs/superpowers/specs/2026-11-11-mcp-design.md`, kde ho nový návrh nemění.

## Global Constraints

- Práce na větvi `feat/mcp`. Implementer necommituje do `main` a nepushuje. Implementeři neběží souběžně; každý úkol začíná z čistého stromu po commitu předchozího.
- Každý příkaz v popředí nejvýš 170 s (`timeout 170 …`). Brány před commitem:
  - `timeout 170 pnpm typecheck`, `timeout 170 pnpm lint`, `timeout 170 pnpm format:check`;
  - `timeout 170 pnpm exec vitest run --project unit`;
  - dotčené backend testy po souborech: `timeout 170 pnpm exec vitest run tests/backend/<soubor>`;
  - `timeout 170 pnpm run test:coverage-spec`;
  - u úkolů s UI navíc `timeout 170 pnpm build` a `timeout 170 pnpm exec playwright test <soubor>`.
  Co se nevejde, jde do zprávy úkolu jako „neověřeno“ s příkazem. Úspěch se nepředstírá.
- Po úkolu nezůstane žádný vlastní proces (`pgrep -af 'next|vitest|playwright'`). Na cizí procesy se nesahá.
- **Nástroj nesmí obsahovat doménovou logiku ani SQL** (ARC-001). Smí: validovat vstup Zodem, převést desetinné částky stávajícími `parseMoney`/`parseQuantity`, zavolat službu, vybrat a naformátovat pole výstupu (`server/mcp/format.ts`: `money`, `quoted`, `appLink`). Když nástroj potřebuje víc než jedno volání služby, kroky už musí existovat ve webové akci a přesouvají se do služby (Task 5).
- Mutace dostávají `ctx.actor`, čtení `ctx.ownerId`. Dnešní datum je `ctx.today`.
- **Potvrzovací příznaky** (`confirmed`, `confirmedRepeat`, `confirmedUnknown`, `confirmSend`) nesmí být ve vstupním schématu žádného nástroje; obal je posílá jako `false` (nebo je vynechá). Služby ze spec 5.7 (`closeDifference`, `acknowledgeUnknown`, `bulkSendPreview`, `bulkSend`, `setAutomation(…, true, …)`, `setPaused(false)`) nevolá žádný nástroj.
- Texty jsou česky v `src/lib/texts.ts` (`TEXTS.mcp.*`), názvy nástrojů anglicky `snake_case` přesně podle spec kap. 5. Částky ve výstupu `{ amount, currency, formatted }`, data `RRRR-MM-DD`, texty z dokladů přes `quoted()` (MCP-033), odkazy absolutní.
- Testy nesou ID požadavku v názvu, např. `test("[MCP-052] odmítne nástroj nad úrovní", …)`. Nová ID, která ještě nemají test, jsou v `tests/spec-pending.txt` a úkol, který test přidá, je odtud smaže.
- Commity ve stylu repa (`feat(mcp): …`, `refactor(…): …`) s řádkem `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Úrovně: `McpLevel = "read" | "drafts" | "accounting" | "issue_send" | "full"` v tomto pořadí. České názvy: Jen čtení, Koncepty, Účetní operace, Vystavování a odesílání, Plný přístup.

## Review Focus

1. **Obejití úrovně jiným nástrojem:** asistent s úrovní `accounting` upraví plán opakované faktury v režimu `issue` tak, že pošle `mode: "draft"`. Musí být odmítnuto (MCP-051). Test je v Task 10 (`[MCP-051] úprava plánu v režimu issue vyžaduje issue_send`).
2. **Zastaralá úroveň v klientovi:** klient má seznam nástrojů z doby, kdy byla úroveň vyšší, a zavolá nástroj, který už v seznamu není. Musí dostat odmítnutí s potřebnou úrovní, ne výsledek. Test je v Task 2 (`[MCP-052] volání nástroje mimo aktuální seznam`).
3. **Selhání zápisu logu:** plná nebo zamčená tabulka logu nesmí zrušit ani změnit výsledek volání, které už změnilo data. Test je v Task 4 (`[MCP-061] selhání zápisu logu nezmění výsledek`).
4. **Data z dokladů v logu:** volání s poznámkou „tajné heslo 1234“ nesmí nic z argumentů zanechat v `mcp_call_log`. Test je v Task 4 (`[MCP-060] log neobsahuje argumenty`).
5. **Zastaralá revize:** asistent pošle `issue_invoice` se starou `revision` po úpravě ve webu. Musí dostat chybu s radou znovu načíst fakturu a faktura zůstane konceptem bez čísla. Test je v Task 9 (`[MCP-072] vystavení se starou revizí`).

## Společné rozhraní nástrojů (definuje Task 2, používají Task 6 až 12)

```ts
// src/lib/mcp-settings.ts
export type McpLevel = "read" | "drafts" | "accounting" | "issue_send" | "full";
export const MCP_LEVELS: readonly McpLevel[];            // v pořadí výše
export function levelAtLeast(have: McpLevel, need: McpLevel): boolean;

// src/server/mcp/tool.ts
export type ToolDef<I, O> = {
  name: string; title: string; description: string;
  level: McpLevel;                                        // minimální úroveň (MCP-052)
  levelFor?: (ctx: ToolContext, input: I) => McpLevel;     // odvozená úroveň (MCP-051), jen čistý výběr
  input: z.ZodType<I>; output: z.ZodType<O>;
  run: (ctx: ToolContext, input: I) => O | Promise<O>;
  text: (output: O) => string;
  fieldLabels?: FieldLabels;
};
```

Testy nástrojů používají pomocníka `tests/helpers/mcp-tools.ts` (Task 2):

```ts
export function mcpAccount(db, opts?: { level?: McpLevel; logCalls?: boolean }): Promise<{ ownerId: string; claims: McpClaims }>;
export function callTool(name: string, claims: McpClaims, args: unknown): Promise<CallToolResult>;
export function lastAuditSource(db, ownerId: string): string | null;   // ověří zdroj "mcp"
```

Každý test nástroje (Task 6 až 12) má tvar: **šťastná cesta** (výsledek odpovídá stavu, který po stejném volání služby vidí web, a u mutace `lastAuditSource === "mcp"`) a **cizí ID** (účet B volá s ID účtu A, výsledek je chyba „nenalezeno“ a data A se nezměnila; MCP-074). V úkolech níže je u každého nástroje uvedená jen specifická aserce navíc.

---

### Task 1: Úrovně v datech a službě

**Files:**
- Modify: `src/lib/mcp-settings.ts`, `src/server/services/mcp-settings.ts`, `src/server/db/schema/mcp.ts`
- Create: `drizzle/0054_mcp_levels_call_log.sql` (+ journal přes `pnpm exec drizzle-kit generate`, pak ruční doplnění převodu dat)
- Modify: `src/server/backup/tables.ts` (řádky `mcp_settings`), `src/server/services/account-restore.ts:242`
- Modify: `docs/superpowers/specs/2026-10-30-fakturan-design.md` kap. 25: přidat MCP-050 až MCP-075 (text ze spec, jedna věta na ID), upravit MCP-011, MCP-025, MCP-031, MCP-042, MCP-044 tak, aby nemluvily o schopnostech. `tests/spec-pending.txt`: přidat všechna nová ID.
- Test: `tests/backend/mcp-settings.test.ts`, `tests/backend/backup-registry.test.ts`, `tests/backend/backup-roundtrip*.test.ts` (dle existence)

**Interfaces:**
- Produces: `McpLevel`, `MCP_LEVELS`, `levelAtLeast` (viz výše); `McpSettings = { enabled: boolean; level: McpLevel; logCalls: boolean; revision: number }`; `DEFAULT_MCP_SETTINGS = { enabled: false, level: "read", logCalls: true, revision: 0 }`; `mcpSettingsSchema` (strict: `enabled`, `level` enum, `logCalls`, `revision`); `getMcpSettings(ownerId): McpSettings`; `activeLevel(settings): McpLevel | null` (null při vypnutém přístupu; nahrazuje `allowedCapabilities`); `saveMcpSettings(actor, raw): McpSettings`.
- Odstraní: `McpCapability`, `MCP_CAPABILITIES`, `AVAILABLE_CAPABILITIES`, `allowedCapabilities`. Typecheck pak ukáže všechna místa; v tomto úkolu se opraví jen datová vrstva, obal a UI kompilačně minimálně (dočasně `def.capability` → mapování `read`→`read`, `create`→`drafts`), plně je převede Task 2 a 3.

- [ ] **Step 1: Failing testy** v `tests/backend/mcp-settings.test.ts` (stávající testy schopností nahradit):
  - `[MCP-050] výchozí nastavení je read, log zapnutý, přístup vypnutý` → `getMcpSettings(nový)` `toEqual(DEFAULT_MCP_SETTINGS)`;
  - `[MCP-050] uloží každou úroveň` pro všech 5 hodnot `MCP_LEVELS`;
  - `[MCP-050] odmítne neznámou úroveň` (`level: "admin"` → `ServiceError`);
  - `[MCP-056] změna úrovně se zapíše do auditu` → řádek `mcp.settings_changed`, `before.level`/`after.level`;
  - `[MCP-050] activeLevel je null při vypnutém přístupu`;
  - `levelAtLeast("accounting","drafts") === true`, `levelAtLeast("drafts","accounting") === false`, `levelAtLeast(x,x) === true` pro všechny.
- [ ] **Step 2: Spustit** `timeout 170 pnpm exec vitest run tests/backend/mcp-settings.test.ts` → FAIL (chybí `level`).
- [ ] **Step 3: Schéma a migrace.** `mcp_settings` dostane `level text not null default 'read'` a `log_calls integer(boolean) not null default 1`; sloupce `can_*` se odstraní. Migrace před odstraněním naplní `level = CASE WHEN can_create = 1 THEN 'drafts' ELSE 'read' END` (MCP-055). V téže migraci tabulka `mcp_call_log` (Task 4 ji použije): `id integer pk autoincrement`, `owner_id text not null references user(id) on delete cascade`, `at integer(timestamp_ms) not null`, `client_id text not null`, `client_name text not null`, `tool text not null`, `outcome text not null` (`ok|denied|error`), `reason text`, `required_level text`, `request_id text not null`; index `(owner_id, at)`.
- [ ] **Step 4: Služba a lib** podle Interfaces. Uložení zapisuje `level` a `logCalls`; zbytek beze změny (revize, audit bez `revision`).
- [ ] **Step 5: Záloha a obnova.** Registr `mcp_settings` se sloupci `enabled, level, log_calls, revision`; obnova zálohy se staršími sloupci `can_*` převede stejným pravidlem jako migrace; po obnově `enabled = false` (MCP-042). `mcp_call_log` do zálohy nepatří (MCP-065) – zařadit do klasifikace tabulek, pokud ji registr vyžaduje. Testy: `[MCP-055] obnova staré zálohy s can_create převede na drafts`, `[MCP-055] migrace převede can_create na drafts` (spustit migraci nad DB s řádkem `can_create=1` a `can_create=0`).
- [ ] **Step 6: Brány** (Global Constraints) → PASS. Smazat z `tests/spec-pending.txt` ID, která teď mají test (MCP-050, MCP-055, MCP-056).
- [ ] **Step 7: Commit** `feat(mcp): store a single permission level instead of capability switches`.

### Task 2: Obal, seznam nástrojů a instrukce podle úrovně

**Files:**
- Modify: `src/server/mcp/tool.ts`, `src/server/mcp/server.ts`, `src/server/mcp/tools/*.ts` (stávajících 6: `capability` → `level`; `create_draft_invoice` = `drafts`, ostatní `read`), `src/lib/texts.ts` (`TEXTS.mcp.tools.levelTooLow(levelName)`, `TEXTS.mcp.levels` (názvy + jednovětné popisy), `TEXTS.mcp.instructions(levelName)` = text z MCP-053, odstranit `capabilityOff`, `offSuffix`)
- Create: `tests/helpers/mcp-tools.ts`
- Test: `tests/backend/mcp-tool.test.ts`, `tests/backend/mcp-endpoint.test.ts`, `tests/backend/mcp-tools-read.test.ts`, `tests/backend/mcp-tools-create.test.ts` (úprava očekávání)

**Interfaces:**
- Consumes: Task 1.
- Produces: `ToolDef` se `level`/`levelFor` (viz Společné rozhraní); `runTool(def, claims, raw, env)` beze změny signatury; `buildMcpServer(claims, env)` registruje jen nástroje, kde `levelAtLeast(activeLevel, def.level)`; pomocník `tests/helpers/mcp-tools.ts`.

- [ ] **Step 1: Failing testy** v `tests/backend/mcp-tool.test.ts` (echo nástroje s úrovněmi `read` a `issue_send`):
  - `[MCP-052] odmítne nástroj nad úrovní` → `isError`, text `TEXTS.mcp.tools.levelTooLow("Vystavování a odesílání")`, `run` nezavolán;
  - `[MCP-052] úroveň se ověří před validací vstupu` → nástroj nad úrovní s neplatným vstupem vrátí `levelTooLow`, ne chybu polí;
  - `[MCP-051] levelFor zvýší požadovanou úroveň` → echo s `levelFor: (_, i) => i.hard ? "full" : "read"`; `{hard:true}` na úrovni `read` odmítnuto, `{hard:false}` projde;
  - `[MCP-052] volání nástroje mimo aktuální seznam` → uživatel s úrovní `read` volá přes `runTool` nástroj `issue_send` (klient ho zná ze staršího seznamu) → odmítnuto.
- [ ] **Step 2: Failing testy** v `tests/backend/mcp-endpoint.test.ts`:
  - `[MCP-053] tools/list obsahuje jen nástroje do úrovně` → pro každou z 5 úrovní: každý vrácený nástroj má `levelAtLeast(level, def.level)` a každý takový nástroj z `TOOLS` je vrácen;
  - `[MCP-053] při vypnutém přístupu je seznam prázdný`;
  - `[MCP-053] server posílá instrukce s aktuální úrovní` → `initialize` vrátí `instructions` obsahující název úrovně a „Nastavení › Asistenti“;
  - `[MCP-053] anotace` → nástroj `read` má `readOnlyHint: true`, nástroj `full` `destructiveHint: true`.
- [ ] **Step 3: Spustit** oba soubory → FAIL.
- [ ] **Step 4: Implementace.** `admit()` v pořadí MCP-052: dostupnost → účet → vypínač → propojení → `levelAtLeast(activeLevel, def.level)` → `def.input.parse` → `levelFor` → služba. `admit` vrací `ToolContext` rozšířený o `level: McpLevel`. Odmítnutí je `McpToolError` s `levelTooLow(název chybějící úrovně)`. `buildMcpServer`: filtr podle úrovně, `instructions` v `new McpServer(..., { instructions })` (ověřit API v `node_modules/@modelcontextprotocol/server`), popis nástroje úrovně nižší než `full` dostane příponu `TEXTS.mcp.tools.higherLevelHint` (krátká věta z MCP-053).
- [ ] **Step 5: Pomocník** `tests/helpers/mcp-tools.ts` podle Společného rozhraní, postavený na tom, co dnes dělají `mcp-tools-create.test.ts` (účet, souhlas klienta, nastavení přes `saveMcpSettings`). Převést stávající testy nástrojů na úrovně (`[MCP-024]` atd. zůstávají).
- [ ] **Step 6: Brány** → PASS; smazat z pending MCP-051 až MCP-053.
- [ ] **Step 7: Commit** `feat(mcp): check the permission level on every call and list only allowed tools`.

### Task 3: Nastavení › Asistenti a souhlas s úrovní

**Files:**
- Modify: `src/components/settings/assistants-form.tsx`, `src/app/(app)/nastaveni/asistenti/page.tsx`, `src/app/(app)/nastaveni/asistenti/actions.ts`, `src/server/mcp/consent-info.ts`, `src/components/auth/assistant-consent.tsx`, `src/app/(auth)/pristup-asistenta/page.tsx`, `src/lib/texts.ts`
- Test: `tests/unit/mcp-consent-info.test.ts`, `tests/e2e/mcp-settings.spec.ts`, `tests/e2e/mcp-consent.spec.ts`, `tests/e2e/mcp-helpers.ts`

**Interfaces:**
- Consumes: `McpSettings`, `MCP_LEVELS`, `TEXTS.mcp.levels`.
- Produces: `consentInfo(...)` vrací `level: McpLevel | null` místo seznamu schopností.

- [ ] **Step 1: Failing e2e** v `tests/e2e/mcp-settings.spec.ts`: `[MCP-054] zvolí úroveň Účetní operace a po načtení zůstane zvolená` (rádiová skupina s 5 možnostmi a popisem každé); `[MCP-062] přepínač Zaznamenávat volání se uloží`. V `mcp-consent.spec.ts`: `[MCP-054] souhlas ukáže aktuální úroveň`. Unit `mcp-consent-info`: úroveň místo schopností.
- [ ] **Step 2: Implementace.** Rádiová skupina ve stávajícím stylu Nastavení místo checkboxů; přepínač `logCalls`; text MCP-044 pro „nic nesmí“ odpadá (úroveň `read` vždy něco smí).
- [ ] **Step 3: Brány včetně** `pnpm build` a obou e2e souborů → PASS; smazat z pending MCP-054.
- [ ] **Step 4: Commit** `feat(mcp): choose the assistant permission level in settings`.

### Task 4: Log volání

**Files:**
- Create: `src/server/services/mcp-call-log.ts`, `src/server/db/schema/mcp.ts` (tabulka `mcpCallLog` k migraci z Task 1)
- Modify: `src/server/mcp/tool.ts` (zápis), `src/server/scheduler/start.ts` (`jobCleanupTask` volá `purgeMcpCallLog(now)`), `src/components/settings/assistants-form.tsx` nebo nová `src/components/settings/assistant-call-log.tsx`, `src/app/(app)/nastaveni/asistenti/page.tsx` + `actions.ts` (smazat log), `src/lib/texts.ts` (důvody česky)
- Test: `tests/backend/mcp-call-log.test.ts`, `tests/e2e/mcp-settings.spec.ts`

**Interfaces:**
- Consumes: Task 1 a 2.
- Produces:
  ```ts
  export type McpCallOutcome = "ok" | "denied" | "error";
  export type McpCallReason = "level" | "disabled" | "not_connected" | "unavailable" | "invalid_input" | "service_error" | "confirm_in_web";
  export function recordMcpCall(entry: { ownerId: string; clientId: string; clientName: string; tool: string; outcome: McpCallOutcome; reason: McpCallReason | null; requiredLevel: McpLevel | null; requestId: string; at: Date }): void; // no-op při logCalls=false; vyjímky polyká a hlásí do Sentry
  export function listMcpCalls(ownerId: string, filter: { clientId?: string; outcome?: McpCallOutcome; page: number }): Page<McpCallRow>;
  export function clearMcpCallLog(actor: Actor): void;   // mutate, audit "mcp.call_log_cleared"
  export function purgeMcpCallLog(now: Date): void;      // smaže at < now − 90 dní
  export const MCP_CALL_LOG_DAYS = 90;
  ```

- [ ] **Step 1: Failing testy** v `tests/backend/mcp-call-log.test.ts`:
  - `[MCP-061] úspěšné volání zapíše ok` (tool, client, requestId shodný s auditem mutace);
  - `[MCP-061] odmítnutí kvůli úrovni zapíše denied/level s required_level` (MCP-067);
  - `[MCP-061] vypnutý přístup zapíše denied/disabled`, `odpojený klient denied/not_connected`;
  - `[MCP-067] neplatný vstup zapíše error/invalid_input bez required_level`;
  - `[MCP-061] chyba služby zapíše error/service_error`;
  - `[MCP-062] s vypnutým logem se nezapíše nic, audit mutace ano`;
  - `[MCP-060] log neobsahuje argumenty` (poznámka „tajné heslo 1234“ nikde v řádku);
  - `[MCP-061] selhání zápisu logu nezmění výsledek` (mock `recordMcpCall` insertu, který hodí; volání vrátí úspěch a koncept existuje);
  - `[MCP-061] neznámý sub se nezapisuje`;
  - `[MCP-064] purge smaže záznamy starší než 90 dní a nechá novější`;
  - `[MCP-065] smazání uživatele smaže jeho log`.
- [ ] **Step 2: Spustit** → FAIL.
- [ ] **Step 3: Implementace.** `runTool` zapisuje v `finally` po určení výsledku; `reason` odvozuje z místa odmítnutí v `admit` (typovaná chyba `McpDenied extends McpToolError` s `reason` a `requiredLevel`). Zápis mimo `mutate` a mimo transakci služby.
- [ ] **Step 4: UI.** Tabulka logu v Nastavení › Asistenti (čas, asistent, nástroj, výsledek, důvod česky, potřebná úroveň), stránkování po 50, filtr asistent/výsledek, tlačítko „Smazat log“ s potvrzením. E2E: `[MCP-063] log ukáže volání asistenta` (vytvořit řádky přes `recordMcpCall` v seed kroku e2e, nebo voláním nástroje přes helper).
- [ ] **Step 5: Brány** včetně build a e2e → PASS; smazat z pending MCP-060 až MCP-067.
- [ ] **Step 6: Commit** `feat(mcp): log every assistant call with an off switch`.

### Task 5: Přesun logiky z akcí do služeb

Čistý refaktor (spec kap. 6). Akce po něm volají novou funkci; jejich chování a testy se nemění.

**Files:**
- Modify: `src/app/(app)/faktury/actions.ts`, `src/app/(app)/hledani-actions.ts`, `src/app/(app)/ares-actions.ts`, `src/app/(app)/nastaveni/posta/sablony/actions.ts`
- Modify: `src/server/services/invoices.ts`, `invoice-versions.ts`, `credit-notes.ts`, `advances.ts`, `catalog.ts`, `quick-search.ts`, nový `company-lookup.ts`, `email-templates.ts`
- Test: `tests/backend/service-moves.test.ts` (nový) + stávající testy akcí

**Interfaces:**
- Produces (přesně tyto názvy, Task 6 až 12 je volají):
  ```ts
  // invoices.ts
  export function saveDraftWithTags(actor: Actor, draft: DraftInput, tags: string[]): { id: string; revision: number; problems: IssueProblem[] };
  // invoice-versions.ts
  export function updateIssuedWithTags(actor: Actor, id: string, document: IssuedInput, tags: string[]): EditResult;
  // credit-notes.ts
  export function createCreditNoteWithSeries(actor: Actor, invoiceId: string): ReturnType<typeof createCreditNote>;
  // advances.ts
  export function convertAdvanceWithSeries(actor: Actor, advanceId: string): ReturnType<typeof convertAdvance>;
  // catalog.ts
  export function saveLineToCatalog(actor: Actor, line: { name: string; description?: string; unit: string; priceMinor: number; currency: Currency }): CatalogItem;
  // quick-search.ts
  export function quickSearch(actor: Actor, raw: string): { hits: SearchHit[]; limited: boolean };   // min. délka + RATE_RULES.searchUser + searchAll
  // company-lookup.ts
  export async function lookupCompany(actor: Actor, ico: string): Promise<AresResult | null>;      // enforceRateLimit(actor, RATE_RULES.aresLookup) + lookupAres z server/external/ares.ts
  // email-templates.ts
  export function resetEmailTemplateAndRead(actor: Actor, kind: MessageKind, language: Language): { subject: string; body: string };
  ```
  Přesné typy parametrů převzít z dnešních akcí (inventura 0.3). Pokud se typ jmenuje jinak, použít stávající jméno a opravit tento blok v plánu.

- [ ] **Step 1: Failing testy** v `tests/backend/service-moves.test.ts`, jeden na funkci, každý ověří všechny přesunuté kroky: `saveDraftWithTags` vytvoří výchozí řady, uloží koncept, nastaví štítky (audit `invoice.save` + `invoice.tags_set`) a vrátí `problems` shodné s `checkIssuable`; neplatný název štítku odmítne dřív, než vznikne koncept; `quickSearch` s 1 znakem vrátí prázdné bez spotřeby limitu; po vyčerpání `searchUser` vrátí `limited: true`; `lookupCompany` po vyčerpání `aresLookup` (30/60 s) hodí `ServiceError` (ARES mockovat jako v existujících testech ARES); ostatní obdobně.
- [ ] **Step 2: Spustit** → FAIL.
- [ ] **Step 3: Přesunout** kroky beze změny pořadí a chování; akce volají nové funkce, `revalidatePath` zůstává v akcích.
- [ ] **Step 4: Brány** + stávající testy akcí faktur, hledání, ARES a e-mailových šablon (najít `grep -rl "saveDraftAction\|quickSearch\|lookupAresAction\|resetEmailTemplateAction" tests`) → PASS.
- [ ] **Step 5: Commit** `refactor(services): move action-level steps into services for reuse by mcp`.

### Task 6: Faktury – čtení

**Files:** Create `src/server/mcp/tools/invoices-read.ts`; Modify `src/server/mcp/tools/invoice.ts` (`get_invoice`), `tools/index.ts`, `src/lib/texts.ts`. Test `tests/backend/mcp-tools-invoices-read.test.ts`.

**Interfaces:** Consumes Task 2 (`defineTool`, helper). Produces výstup `get_invoice` rozšířený o `revision: number`, `payments[].id`, `versions: {id, createdAt}[]`, `mailLog: {id, status}[]`, `related: {id, type, number}[]` – Task 8, 9 je čtou.

Nástroje (vše `level: "read"`; služby a vstupy v inventuře sekce 1 a 2): `get_invoice`, `list_invoices`, `list_invoice_versions`, `get_invoice_version`, `list_invoice_mail_log`, `list_reminder_history`, `check_invoice_issuable`, `preview_issue`, `prepare_invoice_email`, `prepare_payment_receipt`, `prepare_reminder`, `list_tags`.

- [ ] **Step 1: Failing testy** (šťastná cesta + cizí ID pro každý) a navíc: `[MCP-072] get_invoice vrací revision a ID plateb`; `preview_issue nespotřebuje číslo` (číslo `peekNumber` před a po stejné); `list_invoices omezí stránku na 50` (MCP-075); `[MCP-033] prepare_invoice_email ohraničí text z dokladu`.
- [ ] **Step 2: Spustit** → FAIL. **Step 3: Implementace.** **Step 4: Brány** → PASS. **Step 5: Commit** `feat(mcp): read invoices, versions, mail log and prepared messages`.

### Task 7: Koncepty faktur

**Files:** Modify `src/server/mcp/tools/create-draft.ts`; Create `src/server/mcp/tools/drafts.ts`. Test `tests/backend/mcp-tools-drafts.test.ts` (+ úprava `mcp-tools-create.test.ts`).

**Interfaces:** Consumes `saveDraftWithTags`, `convertAdvanceWithSeries` (Task 5). Produces výstup konceptu `{ id, revision, problems, … }`.

Nástroje (`level: "drafts"`): `create_draft_invoice` (přepnout na `saveDraftWithTags`, vstup `tags?: string[]`, výstup `revision`, `problems`), `update_draft_invoice` (vstup `id`, `revision`, celé pole jako `create_draft_invoice`, `tags`), `duplicate_invoice`, `draft_from_template`, `convert_advance_to_final`.

- [ ] **Step 1: Failing testy** navíc: `[MCP-024] stejný idempotency_key vrátí týž koncept i se štítky`; `update_draft_invoice se starou revizí vrátí chybu s radou načíst znovu` (MCP-072); `update_draft_invoice na vystavené faktuře odmítne`; `convert_advance_to_final nespotřebuje číslo`.
- [ ] **Steps 2–5** jako Task 6. Commit `feat(mcp): edit, duplicate and derive draft invoices`.

### Task 8: Zákazníci, ceník, platby, banka

**Files:** Create `src/server/mcp/tools/customers.ts`, `catalog.ts`, `payments.ts`, `bank.ts`; Modify `search.ts` jen pokud sdílí formátování. Test `tests/backend/mcp-tools-customers-catalog.test.ts`, `tests/backend/mcp-tools-payments-bank.test.ts`.

**Interfaces:** Consumes `lookupCompany`, `saveLineToCatalog` (Task 5), `get_invoice` výstup (Task 6).

| Úroveň | Nástroje |
|---|---|
| read | `list_customers`, `get_customer`, `lookup_company_ares`, `list_catalog`, `get_catalog_item`, `list_catalog_categories`, `list_units`, `list_bank_notices`, `get_bank_status`, `list_notice_candidates`, `list_bank_accounts` |
| drafts | `save_customer`, `archive_customer`, `restore_customer`, `verify_customer_vat`, `save_catalog_item`, `archive_catalog_item`, `restore_catalog_item`, `save_unit`, `save_line_to_catalog` |
| accounting | `add_payment`, `add_refund`, `update_payment`, `mark_paid`, `mark_paid_many`, `assign_notice`, `split_notice`, `dismiss_notice`, `restore_notice`, `check_mailbox_now`, `save_bank_account`, `set_default_bank_account`, `hide_bank_account`, `unhide_bank_account` |
| full | `delete_customer`, `delete_unit`, `delete_payment`, `undo_notice`, `delete_bank_account` |

- [ ] **Step 1: Failing testy** navíc: `add_payment s částkou "1500.50" uloží 150050 haléřů`; `delete_customer s fakturami odmítne větou služby`; `check_mailbox_now bez nastavené schránky vrátí chybu služby`; `vstupní schéma žádného nástroje neobsahuje confirmed` (rychlá kontrola pro `payments.ts`).
- [ ] **Steps 2–5** jako Task 6. Commit `feat(mcp): customers, catalog, payments and bank notices`.

### Task 9: Životní cyklus faktury a odesílání

**Files:** Create `src/server/mcp/tools/lifecycle.ts`, `sending.ts`. Test `tests/backend/mcp-tools-lifecycle.test.ts`.

**Interfaces:** Consumes `updateIssuedWithTags`, `createCreditNoteWithSeries` (Task 5).

| Úroveň | Nástroje |
|---|---|
| accounting | `mark_sent`, `mark_sent_many`, `snooze_reminders`, `set_reminders_off`, `set_partial_reminders` |
| issue_send | `issue_invoice`, `send_invoice`, `resend_from_log`, `send_payment_receipt`, `send_reminder` |
| full | `delete_draft`, `update_issued_invoice`, `refresh_customer_snapshot`, `restore_invoice_version`, `cancel_invoice`, `restore_cancelled_invoice`, `create_credit_note`, `delete_imported_invoice` |

Odesílací nástroje: vstup `idempotency_key` (uuid) → `requestId`; `confirmedUnknown`/`confirmedRepeat` vždy `false`. Když služba odmítne s textem potvrzení (`E.confirmRepeat`, neznámé doručení), nástroj vrátí chybu `TEXTS.mcp.tools.confirmInWeb(link)` a log `reason: "confirm_in_web"`.

- [ ] **Step 1: Failing testy** navíc: `[MCP-072] vystavení se starou revizí` (chyba s radou, faktura zůstane konceptem bez čísla); `issue_invoice s problémy vrátí výčet problémů` (MCP-073); `send_invoice dvakrát se stejným idempotency_key založí jeden záznam pošty`; `send_reminder opakované upomínky vrátí confirm_in_web a nic neodešle`; `send_invoice při neznámém doručení vrátí confirm_in_web`; `create_credit_note vytvoří koncept dobropisu bez čísla`.
- [ ] **Steps 2–5** jako Task 6. Commit `feat(mcp): issue, send, cancel and amend invoices`.

### Task 10: Opakované faktury, šablony, číselné řady

**Files:** Create `src/server/mcp/tools/recurring.ts`, `templates.ts`, `series.ts`. Test `tests/backend/mcp-tools-recurring.test.ts`.

| Úroveň | Nástroje |
|---|---|
| read | `list_recurring`, `get_recurring`, `list_recurring_runs`, `list_plan_invoices`, `preview_recurring`, `list_invoice_templates`, `get_invoice_template`, `list_number_series` |
| accounting | `save_recurring` (`levelFor`), `pause_recurring`, `resolve_missed_run`, `recurring_from_template`, `save_invoice_as_template`, `save_number_series`, `set_default_series` |
| issue_send | `resume_recurring`, `set_next_number` |
| full | `delete_recurring`, `delete_invoice_template`, `delete_number_series` |

`save_recurring.levelFor(ctx, input)`: `max(úroveň(input.mode), úroveň(getRecurring(ctx.ownerId, input.id)?.mode))`, kde `draft` → `accounting`, `issue`/`send` → `issue_send`. Vstup nemá `confirmSend`.

- [ ] **Step 1: Failing testy** navíc: `[MCP-051] úprava plánu v režimu issue vyžaduje issue_send` (accounting + `mode:"draft"` nad plánem `issue` → odmítnuto, plán nezměněn); `[MCP-051] nový plán v režimu issue vyžaduje issue_send`; `save_recurring v režimu send bez potvrzení odmítne větou služby`; `set_next_number na obsazené číslo odmítne`.
- [ ] **Steps 2–5** jako Task 6. Commit `feat(mcp): recurring plans, templates and number series`.

### Task 11: Nastavení dodavatele, výchozí hodnoty, automatizace, upomínky, e-mailové šablony

**Files:** Create `src/server/mcp/tools/settings.ts`. Test `tests/backend/mcp-tools-settings.test.ts`.

| Úroveň | Nástroje |
|---|---|
| read | `get_supplier`, `get_preferences`, `get_automation`, `list_reminder_rules`, `list_email_templates`, `get_email_template` |
| accounting | `save_supplier`, `save_preferences`, `disable_automation` (wrap `setAutomation(actor, key, false, { confirmed: false })`), `pause_automation` (`setPaused(actor, true, { confirmed: false })`), `set_send_time`, `set_daily_digest`, `set_period_summary`, `set_tax_reminder`, `set_limit_mail`, `save_reminder_rule`, `save_email_template`, `reset_email_template` |
| full | `delete_reminder_rule` |

Poznámka k názvům: spec 5.3 říká `set_automation (jen enabled: false)`; plán ho pojmenovává `disable_automation`, aby vstup neměl `enabled` (zapnutí je mimo, 5.7) **[rozhodnutí plánu]**. `save_preferences`: vstupní schéma je `preferencesPatchSchema` bez klíčů `designId`, `accentColor`, `surfaceColor`, `textColor`, `lineColor`, `logoPosition` (`.omit`).

- [ ] **Step 1: Failing testy** navíc: `save_preferences s designId odmítne jako neznámé pole`; `disable_automation vypne automatizaci a audit má zdroj mcp`; `get_preferences nevrací klíče vzhledu`.
- [ ] **Steps 2–5** jako Task 6. Commit `feat(mcp): supplier, preferences, automation and message settings`.

### Task 12: Přehledy, hledání, historie, importy, kurz

**Files:** Create `src/server/mcp/tools/reports.ts`, `audit.ts`, `imports.ts`; Modify `search.ts`. Test `tests/backend/mcp-tools-reports.test.ts`.

| Úroveň | Nástroje |
|---|---|
| read | `get_report` (`reportBundle`, filtr `parseReportFilter`), `get_tax_overview` (`taxOverview`), `quick_search` (`quickSearch` z Task 5), `list_audit`, `get_entity_history`, `list_import_batches`, `get_exchange_rate` (`loadRate`) |
| full | `undo_import` (`undoBatch`) |

`list_audit` a `get_entity_history` vynechají ve výstupu `ip`, `userAgent`, `requestId`; `before`/`after` jsou data (`quoted` v textu). `get_report` volá `reportBundle` přímo, ne `server/report-cache.ts`.

- [ ] **Step 1: Failing testy** navíc: `get_report se shoduje s get_overview za stejné období`; `list_audit nevrací ip ani userAgent`; `quick_search s jedním znakem vrátí prázdný výsledek`; `undo_import vrátí dávku a audit má zdroj mcp`.
- [ ] **Steps 2–5** jako Task 6. Commit `feat(mcp): reports, search, history and import undo`.

### Task 13: Registr nástrojů, dokumentace, ověření

**Files:** Create `tests/backend/mcp-registry.test.ts`; Modify `README.md` (sekce Asistenti (MCP)), `docs/superpowers/specs/2026-10-30-fakturan-design.md` (zbylé úpravy kap. 25), `tests/spec-pending.txt`.

- [ ] **Step 1: Testy registru:**
  - `[MCP-070] sada nástrojů odpovídá návrhu` – snapshot `{ name, level }[]` seřazený podle názvu, porovnaný s inline seznamem přepsaným ze spec kap. 5 (a Task 11 `disable_automation`);
  - `[MCP-070] žádné vstupní schéma neobsahuje potvrzovací příznak` – projít `z.toJSONSchema(def.input)` rekurzivně, žádná vlastnost `confirmed`, `confirmedRepeat`, `confirmedUnknown`, `confirmSend`;
  - `[MCP-070] žádný nástroj nevolá služby ze 5.7` – statická kontrola zdrojů `src/server/mcp/tools/*.ts`: neobsahují `closeDifference`, `acknowledgeUnknown`, `bulkSend`, `bulkSendPreview`, ani `setPaused(` s `false`, ani `setAutomation(` s `true`;
  - `[MCP-070] nástroje neobsahují SQL` – zdroje nástrojů neimportují `drizzle-orm` ani `../../db`;
  - `[MCP-074] izolace` – pro každý nástroj s parametrem `id` volání z cizího účtu vrátí chybu (generický průchod přes registr s ID z účtu A; nástroje, kde to nejde, mají výjimku s důvodem v testu).
- [ ] **Step 2: Spustit** → opravit nalezené odchylky v nástrojích (ne v testu).
- [ ] **Step 3: README:** úrovně a co přidávají, log volání a jeho vypnutí, seznam nástrojů po úrovních (jen názvy), co zůstává jen ve webu (spec 2.2, 5.7).
- [ ] **Step 4: Spec coverage:** `tests/spec-pending.txt` neobsahuje žádné ID z MCP-050 až MCP-075; `timeout 170 pnpm run test:coverage-spec` → PASS.
- [ ] **Step 5: Ruční ověření** (koordinátor): `pnpm dev`, Claude Code `claude mcp add --transport http fakturan http://localhost:3000/api/mcp`; na úrovni `read` ověřit seznam nástrojů a odmítnutí `create_draft_invoice`; přepnout na `drafts`, po novém načtení seznamu založit koncept; zkontrolovat log v Nastavení. Výsledek do zprávy úkolu.
- [ ] **Step 6: Commit** `test(mcp): pin the tool registry to the design and document levels`.
