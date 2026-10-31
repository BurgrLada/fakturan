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
`ALLOW_PRIVATE_MAIL_HOSTS=1`, což je vhodné jen tam, kde všem uživatelům instance důvěřujete.

## Provoz za reverzní proxy

Za reverzní proxy (Coolify, Traefik, nginx) je nutné nastavit `TRUST_PROXY=1`. Bez něj aplikace
nezná IP klienta, všichni klienti sdílejí jeden bucket rate limitu (20 přihlášení za minutu a
5 registrací za hodinu na celou instanci) a audit IP neeviduje. Proxy musí `X-Forwarded-For`
přepisovat nebo k němu přidávat, nikdy ho nepředávat od klienta beze změny. V produkci bez
`TRUST_PROXY` aplikace při startu zapíše varování.

## Licence

MIT

## Přihlašování

První registrovaný účet se stane administrátorem, další vznikají jen pozvánkou. Sociální přihlášení
se zapne nastavením klíčů poskytovatele v `.env`; bez nich se tlačítko nezobrazí.

Apple vyžaduje placený účet Apple Developer a HTTPS a jeho tajemství platí nejvýš 6 měsíců. Fakturan
ho proto generuje při startu z `APPLE_PRIVATE_KEY` s platností 180 dní, aplikaci je tedy potřeba
aspoň jednou za tu dobu restartovat.
