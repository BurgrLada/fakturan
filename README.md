# Fakturan

Jednoduchá fakturace pro české OSVČ. Next.js, shadcn/ui, SQLite.

## Vývoj

```bash
npm install
npm run dev
```

Kontroly: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`.

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
