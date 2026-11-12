# Fakturan

Jednoduchá fakturace pro české OSVČ. Next.js, shadcn/ui, SQLite.

## Vývoj

```bash
corepack enable
pnpm install
pnpm dev
```

Před prvním spuštěním zkopírujte `.env.example` do `.env` a vyplňte `BETTER_AUTH_SECRET` a
`ENCRYPTION_KEY` (obojí `openssl rand -base64 32`). Bez nich aplikace nenastartuje.

Kontroly: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:e2e` (potřebuje `pnpm exec playwright install chromium`), `pnpm test:coverage-spec`,
`pnpm build`.

Testy jdou pustit i po částech, každá doběhne do tří minut (stejně jako v CI):

```bash
pnpm exec vitest run --project unit
pnpm exec vitest run --project backend --shard=1/6 --exclude tests/backend/pdf-designs.test.ts
# … až --shard=6/6
pnpm exec vitest run tests/backend/pdf-designs.test.ts -t "registr designů"
pnpm exec vitest run tests/backend/pdf-designs.test.ts -t "vizuální regrese"
pnpm exec vitest run tests/backend/pdf-designs.test.ts -t "barvy vystaveného dokladu"
pnpm exec vitest run tests/backend/pdf-designs.test.ts -t "náhled designu"
pnpm exec vitest run tests/backend/pdf-designs.test.ts -t "^design [a-f]"
pnpm exec vitest run tests/backend/pdf-designs.test.ts -t "^design [g-z]"
pnpm build
pnpm exec playwright test <soubor>
```

Playwright spouští `next start` jako přímý potomek (bez `pnpm` a bez `detached`) a po testu ho
ukončí. PID běžících serverů zapisuje do `$TMPDIR/fakturan-e2e-pids/`. Když worker spadne,
`globalTeardown` ukončí jen zapsané procesy, které jsou `next` s datovou složkou `fakturan-e2e-*`.

Mutační testy (Stryker) běží po souborech. Každý soubor z `mutate` ve `stryker.config.json` má
ve `stryker.map.json` seznam testů, které ho chrání, a běh pouští jen je:

```bash
pnpm run test:mutation:file -- src/lib/money.ts
pnpm run test:mutation:file -- src/server/services/number-series.ts:1-232   # po rozsazích řádků
pnpm run test:mutation:file -- src/lib/money.ts --incremental               # jen změněné mutanty
pnpm run test:mutation:summary -- --core   # brána jádra: kód 1, když soubor jádra nemá 90 %
pnpm run test:mutation:summary             # všechny soubory z mutate
```

Výsledky jsou v `reports/mutation/` (mimo git). Soubor, jehož běh by trval přes tři minuty,
pusťte po rozsazích řádků, které dohromady pokryjí celý soubor. Souhrn položí novější rozsahy přes
poslední zprávu celého souboru. Bez ní je musí pokrýt celý soubor, a zpráva jiné verze zdroje
se nepočítá. Běh po rozsazích vynechá mutanty, které hranici rozsahu překročí, ty změří jen běh
celého souboru. `--incremental` znovu použije dřívější výsledky, i u statických
mutantů, u kterých změnu nepozná. Čísla pro zprávu proto berte z plného běhu. Ekvivalentní
mutant smí mít `// Stryker disable next-line <mutátor>: <důvod>`, vždy s důvodem.

Otisk sloupců zálohy v2 (`tests/fixtures/backup/columns-v2.json`) je zmrazený. Každá další změna
sloupců nebo tabulek zálohy zvedá `BACKUP_VERSION`, přidává `columns-v<n>.json` a krok
`BACKUP_UPGRADES`, a nová tabulka nese `since` s verzí, od které v archivu je. Test
`[EXP-006] otisk sloupců v2 sedí s registrem` v `tests/backend/backup-registry.test.ts` změnu bez
nové verze zastaví.

## Konfigurace

Všechno se nastavuje proměnnými prostředí, úplný seznam s popisem je v `.env.example`. Povinné jsou
`BETTER_AUTH_URL` (veřejná adresa), `BETTER_AUTH_SECRET` (min. 32 znaků) a `ENCRYPTION_KEY`
(32 bajtů v base64). Ostatní (SMTP, sociální přihlášení, `SENTRY_DSN`, `TRUST_PROXY`) jsou volitelné.
Proměnné se čtou za běhu, jeden obraz tedy slouží pro libovolný počet instancí.

### Ukázka nastavení

Instance za reverzní proxy se sdíleným SMTP serverem a hlášením chyb do GlitchTipu:

```bash
BETTER_AUTH_URL=https://fakturace.example.cz
BETTER_AUTH_SECRET=<openssl rand -base64 32>
ENCRYPTION_KEY=<openssl rand -base64 32>
TRUST_PROXY=1

# Sdílený server pro všechny účty; vlastní server v Nastavení > Pošta má přednost
SMTP_HOST=smtp.example.cz
SMTP_PORT=587
SMTP_USER=fakturace@example.cz
SMTP_PASSWORD=<heslo>
SMTP_FROM="Fakturace <fakturace@example.cz>"

SENTRY_DSN=https://<klíč>@monitoring.example.cz/<id projektu>
SENTRY_ENVIRONMENT=production
```

`CNB_BASE_URL`, `ARES_BASE_URL` a `VIES_BASE_URL` nechte nenastavené, aplikace pak používá veřejné
adresy ČNB, ARES a EU. Mění se jen kvůli testům nebo vlastnímu zrcadlu. `TRUST_PROXY=1` patří jen
za proxy, která `X-Forwarded-For` sama přepisuje (viz Provoz za reverzní proxy).

Schránka avíz se nenastavuje proměnnými, ale v aplikaci v Nastavení > Avíza: server IMAP,
port 993 s TLS, uživatel, heslo a **server ověření (authserv-id)**. To je název, kterým se poštovní
server příjemce podepisuje v hlavičce `Authentication-Results`, například `mx.example.cz`. Zkouška
připojení ho z posledního avíza nabídne. Použijte ho, jen pokud je to opravdu váš server, který
zprávy přijímá do čtené schránky. Bez něj čeká každé avízo ve frontě na potvrzení.

## Docker

```bash
docker build -t fakturan .
docker run -d --name fakturan \
  -e BETTER_AUTH_URL=https://fakturace.example.cz \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e TRUST_PROXY=1 \
  -p 3000:3000 -v fakturan-data:/data fakturan
```

Hodnoty `BETTER_AUTH_SECRET` a `ENCRYPTION_KEY` si uložte: při každém startu musí být stejné.
Ztráta `ENCRYPTION_KEY` znamená ztrátu šifrovaných tajemství v databázi.

Všechna data (SQLite databáze a soubory) jsou na svazku `/data`, kontejner běží pod uživatelem
`node` (UID 1000), svazek mu musí patřit. Migrace databáze proběhnou při každém startu; když
selžou nebo chybí povinná proměnná, proces skončí s chybou. Logy jsou JSON řádky na stdout.
Stav kontroluje `GET /api/health` (200 a `{"status":"ok"}`, jinak 503), obraz má `HEALTHCHECK`.

### Monitoring

Chyby serveru, prohlížeče i plánovaných úloh jdou do služby kompatibilní se Sentry (Sentry,
GlitchTip), když nastavíte `SENTRY_DSN`. Pro GlitchTip založte v organizaci projekt a DSN z jeho
nastavení vložte do `SENTRY_DSN`. `SENTRY_ENVIRONMENT` odliší instance (třeba `production`
a `demo`), `SENTRY_TRACES_SAMPLE_RATE` (0 až 1, výchozí 0) zapne měření výkonu. Bez DSN se nic
neposílá a aplikace funguje stejně. Prohlížeč posílá události přes `/api/monitoring` na stejné
adrese, takže se Content-Security-Policy nemění.

Plánovač jednou za hodinu hlásí i provozní stav, každou podmínku nejvýš jednou denně: volné místo
na svazku pod 2 GiB nebo pod 10 %, poslední lístek ČNB starší než 3 pracovní dny, těžká úloha
běžící přes 30 minut a selhaná poslední noční záloha.

Do události jde jen ID uživatele (ID účtu v aplikaci), čas, úroveň, prostředí, zpráva a stack bez
proměnných, metoda a adresa požadavku bez parametrů, u selhané
úlohy plánovače její druh a ID. Nikdy se neposílá e-mail, IP adresa, cookies,
hlavičky, těla požadavků, obsah faktur, tajemství ani odpovědi poštovního serveru. E-mailové adresy
a tokeny ze zpráv a adres se nahradí zástupným textem dřív, než událost opustí instanci.

### Záloha a obnova

Aplikace jednou denně po 2:30 (Praha) uloží konzistentní kopii databáze do `backups/` ve složce
dat: soubor `fakturan-RRRR-MM-DD.db`, oprávnění `0600`, posledních 14 kopií. Kopie se ověří
(`integrity_check`) a teprve potom se přejmenuje, takže poškozená záloha nikdy nenahradí dobrou.
Záloha potřebuje na svazku volné místo alespoň dvojnásobek velikosti databáze, jinak se nezapíše
a selhání ukáže Administrace. Po selhání se pokus opakuje nejdříve za hodinu a starší kopie zůstanou. Stav a čas poslední zálohy
ukazuje Administrace. Tajemství (SMTP hesla klientů apod.) jsou v záloze šifrovaná, takže k obnově
potřebujete stejný `ENCRYPTION_KEY`.

Složka `files/` (nahrané obrázky a archiv PDF) v záloze není. Záloha leží na stejném svazku jako
data, takže ji kopírujte i mimo svazek, jinak nechrání před ztrátou disku.

Obnova: zastavte kontejner, nahraďte `fakturan.db` vybranou zálohou, smažte `fakturan.db-wal`
a `fakturan.db-shm` a kontejner spusťte se stejným `ENCRYPTION_KEY`.

```bash
docker stop fakturan
docker run --rm -v fakturan-data:/data debian:bookworm-slim sh -c \
  'cp /data/backups/fakturan-2026-11-02.db /data/fakturan.db \
   && rm -f /data/fakturan.db-wal /data/fakturan.db-shm && chown 1000:1000 /data/fakturan.db'
docker start fakturan
```

### Záloha a obnova jednoho účtu

Každý uživatel si v Nastavení, Záloha vytvoří archiv `fakturan-zaloha-RRRR-MM-DD.zip` s celým
účtem: doklady, platby, zákazníci, ceník, šablony, pravidelné faktury, nastavení, nástěnky,
přiložené soubory (loga, odeslaná PDF a ISDOC, PDF z importu) a historie změn. Záloha běží na
pozadí a je 7 dní ke stažení. Hesla SMTP a schránky s avízy v ní nejsou, IP adresa a prohlížeč
jiných osob (správce) v historii jsou skryté. Archiv není šifrovaný ani podepsaný, obsahuje osobní
údaje a ukládá si ho uživatel.

Obnova jde jen do prázdného účtu, třeba hned po registraci na jiné instanci: v Nastavení, Záloha
nahrajte ZIP a stiskněte Obnovit ze zálohy. Archiv se dvakrát celý ověří (limity, kontrolní součty,
každý řádek), všechna ID dostanou nové hodnoty a data se zapíšou v jedné transakci, takže při chybě
zůstane účet beze změny. Po obnově jsou všechny automatiky vypnuté, pravidelné faktury pozastavené (znovu je
spustíte na jejich kartě), plán s odesíláním čeká na nové potvrzení, historie změn ze zálohy je ke
stažení v Nastavení, Záloha a SMTP i schránku s avízy je nutné zadat znovu. Limity: archiv 1 GiB, soubor v něm
25 MiB, data všech tabulek dohromady 256 MiB po rozbalení, nejvýš 300 000 řádků (tabulky i
historie změn dohromady), řádek tabulky nejvýš 512 KiB, hodnota JSON (dokument šablony nebo
plánu, vzhled, snapshoty) nejvýš 256 KiB, verze vystaveného dokladu nejvýš 16 MiB a 200 000
položek archivu (tedy zhruba tolik souborů). Účet má navíc strop řádků v konfiguraci: 2 000 šablon
a 2 000 pravidelných faktur, 50 nástěnek po nejvýš 50 widgetech, 200 předvoleb importu, 500 jednotek,
200 číselných řad, 100 bankovních účtů, 2 000 štítků a 20 pravidel upomínek; doklad má nejvýš 500
položek. Tytéž stropy platí v aplikaci i při obnově. Delší doklad nebo šablonu ani řádek nad strop
aplikace nedovolí uložit. Každý textový sloupec má strop délky podle formuláře (např. jméno
zákazníka 200 znaků, popis položky 2 000), stejný v aplikaci i při obnově. PDF dokladu
(stažení, odeslání i export) vznikne nejvýš z 200 000 znaků textu a formulář delší doklad
neuloží; starší doklad nad tím PDF nemá a aplikace řekne proč. Starší šablonu, plán nebo koncept nad strop záloha pojmenuje
a nevznikne, dokud se nezkrátí; verze vystavených dokladů mají rezervu nad vším, co aplikace kdy
dovolila. Zápis obnovy je jedna transakce a na stropu zastaví instanci asi na 20 s. Archiv má
formát verze 2: hned za popisem zálohy leží seznam souborů s jejich kontrolními součty, takže popis
neroste s počtem souborů; zálohy verze 1 jde dál obnovit. Archiv s víc než 65 535 položkami nese
záznam ZIP64 na konci, starší rozbalovací programy ho nemusí přečíst. Obnova nedrží
řádky v paměti: každý ověřený řádek s novými ID zapíše do mezisouboru své tabulky ve složce
obnovy a zápis je čte zpět po řádcích; v paměti zůstává jen mapa ID a právě čtená položka archivu
(do 200 MiB). Mez paměti drží hlídač: obnova průběžně počítá, co drží (čtenou položku, mapu ID,
rozpracovaný řádek a dávku zápisu). Když by to bylo víc než 640 MiB, nebo když halda přesáhne
75 % svého limitu, archiv se odmítne a účet zůstane beze změny. Stejný hlídač běží při vytváření
zálohy. Počty objektů a hodnot JSON v datech (1 milion a 25 milionů) jsou jen levná předběžná
kontrola. Účet o 300 000 řádcích (faktury, položky a platby) se do limitů vejde; záloha, která by
limity překročila, vůbec nevznikne a řekne to. Mezisoubory potřebují na svazku volné místo zhruba
jako data archivu a po obnově i po chybě zmizí. Smazání účtu nabídne zálohu, ale nečeká na ni a
archiv zmizí s účtem, proto ho stáhněte předem.

### Import a export

Import (Nastavení > Import) bere ISDOC, ZIP s ISDOC nebo PDF, PDF s vloženým ISDOC, CSV a Excel do
25 MB na soubor. Nahraný soubor se uloží do složky dat a zpracuje na pozadí, průběh ukazuje
stránka importu. Nepotvrzená dávka se po čase uklidí i se souborem. Potvrzení je jedna transakce
a dávka jde celá vrátit.

Export (Nastavení > Export) běží na pozadí ve frontě těžkých úloh, kde se účty střídají, aby jeden
velký export nezdržel ostatní. Hotový soubor je ke stažení 7 dní. PDF v ZIPu bere nejvýš 2 000
dokladů najednou, větší výběr rozdělte filtrem období. Stažení příloh (PDF z importu, archiv
historie změn, odeslané HTML) má limit 30 za hodinu a zapisuje se do historie změn.

Všechny limity zálohy v2 jsou výše v Záloze a obnově jednoho účtu: archiv 1 GiB, 200 000 položek,
300 000 řádků a 256 MiB dat. Mezisoubory obnovy leží ve složce obnovy na svazku a po obnově i po
chybě zmizí. Nahrání zálohy i importu musí pustit reverzní proxy, viz Provoz za reverzní proxy
(1 GiB, resp. 25 MB).

## Automatizace a pošta

Plánovač běží uvnitř aplikace, žádná externí úloha není potřeba. Každou minutu zpracuje frontu,
vytvoří pravidelné faktury a naplánuje upomínky. `/api/health` hlásí `scheduler: running`, Administrace
ukazuje stav plánovače. Interval mění `SCHEDULER_TICK_SECONDS` (1 až 60), je to jen pro testy.

Bez kliknutí uživatele neodejde nic, dokud v Nastavení > Automatizace nezapne konkrétní automatiku.
Každá automatika se zapíná zvlášť a s potvrzením, hlavní vypínač zastaví všechny najednou. Po výpadku
aplikace se doženou jen termíny staré nejvýš 3 dny, starší se nabídnou ke kontrole a samy neodejdou.
Odeslání, u kterého nejde poznat výsledek, se neopakuje: zůstane ve stavu „nejasné“ a rozhodne uživatel.

Poštu lze poslat dvěma způsoby. Sdílený server instance nastavují proměnné `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. Vlastní server si uživatel nastaví v Nastavení > Pošta a má
přednost. Heslo je v databázi šifrované přes `ENCRYPTION_KEY`. Bez SMTP aplikace funguje dál, jen
odeslání není dostupné a PDF se stahuje ručně.

Adresa vlastního serveru je cizí vstup, proto aplikace odmítne privátní, lokální a metadatové adresy
a kontroluje je znovu při každém spojení, i po překladu DNS (ochrana SSRF). Na vlastní síti to vypne
`ALLOW_PRIVATE_MAIL_HOSTS=1` (platí i pro IMAP schránku s avízy z banky), což je vhodné jen tam, kde všem uživatelům instance důvěřujete.

## HTML e-maily

Zprávy klientovi (faktura, záloha, upomínka, potvrzení platby) odcházejí jako HTML s textovou
alternativou, která je přesně text z historie odeslání. Vzhled se vybírá v Nastavení > Pošta >
Vzhled e-mailu ze sedmi variant: B1 Základní karta, B2 Karta s QR vedle částky, B3 Platební blok,
B4 Tmavá hlavička (výchozí), B5 Na střed, A Dopis a C Akcent. QR platba je jen ve vzhledech B2, B3
a B5 a jen u faktury, zálohy a upomínky. Pás B4 a linka C berou barvu akcentu z designu dokladu.
Tamtéž jde nastavit úvod, podpis a logo (logo dodavatele, vlastní logo, nebo bez loga).

Zpráva nemá vzdálené obrázky, skripty ani sledovací odkazy: QR a logo jsou přílohy (`cid:`) a každý
text je escapovaný. HTML se sestaví jednou při první přípravě zprávy a archivuje se. Opakovaný pokus
pošle tentýž archiv, takže pozdější změna vzhledu zprávu ve frontě nezmění. Historie odeslání
nabízí stažení HTML.

Vyzkoušení: stránka Vzhled e-mailu ukazuje náhled vybraného vzhledu s ukázkovou fakturou a s vaším
logem, úvodem a podpisem (po uložení). Jak
zpráva vypadá ve skutečném klientovi (Gmail, Outlook, Apple Mail), ověříte odesláním faktury
zákazníkovi s vlastní e-mailovou adresou. Outlook vykresluje HTML jinak než prohlížeč, tabulková
kostra a inline styly rozdíly jen zmírní.

## Zahraniční faktury a zálohy

Kurzy stahuje plánovač z denního lístku ČNB (`CNB_BASE_URL`, mění se jen kvůli testům) jednou za hodinu
od 14:45, dokud lístek nemá. Síť nikdy neběží při vystavení ani při platbě, ty čtou jen uložené kurzy.
Když ČNB nejde stáhnout, aplikace funguje dál: použije poslední známý kurz a upozorní na to. Kdyby
žádný neměla, kurz zadá člověk ručně, pravidelná faktura v cizí měně zůstane jako koncept. Výpadek se
do monitoringu nehlásí, teprve když chybí 3 pracovní lístky (viz Monitoring).

Kurz se zamrazí vystavením, pozdější lístek ho nezmění. Na PDF se netiskne: neplátce ho na dokladu
nepotřebuje a přepočet do CZK slouží jen přehledům.

Doložka o přenesení daňové povinnosti je předvyplněný návrh pro identifikovanou osobu a zákazníka
s DIČ z EU, aplikace nepozná službu od zboží. **Znění doložek, text „Toto není daňový doklad.“
a název „Opravná faktura“ pro neplátce musí před ostrým použitím ověřit daňový poradce.** Výchozí
texty jdou upravit v nastavení dodavatele.

Po úhradě zálohy se řídí Nastavení > Automatizace, volbou „Po úhradě zálohy“: `off` nic nezaloží,
`draft` (výchozí) připraví koncept konečné faktury a `issue` ji vystaví. Odeslat ji může jen zapnutá
automatika „Odeslání po záloze“ a jen v režimu `issue`. Hlavní vypínač změní `issue` na `draft`.
Vrácení platby zálohy fakturu nezruší, jen upozorní, že opět chce doplatek.

Výchozí řady `{RRRR}-{NNN}` pro faktury a `Z{RRRR}-{NNN}` pro zálohy dávají stejný variabilní
symbol (`Z2026-001` i `2026-001` mají VS `2026001`). Řady se kvůli zvyku stávajících účtů nemění.
Avízo se pak spáruje podle měny, zbývající částky a účtu. Když sedí oba doklady, čeká ve frontě
na ruční přiřazení. Kdo chce VS oddělit, změní si řadu záloh v Nastavení > Číselné řady.

## Avíza z banky

Fakturan páruje platby z e-mailových avíz Fio banky. Ve Fio internetbankingu zapněte v Nastavení >
Oznámení > Uživatelská oznámení posílání příchozích pohybů e-mailem, přesný postup je v aplikaci
v Nastavení > Avíza z banky. Tam vyplňte i schránku: server IMAP, port 993 s TLS nebo 143 se STARTTLS,
uživatele a heslo. Heslo je v databázi šifrované přes `ENCRYPTION_KEY`.

Doporučujeme samostatnou schránku jen pro avíza. Aplikace ji čte pouze ke čtení, nic v ní nemaže ani
neoznačuje a kontroluje ji každých 5 minut. Tělo stahuje jen u zpráv od `automat@fio.cz`, při prvním
čtení jde nejvýš 30 dní zpět.

Automaticky se uhradí jen avízo, které sedí přesně: variabilní symbol, měna, částka a účet jednoho
dokladu. Ostatní čekají ve frontě v Platby. Přepínač „Vyžadovat potvrzení“ (`require_confirmation`,
výchozí stav zapnuto) rozhoduje o avízech, u kterých důvěryhodný server schránky nevyplnil výsledek
ověření odesílatele: se zapnutým přepínačem jdou do fronty, s vypnutým se párují automaticky. Vypnutí
znamená, že zaplacení faktury může spustit i zpráva s podvrženým odesílatelem, změna se proto zapisuje
do auditu zvlášť. Bez vyplněného serveru ověření (authserv-id) jde do fronty každé avízo bez ohledu
na přepínač.

Přeposílání: nejlépe nechte Fio posílat avíza přímo do čtené schránky. Přeposláním na jinou adresu
přestane sedět SPF, projde jen podpis DKIM, pokud ho přeposílající server nezmění. Zpráva bez platného
podpisu vypadá stejně jako podvržená, skončí jako neověřená s výsledkem `fail` a čeká ve frontě bez
ohledu na přepínač. Server ověření musí být ten, který zprávu přijal do čtené schránky.

Česká avíza („Fio banka - příjem na účtu“) jsou ověřená na skutečném avízu z Fio a párují se
automaticky podle pravidel výše. Anglická varianta je sestavená jen z veřejných zmínek a se skutečným
avízem porovnaná není, proto je prozatímní: čte se, ale nikdy se nepáruje automaticky a ve frontě má
štítek „Prozatímní formát“. V internetbankingu proto zvolte český formát avíza.

## Statistiky a dashboard

Statistiky (`/prehledy`) a widgety dashboardu se počítají na serveru z dat účtu. Výsledek se drží
v cache Next (`"use cache"`, nejvýš hodiny) pod klíčem s ID uživatele a **razítkem účtu**: razítko
skládá nejvyšší ID záznamu v historii změn účtu a čas posledního staženého kurzu ČNB. Každý zápis
do účtu, i z plánovače, razítko změní, takže se další zobrazení spočítá znovu a staré číslo se
neukáže. Cache drží jen paměť procesu (`cacheMaxMemorySize` 50 MB), po restartu je prázdná.

Dashboard i jednotlivý widget jde exportovat jako JSON a importovat do jiného účtu nebo instance.
Soubor nese jen nastavení widgetů, žádná data, má nejvýš 64 KiB a 50 widgetů. Import ukáže náhled
nad daty cílového účtu, založí nový dashboard a stávající nezmění. Filtr na zákazníky, které cílový
účet nemá, se zahodí. Soubor z novější verze aplikace import odmítne s výzvou k aktualizaci.

## Asistenti (MCP)

Fakturan umí zpřístupnit data AI asistentovi (Claude Code, Claude.ai) přes protokol MCP na adrese
`<BETTER_AUTH_URL>/api/mcp`. Přihlášení běží přes OAuth, asistent nikdy nezná vaše heslo.

**Zapnutí.** Každý uživatel si přístup povoluje sám v Nastavení › Asistenti volbou „Povolit
připojení asistentů“ (ve výchozím stavu je vypnutá). Na stejné stránce je adresa pro asistenty
s tlačítkem Kopírovat a stručný návod. Proměnná `MCP_ENABLED` (výchozí `true`) vypíná MCP pro celou
instanci: endpoint, metadata OAuth i autorizace pak odpovídají 404 a stránka Asistenti se
nezobrazí. V režimu ukázky (`DEMO_MODE`) je MCP vypnuté vždy, protože ukázkový účet je veřejný.

**Připojení.**

- Claude Code: `claude mcp add --transport http fakturan <BETTER_AUTH_URL>/api/mcp`. Při prvním
  použití se otevře prohlížeč, přihlásíte se do Fakturanu a asistentovi přístup povolíte.
- Claude.ai: Settings › Connectors › Add custom connector a vložte stejnou adresu. Claude.ai se
  připojuje z internetu, instance proto musí být dostupná na veřejné adrese s HTTPS.

**Adresa.** `BETTER_AUTH_URL` musí být přesně ta adresa, kterou asistent používá: z ní se skládá
adresa endpointu, vydavatel tokenů i příjemce, kterému tokeny patří, a token pro jinou adresu se
odmítne. Na `http://localhost:3000` funguje Claude Code spuštěný na stejném počítači. Webové
asistenty tak nepřipojíte. Pro ně použijte veřejnou adresu instance nebo při vývoji tunel
(například Cloudflare Tunnel či ngrok) a jeho adresu nastavte do `BETTER_AUTH_URL`.

**Server volá sám sebe.** Endpoint ověřuje podpis tokenů klíči z `BETTER_AUTH_URL/api/auth/jwks`,
tedy dotazem na vlastní veřejnou adresu. Nasazená instance se proto musí ke své veřejné adrese
dostat i zevnitř (DNS a síť kontejneru, takzvaný hairpin). Když ne, každé volání asistenta skončí
chybou HTTP 500 zhruba po 5 sekundách.

**Co asistent umí.** Přehled účtu (`get_overview`), neuhrazené faktury (`list_unpaid_invoices`),
detail faktury (`get_invoice`), hledání zákazníků a ceníku (`search_customers`, `search_catalog`)
a zakládání konceptů faktur bez čísla (`create_draft_invoice`). Koncept nic nevystaví ani
neodešle, vystavíte ho sami ve webu; opakované volání se stejným `idempotency_key` vrátí týž
koncept. Schopnosti se přepínají v Nastavení › Asistenti: Číst je zapnuté, Zakládat koncepty je
ve výchozím stavu vypnuté. Úpravy konceptů, vystavování a odesílání jsou připravené v nastavení, ale
zatím nejdou zapnout. Přepínače se kontrolují při každém volání, změna platí hned bez nového
připojení.

**Odpojení a limity.** Tlačítko Odpojit u asistenta v Nastavení › Asistenti zruší jeho přístup
okamžitě, i když má ještě platný token. Jeden asistent smí provést nejvýš 60 volání za minutu,
další dostane HTTP 429 s hlavičkou `Retry-After`. Volání asistentů se zapisují do historie změn
jako zdroj „Asistent“.

## Provoz za reverzní proxy

Za reverzní proxy (Coolify, Traefik, nginx) je nutné nastavit `TRUST_PROXY=1`. Bez něj aplikace
nezná IP klienta, všichni klienti sdílejí jeden bucket rate limitu (20 přihlášení za minutu a
5 registrací za hodinu na celou instanci) a audit IP neeviduje. Proxy musí `X-Forwarded-For`
přepisovat nebo k němu přidávat, nikdy ho nepředávat od klienta beze změny. V produkci bez
`TRUST_PROXY` aplikace při startu zapíše varování.

Proxy musí pustit tělo požadavku aspoň 1 GiB na `POST /nastaveni/zaloha/nahrani` (nahrání zálohy
k obnově) a 25 MB na `POST /nastaveni/import/nahrani`. V nginx `client_max_body_size 1g;` pro tuto
cestu, v Traefiku middleware `buffering` s `maxRequestBodyBytes`. Nižší limit skončí chybou 413
z proxy dřív, než požadavek dorazí do aplikace.

## Provoz

### Výkon

`node scripts/perf-measure.ts [--documents 30000]` založí dočasnou databázi s jedním účtem
(zadaný počet dokladů, dvě platby na doklad, pět záznamů auditu na doklad) a vypíše počet dotazů
a časy horkých cest a velikost položek cache. Databázi po sobě smaže. Měření ze 7. 11. 2026
(30 000 dokladů, 60 000 plateb, 150 000 záznamů auditu, medián ze čtyř běhů):

| Krok                                               | Dotazů |             Medián |
| -------------------------------------------------- | -----: | -----------------: |
| zvonek                                             |      9 |              69 ms |
| výhled (`forecast`)                                |      2 |              37 ms |
| razítko účtu (`accountStamp`)                      |      2 |             0,1 ms |
| `reportSummary` letos / vše                        |      4 |        72 / 121 ms |
| `listInvoices` výchozí / podle zákazníka / hledání |      2 |  0,5 / 96 / 2,5 ms |
| přehledy (`reportBundle`) letos / vše              |     41 |       522 / 864 ms |
| daňový přehled                                     |      2 |             212 ms |
| 22 widgetů galerie                                 |     65 | nejpomalejší 85 ms |

Položky cache: přehledy 8 až 21 KiB, daňový přehled 810 KiB (nejvýš 2 000 řádků na tabulku),
všech 22 widgetů galerie dohromady 1,3 MiB. Jeden takový účet tedy zabere asi 2,1 MiB, a proto
`cacheMaxMemorySize` v `next.config.ts` zůstává na výchozích 50 MB, nastavených výslovně.

Známá omezení: přehledy účtu s desítkami tisíc dokladů se počítají přes půl sekundy (522 ms za
letošek, 864 ms za celé období). Výsledek se drží v cache, dokud se data účtu nezmění, takže
se čeká jen na první zobrazení po změně.

### Paměť kontejneru

Doporučená paměť kontejneru je **aspoň 1,5 GB**. Node odvozuje limit haldy z paměti kontejneru
(změřeno v obrazu `node:24-bookworm-slim`: 1 GB dá haldu 560 MiB, 1,5 GB dá 864 MiB). Obnova
a vytvoření zálohy smí držet až 640 MiB (čtená položka archivu do 200 MiB mimo haldu, mapa ID,
dávka zápisu) a odmítnou se, když halda přesáhne 75 % limitu. Vykreslení dlouhého PDF zabere
dalších až ~480 MiB (500 položek). S menší pamětí aplikace funguje, jen velkou zálohu odmítne
a souběh obnovy s PDF může narazit na limit kontejneru.

### Data na svazku a retence

Noční zálohy databáze leží na stejném svazku jako data. Kopírujte je pravidelně i mimo svazek
(jiný disk, jiný stroj), třeba nočním `docker cp <kontejner>:/data/backups`, jinak ztráta disku
vezme data i zálohy. Složka `files/` v noční záloze není, kopírujte ji spolu s ní.

Odeslaná PDF, ISDOC a HTML zprávy (`files/`) se nikdy nemažou: tvoří historii odeslání a účetní
doklad se uchovává 10 let. Kvóta na účet není. Velikost `files/` a volné místo ukazuje Administrace;
velikost je součet evidovaných souborů z databáze, přepočítaný nejvýš jednou za hodinu, takže
mezisoubory rozpracovaných importů a obnov v ní nejsou. Plánovač hlásí volné místo pod 2 GiB nebo
pod 10 % do monitoringu. Exporty a zálohy účtů zmizí po 7 dnech, nepotvrzené importy a mezisoubory
obnovy se uklízejí samy.

## Postup vydání

1. Zvyšte `version` v `package.json`. Verze se ukazuje v Administraci a zapisuje do záloh účtů.
2. Přidejte bod vydání databáze `tests/fixtures/db/<verze>.sql` (postup v
   `tests/fixtures/db/README.md`). Starší soubory se nemění.
3. Změnil se od minulého vydání registr zálohy? Pak zvyšte `BACKUP_VERSION`, přidejte
   `columns-v<n>.json` a krok `BACKUP_UPGRADES` (viz Vývoj). Otisk v2 je zmrazený.
4. Projděte všechny kontroly po částech (Vývoj) a mutační bránu jádra
   `pnpm run test:mutation:summary -- --core`.
5. `pnpm audit`. Nález v balíčku, který jde do běžícího obrazu, řešte před vydáním. Aktualizace
   respektuje `minimumReleaseAge` v `pnpm-workspace.yaml`, nikdy ho neobcházejte.
6. Docker po vrstvách, každý krok zvlášť:

   ```bash
   docker build --target deps .
   docker build --target build .
   docker build -t fakturan-ci .
   E2E_DOCKER_IMAGE=fakturan-ci pnpm exec playwright test docker-scheduler
   ```

7. Nasaďte ručně (v Coolify tlačítkem Deploy, auto-deploy není nastavený). Po startu zkontrolujte
   `/api/health` a Administraci.

## Ukázka

Veřejná ukázka: <https://fakturan-demo.onrender.com> (Render, bezplatný plán: po 15 minutách bez
návštěvy usne, první načtení pak trvá do minuty a data ukázky se při uspání založí znovu).

Ukázka je běžná instance s `DEMO_MODE=1` (OPS-007). Má jeden účet se smyšlenými daty za 18 měsíců
(Zkušební s. r. o., vymyšlená IČO s platným součtem): faktury v CZK i EUR, zálohu s konečnou
fakturou, opravnou fakturu, platby, fakturu po splatnosti s pravidlem upomínky, pravidelný plán
a dashboard. Registrace je vypnutá, pošta nikdy neodejde a nastavení pošty ani schránky avíz nejde
uložit. Heslo, e-mail ani samotný účet ukázky změnit nebo smazat nejde. Každou noc ve 3:30 se účet
smaže stejnou cestou jako při smazání účtu a založí znovu. Ostatní účty na instanci zůstanou
netknuté. Přihlašovací údaje se berou z `DEMO_EMAIL` a `DEMO_PASSWORD` a přihlašovací stránka je
ukáže. Bez nich se aplikace s `DEMO_MODE=1` nespustí. `DEMO_PASSWORD` je tím veřejné: zvolte heslo, které
nikde jinde nepoužíváte, a nikdy nepoužijte heslo ostrého účtu. Odkazy na sociální přihlášení,
změnu profilu a ukončení cizích relací jsou pro účet ukázky zamčené.

`DEMO_EMAIL` dejte na doménu, na kterou nikdo nemůže dostat poštu, například
`ukazka@fakturan.example` (doména `.example` je vyhrazená a neexistuje). Sociální přihlášení
s ověřeným e-mailem, který se shoduje s `DEMO_EMAIL`, by se jinak mohlo připojit k účtu ukázky.
Na ukázkové instanci proto sociální přihlášení nenastavujte vůbec.

Nasazení v Coolify (ručně, auto-deploy není):

1. Nová aplikace ze stejného obrazu (Dockerfile) jako ostrá instance, s vlastním svazkem `/data`.
   Svazek ostré instance nikdy nesdílejte.
2. Proměnné: `DEMO_MODE=1`, `DEMO_EMAIL` (na doméně `.example`), `DEMO_PASSWORD`, vlastní `BETTER_AUTH_URL`,
   `BETTER_AUTH_SECRET` a `ENCRYPTION_KEY`, `SENTRY_ENVIRONMENT=demo` (a stejný `SENTRY_DSN`, chcete-li
   chyby ukázky v GlitchTipu) a `TRUST_PROXY=1`. Ukázka běží za Traefikem a bez `TRUST_PROXY` by
   všichni návštěvníci sdíleli jeden limit přihlášení podle IP (20 za minutu na celou ukázku).
   `SMTP_*` nenastavujte. Ukázka je i tak nepoužije.
3. Nasaďte ručně tlačítkem Deploy.
4. Napoprvé založte data hned:

   ```bash
   docker exec <kontejner> node scripts/demo-seed.mjs
   ```

   Skript je bundle ze `scripts/demo-seed-entry.ts`. Spustí migrace, založí účet a vypíše počet
   dokladů. Když účet už existuje, nic nezmění. Bez tohoto kroku založí ukázku plánovač
   při prvním ticku.

Na malém builderu (Render free) nastavte `NEXT_BUILD_CPUS=2`, jinak build při sběru dat stránek
dojde paměť. Render obraz nesvazkuje, `DATA_DIR=/data` stačí jako obyčejná složka.

## Ověření importu proti zdroji (TST-020)

Ruční krok nad skutečnými doklady, vždy mimo repozitář:

1. Na testovací instanci importujte export ze zdrojového systému (ZIP s ISDOC nebo PDF).
2. Zastavte instanci a zkopírujte `fakturan.db` mimo složku dat.
3. Spusťte `node scripts/import-compare.ts <export.zip> <kopie.db> [id účtu]`. Skript čte soubor
   stejnými čtečkami jako import, kopii databáze jen načte do paměti a nic nezapisuje.
4. Výpis obsahuje jen počty a součty podle roku a měny pro zdroj a pro Fakturan a sloupec shody.
   Porovnejte je i se součty ve zdrojovém systému. Skutečné doklady ani výpis do repozitáře
   nepatří (`.gitignore` hlídá `*.isdoc`, `isdoc-faktury-*.zip` a `local-samples/`).

## Licence

MIT

Schémata ISDOC v `src/server/isdoc/schema/` jsou nezměněné kopie z isdoc.cz a řídí se vlastní
licencí v jejich hlavičce (text je i v `src/server/isdoc/schema/LICENSE.txt`), ne licencí MIT.

## Přihlašování

První registrovaný účet se stane administrátorem, další vznikají jen pozvánkou. Sociální přihlášení
se zapne nastavením klíčů poskytovatele v `.env`; bez nich se tlačítko nezobrazí.

Apple vyžaduje placený účet Apple Developer a HTTPS a jeho tajemství platí nejvýš 6 měsíců. Fakturan
ho proto generuje při startu z `APPLE_PRIVATE_KEY` s platností 180 dní, aplikaci je tedy potřeba
aspoň jednou za tu dobu restartovat.
