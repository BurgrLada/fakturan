# Fakturan: přístup asistentů přes MCP – návrh

Datum: 2026-11-11. Navazuje na `2026-10-30-fakturan-design.md` (dál jen „hlavní návrh“), kapitoly 2.4, 4 a 19.2 (ARC-001).

Značky: bez značky = rozhodl uživatel. **[volba]** = rozhodnutí autora návrhu, které uživatel může změnit.

---

## 1. Záměr

Uživatel chce mluvit s AI asistentem (Claude, ChatGPT a další klienti MCP) a nechat ho pracovat s vlastním Fakturanem: zeptat se na přehled, zjistit, kdo nezaplatil, podívat se na konkrétní fakturu a nechat si připravit novou fakturu. Asistent pracuje jako přihlášený uživatel, vidí jen jeho data a platí pro něj stejná pravidla, audit a limity jako ve webu.

Hlavní návrh s tím od začátku počítá (kap. 2.4, ARC-001): doménová logika je ve službách `src/server/services/*`, takže MCP je jen tenká vrstva nad nimi.

## 2. Cíle, mimo rozsah, neúspěch

### 2.1 Cíle první verze

1. Endpoint MCP na instanci (`/api/mcp`), na který se asistent připojí jen adresou. Žádné ruční kopírování tokenů.
2. Přihlášení přes OAuth 2.1, kde poskytovatelem identity je **sám Fakturan přes Better Auth**. Žádná další služba.
3. Záložka **Nastavení › Asistenti** s hlavním vypínačem, jedněmi přepínači schopností pro všechny asistenty a seznamem propojených asistentů s možností odpojit.
4. Nástroje první verze: přehled, nezaplacené faktury, detail faktury, hledání zákazníka a položky ceníku, založení konceptu faktury.

### 2.2 Mimo rozsah první verze

- Vystavení, odeslání e-mailem, úpravy, mazání, platby. Přepínače pro ně v nastavení jsou, ale jsou neaktivní s textem „připravujeme“.
- Administrace (uživatelé, pozvánky) přes MCP. Nebude ani později bez nového návrhu.
- Přepínače po jednotlivých asistentech (uživatel zvolil variantu „jedny pro všechny“).
- API tokeny pro skripty (osobní tokeny bez OAuth).
- MCP prompty a resources. První verze má jen nástroje (tools).

### 2.3 Co by byl neúspěch, i kdyby to technicky fungovalo

- Asistent vidí nebo změní data jiného účtu.
- Asistent udělá něco, co uživatel v nastavení vypnul, nebo co nastavení neumí vypnout.
- Asistent spálí číslo z číselné řady nebo pošle něco zákazníkovi.
- Přes OAuth vznikne účet bez pozvánky (porušení AUTH-002, AUTH-005).
- Odpojený asistent má po odpojení ještě nějakou dobu přístup.
- V auditu nejde poznat, že změnu udělal asistent.
- Napojení na velké klienty (Claude.ai, Claude Code, ChatGPT) nefunguje, protože jsme zvolili verzi protokolu nebo registraci klienta, kterou nepodporují.

## 3. Uživatelský tok

1. Uživatel v **Nastavení › Asistenti** zapne „Povolit připojení asistentů“. Zobrazí se adresa `https://<instance>/api/mcp` s tlačítkem Kopírovat a krátký návod (Claude.ai: Settings › Connectors › Add custom connector; Claude Code: `claude mcp add --transport http fakturan <adresa>`).
2. Uživatel vloží adresu do asistenta. Asistent dostane `401` s odkazem na metadata chráněného zdroje (RFC 9728), najde autorizační server (RFC 8414), zaregistruje se a otevře prohlížeč.
3. Fakturan ukáže běžnou stránku `/prihlaseni` (heslo nebo sociální poskytovatelé podle AUTH-003, AUTH-004). Kdo už přihlášený je, tenhle krok přeskočí.
4. Souhlasová stránka (`/pristup-asistenta`): „<název klienta> chce přístup k vašemu Fakturanu“. Ukáže doménu klienta, aktuálně zapnuté schopnosti a odkaz do Nastavení, a tlačítka Povolit a Zamítnout.
5. Po povolení se asistent vrátí do svého rozhraní a může volat nástroje.
6. Uživatel kdykoli v Nastavení vypne schopnost, vypne celý přístup, nebo asistenta odpojí. Účinek je okamžitý (MCP-012).

Mockup nastavení (zvolená varianta A): `.superpowers/brainstorm/617743-1794404839/content/nastaveni-asistenti.html`.

## 4. Požadavky (MCP)

ID se při implementaci přenesou do hlavního návrhu jako nová kapitola, aby je hlídal `test:coverage-spec` **[volba]**.

### 4.1 Autorizace a připojení

- **MCP-001** Fakturan je autorizační server OAuth 2.1 pro vlastní MCP endpoint přes pluginy Better Auth (`jwt` a MCP/OAuth provider z verze odpovídající nainstalovanému `better-auth` 1.7.x). Publikuje metadata autorizačního serveru (RFC 8414) i chráněného zdroje (RFC 9728) na cestách, které klienti hledají, včetně variant pod `/.well-known/…` v kořeni domény.
- **MCP-002** Registrace klienta: podporuje to, co potřebují Claude.ai, Claude Code a ChatGPT v době implementace (dynamická registrace RFC 7591 a/nebo Client ID Metadata Document). Implementer ověří na reálném klientovi, ne jen podle dokumentace. PKCE (S256) je povinné.
- **MCP-003** Přihlášení na `/prihlaseni` po úspěchu pokračuje v rozpracované autorizaci. Platí pro heslo i sociální poskytovatele.
- **MCP-004** OAuth nikdy nezaloží účet. Platí AUTH-002 a AUTH-005 beze změny. Pokus přihlásit se cizím e-mailem skončí stejně jako ve webu.
- **MCP-005** Souhlasová stránka `/pristup-asistenta` zobrazí název a doménu klienta, které poslal sám klient, jako nedůvěryhodný text (žádné HTML, omezená délka) a viditelně upozorní, že název uvádí klient sám. Zamítnutí vrátí klientovi `access_denied`.
- **MCP-006** Když je přístup asistentů vypnutý (MCP-010), autorizace skončí na stránce s vysvětlením a odkazem do Nastavení. Souhlas se neukáže a token se nevydá.
- **MCP-007** Přístupový token je krátkodobý (nejvýš 15 minut **[volba]**), obnovovací token se při použití rotuje. Audience tokenu je přesně adresa `/api/mcp` této instance. Token pro jiný zdroj endpoint odmítne.
- **MCP-008** Scope je jediný, `fakturan` **[volba]**. Co asistent smí, neurčuje OAuth scope, ale přepínače v Nastavení kontrolované při každém volání (MCP-012). Důvod: uživatel chce schopnosti měnit kdykoli bez nového připojování.
- **MCP-009** Režim ukázky (OPS-007): MCP je vypnuté. Endpoint, metadata i autorizace vrací `404`, záložka v Nastavení se nezobrazí.

### 4.2 Nastavení › Asistenti

- **MCP-010** Hlavní vypínač „Povolit připojení asistentů“, výchozí vypnuto. Vypnutí okamžitě odmítne všechna volání a nové autorizace, propojení ale nesmaže.
- **MCP-011** Přepínače schopností platné pro všechny asistenty uživatele:

  | Schopnost | Nástroje | První verze | Výchozí |
  |---|---|---|---|
  | Číst | přehled, nezaplacené, detail, hledání | ano | zapnuto |
  | Zakládat | založit koncept faktury | ano | vypnuto |
  | Upravovat | úprava konceptu | připravujeme | – |
  | Vystavovat | vystavit koncept | připravujeme | – |
  | Odesílat | odeslat e-mailem | připravujeme | – |

  Neaktivní přepínače jsou vidět, nejdou zapnout a mají text „připravujeme“.
- **MCP-012** Server ověří při **každém** volání nástroje: platný token, hlavní vypínač, potřebnou schopnost, existující propojení klienta s uživatelem a že účet není zablokovaný (`BANNED_USER`). Neplatí, že by stačilo ověření při připojení. Vypnutá schopnost vrátí chybu nástroje se srozumitelnou českou větou („Zakládání faktur je v Nastavení › Asistenti vypnuté.“), ne HTTP chybu.
- **MCP-013** Seznam propojených asistentů: název klienta, doména, kdy připojen, kdy naposledy použit (přesnost na minuty stačí **[volba]**), tlačítko Odpojit. Odpojení smaže souhlas i obnovovací tokeny klienta. Díky MCP-012 přestane platit i ještě neexpirovaný přístupový token.
- **MCP-014** Změny vypínače, schopností a odpojení se zapíší do auditu jako ostatní nastavení (zdroj `web`).
- **MCP-015** Záložka je dostupná každému uživateli (ne jen administrátorovi). Každý uživatel má vlastní nastavení.

### 4.3 Nástroje první verze

Názvy nástrojů jsou anglicky (`snake_case`), popisy, parametry a výstupy česky **[volba]**. Důvod: klienti a modely pracují nejlépe s anglickými identifikátory, uživatel čte češtinu. Výstup je text pro model a `structuredContent` s výstupním schématem. Částky jsou formátované i strojové (celé číslo v nejmenší jednotce plus měna). Data jsou ve tvaru RRRR-MM-DD. Každý nástroj volá existující službu a neobsahuje doménovou logiku (ARC-001).

- **MCP-020** `get_overview` (Číst): za zvolené období (výchozí letošní rok) vystaveno, uhrazeno, neuhrazeno, z toho po splatnosti, počty, rozdělení podle měny. Čísla se shodují s kapitolou Statistiky (REP), použije stejné jádro `src/server/reports/`. Koncepty a storna se nepočítají (REP-007).
- **MCP-021** `list_unpaid_invoices` (Číst): neuhrazené a částečně uhrazené vystavené faktury, volitelně jen po splatnosti a jen pro zákazníka. U každé číslo, zákazník, vystaveno, splatnost, dní po splatnosti, zbývá uhradit, měna, odkaz do webu. Stránkování, výchozí řazení podle splatnosti.
- **MCP-022** `get_invoice` (Číst): detail podle ID nebo čísla faktury. Hlavička, odběratel, položky, součty, DPH, stav, platby, odkaz do webu. Faktura jiného účtu se chová stejně jako neexistující (v duchu `2777c10`).
- **MCP-023** `search_customers` a `search_catalog` (Číst): hledání zákazníka a položky ceníku podle textu, aby asistent mohl založit fakturu bez hádání ID. Použije stávající hledání (`quick-search`, služby zákazníků a ceníku).
- **MCP-024** `create_draft_invoice` (Zakládat): založí **jen koncept** přes stejné schéma a službu jako web (`draftInputSchema`). Vstup: zákazník (ID), položky (název, množství, cena, sazba DPH, nebo položka ceníku), volitelně datum vystavení, splatnost, měna, poznámka. Chybějící hodnoty doplní výchozí nastavení uživatele stejně jako nová faktura ve webu. Vrátí ID, součty a odkaz `/faktury/<id>/upravit`. Koncept nemá číslo (INV-001), takže se žádné číslo nespálí. Chyby validace vrátí jako chybu nástroje s výčtem polí.
- **MCP-025** Nástroj, na který uživatel nemá zapnutou schopnost, se v `tools/list` objeví také, s popisem, že je v Nastavení vypnutý **[volba]**. Důvod: asistent pak uživateli umí říct, co má zapnout, a seznam se nemění pod rukama klienta, který si ho pamatuje.

### 4.4 Audit, limity, bezpečnost

- **MCP-030** Audit: nový zdroj `mcp` v `Actor.source` a ve sloupci `audit.source` (migrace). Záznam nese ID klienta a jeho název. Historie ve webu u takové změny ukáže „Asistent: <název>“.
- **MCP-031** Čtení přes MCP se do auditu nezapisuje, stejně jako čtení ve webu. Zapisují se vydání a odvolání přístupu (autorizace, odpojení).
- **MCP-032** Limity: endpoint má vlastní omezení počtu volání na uživatele a klienta **[volba: 60 za minutu]** a registrace klientů má limit podle IP. Překročení vrátí `429`. Platí i stávající limity účtu (`account-limits`), protože nástroje volají stejné služby.
- **MCP-033** Výstupy nástrojů jsou data, ne instrukce. Texty z faktur (poznámky, názvy položek) jsou v `structuredContent` jako hodnoty a v textu jsou zřetelně oddělené. Žádný nástroj nesmí na základě obsahu dokumentu provést další akci.
- **MCP-034** `proxy.ts` endpoint MCP, metadata ani OAuth trasy nepřesměrovává na přihlášení. Odpověď bez tokenu je `401` s hlavičkou `WWW-Authenticate` podle RFC 9728.
- **MCP-035** Endpoint je bezstavový (bez MCP session), každý požadavek nese token **[volba]**. Odpovídá ARC-008 (jeden proces) i tomu, že se aplikace restartuje při nasazení.
- **MCP-036** Do Sentry (MON-004) jde u chyb MCP jen ID uživatele a název nástroje, ne argumenty ani výstup.
- **MCP-037** Konfigurace: žádná nová povinná proměnná. Adresa instance se bere ze stávající `BETTER_AUTH_URL` (nebo ekvivalentu). Pokud implementace potřebuje novou proměnnou, přidá se do `.env.example` a kap. 19.5 (OPS-003).
- **MCP-038** Volitelná proměnná `MCP_ENABLED` (výchozí `true`) vypne MCP pro celou instanci. Chová se jako demo režim (MCP-009) **[volba]**.

### 4.5 Upřesnění po recenzi návrhu

Všechno v tomto oddílu je **[volba]** autora návrhu.

- **MCP-040** **Better Auth je závazný.** Povolené je cokoli z ekosystému Better Auth (`@better-auth/mcp`, `@better-auth/oauth-provider`, `@better-auth/cimd`, `jwt`) a tenké lepidlo kolem nich (hooky, vlastní trasy, mazání řádků v jejich tabulkách). Vlastní OAuth server psaný od nuly povolený není. Povinné jsou: PKCE, audience (MCP-007), okamžité odpojení (MCP-012, MCP-013) a funkční registrace aspoň pro Claude Code a Claude.ai (MCP-002). Rotace refresh tokenu a délka přístupového tokenu (MCP-007) se mohou přizpůsobit tomu, co plugin umí. Odchylku implementer zapíše do PR. Když plugin povinnou věc neumí, implementer zastaví a ohlásí to, místo aby ji obcházel.
- **MCP-041** **Propojení** je řádek souhlasu (`oauthConsent` nebo ekvivalent) pro dvojici uživatel a klient. Obal nástrojů ho při každém volání přečte z SQLite. Je to lokální čtení, takže to nevadí. Formát přístupového tokenu je ten, který dává plugin (JWT je v pořádku). „Naposledy použit“ se zapisuje nejvýš jednou za minutu na propojení, mimo audit.
- **MCP-042** **Zálohy, export, smazání účtu.** `mcp_settings` je součástí zálohy účtu (BACKUP_TABLES). Po obnově je hlavní vypínač vždy vypnutý, schopnosti se obnoví. OAuth tabulky (klienti, tokeny, souhlasy, JWKS) nejsou v záloze, exportu ani obnově. Při smazání uživatele se jeho souhlasy a tokeny smažou (cascade), klienti zůstanou, protože jsou globální. Pokud existující test vyžaduje klasifikaci každé tabulky, nové tabulky se do něj zařadí.
- **MCP-043** **`create_draft_invoice`, upřesnění:**
  - Typ dokladu je vždy běžná faktura. Zálohová ani opravná faktura v první verzi nejsou.
  - Číselná řada je výchozí řada uživatele pro běžnou fakturu.
  - Ceny na vstupu jsou desetinné řetězce v hlavní jednotce měny („1500.50“), množství také. Převod obstará stávající pomocník z `src/lib/money.ts` a `src/lib/invoice-form.ts`, ne nová aritmetika (ARC-002).
  - U cizí měny se kurz doplní automaticky z ČNB stejně jako v konceptu ve webu (FOR-003). Asistent kurz nezadává.
  - Volitelný parametr `idempotency_key` (UUID) se předá jako `clientId` do `draftInputSchema`. Opakované volání se stejným klíčem tak vrátí týž koncept.
  - Odkaz ve výstupu je absolutní, sestavený z adresy instance.
- **MCP-044** **Souhlasová stránka:**
  - Zobrazí název klienta a hostitele z `redirect_uri`. Pro `localhost` a `127.0.0.1` místo hostitele ukáže „aplikace na tomto počítači“. Pro dokument CIMD ukáže hostitele dokumentu.
  - Když je hlavní vypínač zapnutý, ale všechny schopnosti vypnuté, souhlas jde udělit. Stránka to řekne větou „Asistent se připojí, ale zatím nic nesmí. Schopnosti zapnete v Nastavení › Asistenti.“

## 5. Architektura (návrh pro implementera)

- **Better Auth:** do `createAuth` v `src/server/auth/index.ts` přibudou pluginy `jwt` a MCP/OAuth provider (`loginPage: "/prihlaseni"`, `consentPage: "/pristup-asistenta"`, `resource: <BETTER_AUTH_URL>/api/mcp`). Nové tabulky (klienti, tokeny, souhlasy, klíče JWKS) do Drizzle schématu a migrace. Stávající hooky (pozvánky, demo, audit, rate limity) musí OAuth trasy pokrýt. Nové cesty `oauth2/*` projdou revizí proti `ADMIN_PATHS` a `DEMO_LOCKED_PATHS`.
- **Nastavení:** nová tabulka `mcp_settings` (uživatel, zapnuto, číst, zakládat, upravovat, vystavovat, odesílat, revize) a služba `src/server/services/mcp-settings.ts`. Seznam propojených asistentů a odpojení jako služba nad tabulkami Better Auth.
- **Endpoint:** `src/app/api/mcp/route.ts` přes oficiální TypeScript SDK MCP a pomocníka Better Auth pro ověření tokenu. Server MCP se staví na každý požadavek.
- **Nástroje:** `src/server/mcp/tools/*.ts`, každý nástroj = Zod vstup, Zod výstup, potřebná schopnost, volání služby. Společný obal zajistí MCP-012, aktéra pro audit (`source: "mcp"`), mapování `ServiceError` na chybu nástroje a limity.
- **Stránky:** `src/app/(app)/nastaveni/asistenti/`, `src/app/(auth)/pristup-asistenta/` ve stávajícím stylu.
- **Závislosti:** `@modelcontextprotocol/sdk` (nebo jeho nástupce, který Better Auth dokumentace uvádí) a balíček MCP pluginu Better Auth ve verzi shodné s `better-auth`. Verze přesně, ne rozsahem, jako u ostatních klíčových balíčků.

## 6. Testování

- Unit/backend: obal nástrojů (MCP-012 všechny větve: bez tokenu, cizí audience, vypnutý hlavní vypínač, vypnutá schopnost, odpojený klient, zablokovaný účet), každý nástroj nad testovací databází, izolace účtů (nástroj nikdy nevrátí data jiného účtu), audit se zdrojem `mcp`, demo režim.
- Integrační: celý tok OAuth v testu (registrace klienta, PKCE, přihlášení heslem, souhlas, výměna kódu, volání nástroje, rotace refresh tokenu, odpojení a okamžité odmítnutí).
- E2E Playwright: Nastavení › Asistenti (vypínač, přepínače, „připravujeme“, odpojení) a souhlasová stránka.
- Ruční ověření: připojení skutečného klienta (Claude Code `claude mcp add --transport http`, případně MCP Inspector) proti lokální instanci. Výsledek se zapíše do PR.

## 7. Pořadí

1. Better Auth jako autorizační server + metadata + souhlasová stránka + prázdný endpoint s ověřením tokenu (ověřené na reálném klientovi).
2. Nastavení › Asistenti a obal MCP-012, audit `mcp`.
3. Nástroje Číst (MCP-020 až MCP-023).
4. `create_draft_invoice` (MCP-024).
5. Dokumentace (README: jak připojit asistenta), přenos ID do hlavního návrhu, PR.

## 8. Ponecháno na implementerovi

- Přesné API pluginů Better Auth 1.7.x a SDK MCP (dokumentace se mezi verzemi mění, ověřit v `node_modules`).
- Volba DCR vs. CIMD, případně obojí, podle toho, co reální klienti potřebují (MCP-002).
- Rozvržení stránek v rámci stávajícího designu (UI kapitola hlavního návrhu).
- Přesný tvar výstupních schémat nástrojů.
