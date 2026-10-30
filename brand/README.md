# Značka Fakturan

Logo je `fakt[U]ran`: slovo malými písmeny a uprostřed dlaždice uranu z periodické tabulky (prvek 92).

## Soubory

| Soubor | Použití |
|---|---|
| `logo.svg` | světlé pozadí |
| `logo-dark.svg` | tmavé pozadí |
| `logo-mono.svg` | jedna barva, přebírá `currentColor` |
| `favicon.svg`, `favicon.ico` | záložka prohlížeče, zjednodušené U bez čísla 92 |
| `icon.svg`, `icon-192.png`, `icon-512.png` | větší ikona s číslem 92 |
| `apple-touch-icon.svg`, `apple-touch-icon.png` | ikona pro iOS, bez zaoblení a průhlednosti |
| `tokens.css` | barvy a písmo pro světlý a tmavý režim |

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

## Barvy

| Role | Světlý režim | Tmavý režim |
|---|---|---|
| Pozadí (papír) | `#F7F4EE` | `#1E1A1C` |
| Text | `#1E1A1C` | `#F7F4EE` |
| Akce | `#652335` | `#C9708A` |
| Text na akci | `#F7F4EE` | `#1E1A1C` |
| Jemná plocha | `#E7C469` | `#4D4026` |
| Text na jemné ploše | `#1E1A1C` | `#F7F4EE` |
| Dlaždice loga | `#C6EC3E` | `#C6EC3E` |
| Text na dlaždici | `#1E1A1C` | `#1E1A1C` |

## Pravidla

- Dlaždice je v obou režimech zelená a text na ní vždy tmavý.
- Zelená dlaždice není barva textu, na světlém pozadí je nečitelná.
- `#652335` se na tmavém pozadí nepoužívá, kontrast je jen 1,5:1.
- Na malých plochách se používá `favicon.svg`, číslo 92 pod 32 px splývá.
- Logo se nepřekresluje živým textem, písmo je v SVG převedené na křivky.

## Písmo

Space Grotesk Bold pro název a U, Space Mono Bold pro číslo 92. Obě jsou pod licencí SIL OFL a jsou v `zdroj/fonts/`.

## Přegenerování

```bash
pip install fonttools uharfbuzz
python3 zdroj/generuj.py
```

Skript přepíše SVG soubory. PNG a ICO se z nich exportují zvlášť.

`koncepty/` a `barvy.html` jsou archiv průzkumu, `nahled.html` ukazuje aktuální podobu.
