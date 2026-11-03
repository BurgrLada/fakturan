# Smyšlené doklady ISDOC

Všechny doklady v této složce jsou vymyšlené (IMP-013). Firmy, adresy, účty i UUID neexistují,
IČO 99900017, 99900025, 99900033, 99900041 a 99900050 mají jen platný kontrolní součet.
Struktura odpovídá schématu ISDOC 6.0.2 (`verze-601.isdoc` 6.0.1) a tomu, jaké elementy plní
běžné exporty; žádná hodnota není převzatá ze skutečné faktury.

| Soubor                     | Co pokrývá                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| `faktura-czk.isdoc`        | faktura v CZK, dvě položky, neuhrazená                                      |
| `faktura-eur.isdoc`        | faktura v EUR s částkami `*Curr`, kurz 25,125, zahraniční odběratel bez IČO |
| `dobropis.isdoc`           | dobropis (typ 2) s kladnými částkami a odkazem na `faktura-czk`             |
| `zalohova.isdoc`           | zálohová faktura (typ 4)                                                    |
| `konecna-se-zalohou.isdoc` | konečná faktura s `NonTaxedDeposit` na `zalohova`                           |
| `uhrazena.isdoc`           | `PayableAmount` 0                                                           |
| `castecne-uhrazena.isdoc`  | `PayableAmount` menší než celek                                             |
| `verze-601.isdoc`          | verze 6.0.1 s `PayableRoundingAmount`                                       |
| `cizi-dodavatel.isdoc`     | dodavatel s jiným IČO než profil                                            |
| `vrubopis.isdoc`           | vrubopis (typ 3), který import nepřijímá                                    |

Test `[IMP-013]` v `tests/unit/isdoc-parse.test.ts` hlídá, že žádná fixtura nemá jiné IČO než
výše uvedená.
