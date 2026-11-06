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

## Konfigurace

Všechno se nastavuje proměnnými prostředí, úplný seznam s popisem je v `.env.example`. Povinné jsou
`BETTER_AUTH_URL` (veřejná adresa), `BETTER_AUTH_SECRET` (min. 32 znaků) a `ENCRYPTION_KEY`
(32 bajtů v base64). Ostatní (SMTP, sociální přihlášení, `SENTRY_DSN`, `TRUST_PROXY`) jsou volitelné.
Proměnné se čtou za běhu, jeden obraz tedy slouží pro libovolný počet instancí.

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

Chyby serveru i prohlížeče jdou do služby kompatibilní se Sentry (Sentry, GlitchTip), když nastavíte
`SENTRY_DSN`. Prohlížeč posílá události přes `/api/monitoring` na stejné adrese, takže se
Content-Security-Policy nemění. Odesílá se jen ID uživatele, ne e-mail, IP ani obsah faktur.

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
aplikace nedovolí uložit. PDF dokladu (stažení, odeslání i export) vznikne nejvýš z 200 000 znaků
textu; nad tím aplikace PDF nevytvoří a řekne proč. Starší šablonu, plán nebo koncept nad strop záloha pojmenuje
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

## Zahraniční faktury a zálohy

Kurzy stahuje plánovač z denního lístku ČNB (`CNB_BASE_URL`, mění se jen kvůli testům) jednou za hodinu
od 14:45, dokud lístek nemá. Síť nikdy neběží při vystavení ani při platbě, ty čtou jen uložené kurzy.
Když ČNB nejde stáhnout, aplikace funguje dál: použije poslední známý kurz a upozorní na to. Kdyby
žádný neměla, kurz zadá člověk ručně, pravidelná faktura v cizí měně zůstane jako koncept. Výpadek se
do Sentry nehlásí, teprve lístek starý 5 a více dní.

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

Česká avíza jsou zatím prozatímní: formát není ověřený na skutečném vzorku, proto se čtou, ale nikdy
se nepárují automaticky a ve frontě mají štítek „Prozatímní formát“. Automaticky se páruje jen
anglická varianta.

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
