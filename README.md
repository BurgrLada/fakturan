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

Automatická denní záloha se připravuje. Do té doby zálohujte svazek ručně, nejlépe při zastaveném
kontejneru:

```bash
docker stop fakturan
docker run --rm -v fakturan-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/fakturan-data.tgz -C /data .
docker start fakturan
```

Obnova: zastavte kontejner, vyprázdněte svazek a rozbalte zálohu, pak kontejner spusťte.

```bash
docker stop fakturan
docker run --rm -v fakturan-data:/data -v "$PWD":/backup debian:bookworm-slim \
  sh -c 'rm -rf /data/* && tar xzf /backup/fakturan-data.tgz -C /data && chown -R 1000:1000 /data'
docker start fakturan
```

Záloha musí obsahovat soubory `fakturan.db*` pohromadě (databáze běží v režimu WAL).

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
