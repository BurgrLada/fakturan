# Fakturan: specifikace aplikace

Licence: MIT. Verze: návrh z 30. 10. 2026. Stav: čeká na schválení.

Dokument je zdrojem pravdy pro implementaci a testy. Každý požadavek má ID (např. `INV-012`). Na ID se odkazují testy, viz kapitola 22.

Označení původu rozhodnutí:

- bez označení: rozhodnutí zadavatele,
- **[návrh]**: rozhodnutí autora specifikace, které zadavatel může změnit.

---

## 1. Záměr

Fakturan je jednoduchý open-source fakturační software pro lidi, kteří fakturují sami za sebe a nechtějí platit za funkce, které jinde stojí navíc nebo chybí. Provozuje se jako vlastní instance. Inspirací je Fakturovač a Fakturoid, ale s bohatšími pravidelnými fakturami (např. čtvrtletí), přizpůsobitelným dashboardem a úplnou kontrolou nad daty.

Hlavní zásady:

1. **Co nejméně práce.** Běžná faktura vznikne na pár kliknutí, protože nastavení obsahuje co nejvíc výchozích hodnot.
2. **Nic neodejde klientovi bez předchozího svolení.** Každá automatika vůči klientovi je ve výchozím stavu vypnutá a uživatel ji musí sám zapnout.
3. **Každý účet je izolovaný.** Na fakturách, zákaznících ani nastavení se nespolupracuje.
4. **Všechno se dá vystopovat.** Audit log zachycuje každou změnu a každou citlivou akci.
5. **Přizpůsobení bez forku.** Dashboard, volba designu, barvy a texty se mění v aplikaci, ne v kódu. Vlastní barvy faktury jsou v základu, editor rozložení faktury v první verzi není.

## 2. Cíle a mimo rozsah

### 2.1 Cíle první verze

- vystavování faktur, zálohových faktur a opravných faktur,
- evidence zákazníků, ceník, šablony, pravidelné faktury,
- faktury v češtině a angličtině, v korunách i cizích měnách,
- QR platba, logo, široká nabídka designů,
- odesílání e-mailem, upomínky, kontrola plateb z avíz Fio,
- přizpůsobitelný dashboard, přehledy, importy a exporty, daňový přehled,
- auth s pozvánkami a administrátorem, audit log, rate limiting, napojení na monitoring chyb.

### 2.2 Co by byl neúspěch, i kdyby to technicky fungovalo

- Aplikace pošle klientovi cokoli, co uživatel předem nepovolil.
- Uživatel uvidí data jiného uživatele, nebo je uvidí administrátor.
- Spuštění plánované úlohy dvakrát vystaví nebo odešle jednu fakturu dvakrát.
- Běžná faktura vyžaduje opakované vyplňování údajů, které už aplikace zná.

### 2.3 Zatím neplánujeme

- evidence nákladů a přijatých dokladů,
- plátci DPH, výpočet DPH, kontrolní hlášení, přiznání k DPH,
- příjmový pokladní doklad a dodací list,
- exporty pro účetní programy (Pohoda, Money S3),
- přílohy k faktuře,
- dodací adresa zákazníka,
- sklad a prodejky,
- cenové nabídky,
- přístup pro účetní jen ke čtení,
- odchozí webhooky,
- podání přímo na daňový portál,
- platební brány a online platba z odkazu,
- veřejný odkaz na fakturu pro klienta,
- veřejná registrace pro kohokoli; vyžádala by zásady ochrany osobních údajů, obchodní podmínky a další právní texty,
- sdílení dat mezi uživateli, týmy, více firem pod jedním účtem,
- mobilní aplikace,
- rozhraní v jiném jazyce než v češtině.

### 2.4 Rozšíření

Není součástí první verze, ale architektura s ním počítá:

- **API tokeny a MCP přístup.** Doménová logika proto žije v servisní vrstvě nezávislé na UI (viz 19.2).
- **2FA (TOTP) a passkeys** přes pluginy Better Auth.
- **Widget s vlastním kódem** v izolovaném sandboxu: iframe bez přístupu k session, síti a stejnému originu, data dostane jen přes `postMessage`.
- **Editor rozložení faktur** v aplikaci.
- **Další banky** přes nové parsery avíz. **Fio API.** Univerzální open banking.
- **Souhrnné hlášení** pro identifikované osoby.
- **Další jazyky faktur**, rozhraní s i18n.

---

## 3. Role a účty

| Role | Co smí |
|---|---|
| Uživatel | Spravuje jen vlastní data, nastavení a fakturaci. |
| Administrátor | Totéž co uživatel, navíc sekce Administrace: uživatelé a pozvánky. Data jiných uživatelů nevidí. |

Administrátor je běžný uživatel s vlastní fakturací. Primární scénář je instance s jediným člověkem, který je zároveň administrátorem.

---

## 4. Přihlašování a uživatelé (AUTH)

Technologie: Better Auth.

- **AUTH-001** První registrovaný účet na prázdné instanci se stane administrátorem. Po jeho vzniku se veřejná registrace uzavře.
- **AUTH-002** Další účty vznikají pouze přijetím pozvánky. Pokus o registraci bez platné pozvánky selže na straně serveru, nejen v UI.
- **AUTH-003** Přihlášení e-mailem a heslem.
- **AUTH-004** Přihlášení přes Google, GitHub, Microsoft a Apple. Každý poskytovatel se v UI zobrazí jen tehdy, když instance nastaví jeho klíče v konfiguraci.
- **AUTH-005** Sociální přihlášení nikdy nezaloží účet bez pozvánky. E-mail musí odpovídat existujícímu účtu nebo platné pozvánce.
- **AUTH-006** **[návrh]** Propojený účet poskytovatele jde přidat a odebrat v nastavení. Poslední způsob přihlášení odebrat nelze.
- **AUTH-007** Apple skrývá e-mail přes přeposílací adresu, proto přijetí pozvánky přes Apple funguje přes pozvánkový odkaz, který účet propojí, ne přes shodu e-mailu.
- **AUTH-008** Reset hesla e-mailem, odkaz je jednorázový a platí 1 hodinu **[návrh]**.
- **AUTH-009** Ověření e-mailu pro účet s heslem. U prvního účtu se nevyžaduje, když instance nemá nastavené SMTP **[návrh]**.
- **AUTH-010** Heslo má aspoň 12 znaků. Kontrola proti známým uniklým heslům se provádí lokálním seznamem, heslo neopouští server **[návrh]**.
- **AUTH-011** Uživatel vidí aktivní relace a může je ukončit, včetně všech ostatních.
- **AUTH-012** Změna e-mailu vyžaduje potvrzení na novou adresu. Změna hesla ukončí ostatní relace.
- **AUTH-013** Odhlášení zneplatní relaci na serveru.
- **AUTH-014** Doba relace 30 dní s obnovou při aktivitě **[návrh]**.
- **AUTH-015** Dokumentace uvádí, že Apple vyžaduje placený účet Apple Developer, HTTPS a obnovu tajemství nejpozději po 6 měsících. Tajemství se proto generuje v konfiguraci auth z privátního klíče, ne ručně.

### Administrace (ADM)

- **ADM-001** Sekce Administrace je viditelná a dostupná jen administrátorovi. Přímý přístup jiného uživatele vrátí 403 nebo 404.
- **ADM-002** Seznam uživatelů: jméno, e-mail, role, stav, datum vzniku, poslední přihlášení.
- **ADM-003** Pozvání uživatele e-mailem. Pozvánka platí 7 dní **[návrh]**, jde zrušit a znovu odeslat. Kopírovatelný odkaz je dostupný i bez SMTP.
- **ADM-004** Změna role uživatele. Poslední administrátor nesmí přijít o roli, být deaktivován ani smazán.
- **ADM-005** Deaktivace uživatele okamžitě ukončí jeho relace a zastaví jeho plánované úlohy. Reaktivace je obnoví, zmeškané pravidelné faktury se nedoženou automaticky, ale nabídnou se ke kontrole.
- **ADM-006** Smazání uživatele administrátorem vyžaduje opsání e-mailu a smaže všechna jeho data. UI před tím upozorní, že export si musí udělat sám uživatel; deaktivovaný uživatel se nepřihlásí, takže ho administrátor na export dočasně reaktivuje **[návrh]**.
- **ADM-009** Uživatel může smazat vlastní účet v nastavení po zadání hesla nebo opětovném přihlášení, s nabídkou zálohy předem. Poslední administrátor to nesmí, pokud na instanci zůstávají jiní uživatelé **[návrh]**.
- **ADM-007** Administrátor nemá žádnou cestu, jak číst faktury, zákazníky, nastavení ani audit jiného uživatele. Vidí jen metadata účtu z ADM-002 a události instance (AUD-008).
- **ADM-008** Přehled stavu instance: verze, velikost databáze a souborů, volné místo na svazku, stav plánovače, čas poslední zálohy, datum posledního kurzovního lístku ČNB, délka fronty těžkých úloh, nastavení SMTP a monitoringu, bez zobrazení tajemství.

---

## 5. Onboarding a nastavení (SET)

- **SET-001** Po prvním přihlášení průvodce: údaje dodavatele (předvyplnění z ARES), bankovní účet, číselná řada, logo, jazyk, design. Průvodce jde přeskočit.
- **SET-002** Dokud chybí povinné údaje dodavatele, nelze vystavit fakturu a UI řekne, co doplnit.

### 5.1 Profil dodavatele

- **SET-010** Jméno nebo firma, adresa, stát, IČO, DIČ, e-mail, telefon, web, údaj o zápisu v rejstříku, kontaktní osoba.
- **SET-011** Přepínač „identifikovaná osoba k DPH“ s DIČ. Viz 7.5.
- **SET-012** Výchozí text patičky, výchozí text „Nejsem plátce DPH.“ v češtině a angličtině, oba upravitelné.
- **SET-013** Podpis nebo razítko jako obrázek, volitelně na faktuře.
- **SET-014** Logo: PNG, JPEG, WebP nebo SVG, max. 2 MB **[návrh]**. Zvlášť logo na fakturu a logo do QR kódu, druhé může být prázdné.

### 5.2 Bankovní účty

- **SET-020** Libovolně mnoho účtů. Každý má název, číslo a kód banky nebo IBAN, SWIFT/BIC a měnu.
- **SET-021** Každé měně jde přiřadit výchozí účet. Faktura v dané měně ho použije automaticky, včetně QR platby a párování avíz.
- **SET-022** Účet použitý na existující faktuře nejde smazat, jen skrýt.

### 5.3 Výchozí hodnoty (preference)

Vše z tohoto seznamu se předvyplní do nové faktury a jde změnit u konkrétní faktury:

- **SET-030** Splatnost ve dnech (i s výjimkou na zákazníka), jazyk, měna, design, akcentní barva, způsob platby, jednotka, číselná řada.
- **SET-031** Zobrazit logo, zobrazit QR, zobrazit logo v QR, zobrazit podpis, zobrazit DUZP.
- **SET-032** Výchozí text před položkami a za nimi, výchozí poznámka.
- **SET-033** Datum vystavení: dnešek, nebo poslední den minulého měsíce.
- **SET-034** Výchozí formát data a formát variabilního symbolu.
- **SET-035** Vzhled aplikace: světlý, tmavý, podle systému. Volba se ukládá v účtu.

### 5.4 Automatizace

- **SET-040** Stránka Automatizace na jednom místě ukazuje každou automatiku vůči klientovi a její stav: odesílání pravidelných faktur, upomínky, potvrzení o přijetí platby, odeslání faktury po uhrazení zálohy.
- **SET-041** Všechny přepínače ve SET-040 jsou na novém účtu vypnuté. Test ověří každý z nich proti čisté databázi.
- **SET-042** Zapnutí automatiky vyžaduje potvrzení s popisem, co a komu se bude posílat.
- **SET-043** Globální hlavní vypínač „Pozastavit veškeré automatické odesílání“.

### 5.5 Pošta

- **SET-050** Odesílání používá SMTP instance. Uživatel může zadat vlastní SMTP, aby pošta chodila z jeho adresy, a tím instanční pro své faktury přebije.
- **SET-051** Test připojení odešle zkušební e-mail uživateli, ne klientovi.
- **SET-052** Vlastní hodnoty jde smazat a vrátit se k instančnímu SMTP.
- **SET-053** Bez dostupného SMTP je odeslání nedostupné a UI to vysvětlí. Stahování PDF funguje dál.
- **SET-054** Jméno odesílatele, adresa pro odpovědi, stálá kopie (Cc/Bcc).

---

## 6. Zákazníci (CUS)

- **CUS-001** Seznam se stránkováním, hledáním a filtrem (zahraniční, s dluhem, archivovaní).
- **CUS-002** Údaje: název, adresa, stát, IČO, DIČ/VAT ID, e-mail fakturace, další e-maily, telefon, poznámka.
- **CUS-003** Výjimky na zákazníka: splatnost, jazyk, měna, design, upomínky zapnuty/vypnuty.
- **CUS-004** Předvyplnění z ARES podle IČO. Nedostupnost ARES nebrání ručnímu vyplnění.
- **CUS-005** Ověření VAT ID přes VIES s uložením data ověření. Nedostupnost nebrání uložení.
- **CUS-006** Karta zákazníka: faktury, součet fakturovaný a uhrazený, pohledávky, průměrná doba úhrady.
- **CUS-007** Zákazník s doklady nejde smazat, jen archivovat. Bez dokladů smazat jde.
- **CUS-008** Vystavená faktura drží vlastní kopii údajů zákazníka. Pozdější změna zákazníka ji nezmění, dokud uživatel faktuře údaje výslovně neobnoví.
- **CUS-009** Upozornění na duplicitní IČO, uložení je i tak možné.

## 7. Faktury (INV)

### 7.1 Typy dokladů

| Typ | Popis |
|---|---|
| Faktura | Běžný doklad. |
| Zálohová faktura | Výzva k platbě, viz 7.8. |
| Opravná faktura | Dobropis k faktuře, viz 7.9. |

### 7.2 Životní cyklus

Stavy: `koncept` → `vystavená` → `odeslaná` → `částečně uhrazená` → `uhrazená`, a dále `stornovaná` a `dobropisovaná`. „Po splatnosti“ je odvozený příznak, ne uložený stav.

- **INV-001** Koncept nemá číslo a nezapočítává se do přehledů. Vystavením získá číslo z řady.
- **INV-002** Koncept jde smazat. Vystavenou fakturu smazat nejde, jen stornovat. Číslo zůstane obsazené.
- **INV-003** Storno vyžaduje potvrzení a jde vrátit zpět.
- **INV-004** Přehled stavů a historie změn je na detailu faktury.
- **INV-005** Odeslání nastaví stav `odeslaná`, ruční přepnutí bez e-mailu („Označit jako odeslanou“) také.

### 7.3 Tvorba a úprava

- **INV-010** Nová faktura je předvyplněná ze SET-030 až 034 a výjimek zákazníka. Běžný případ: vyberu zákazníka, položku z ceníku, vystavím.
- **INV-011** Výběr zákazníka našeptávačem s možností založit nového přímo ve formuláři.
- **INV-012** Položky: název, popis, množství, jednotka, cena za jednotku, sleva v procentech nebo částkou. Cena za jednotku má nejvýš dvě desetinná místa. Řazení přetažením.
- **INV-013** Našeptávač položek z ceníku. Po výběru se doplní název, jednotka, cena. Řádek jde uložit do ceníku.
- **INV-014** Sleva na celou fakturu, procentem nebo částkou.
- **INV-015** Zaokrouhlení celkové částky: nezaokrouhlovat, na koruny, nastavitelné výchozí.
- **INV-016** Živý náhled PDF při úpravě.
- **INV-017** Automatické ukládání konceptu.
- **INV-018** Duplikace faktury jako nový koncept s dnešními daty.
- **INV-019** Datum vystavení, splatnosti, DUZP (volitelné), objednávka, reference, poznámky před a za položkami.
- **INV-020** Vystavené i odeslané faktury jdou zpětně upravit včetně čísla. U již odeslané faktury UI upozorní a po uložení nabídne opětovné odeslání, samo nic neodešle.
- **INV-021** Každá změna vystavené faktury vytvoří verzi. Verze jde zobrazit a porovnat, předchozí jde obnovit.
- **INV-022** Změna čísla kontroluje unikátnost v rámci účtu.
- **INV-023** Úprava uhrazené faktury, při které nová částka nesouhlasí s platbami, vrátí fakturu do stavu `částečně uhrazená` nebo označí přeplatek a uživatele upozorní.
- **INV-024** Hromadné akce v seznamu: odeslat, označit jako uhrazené, stáhnout PDF, exportovat.
- **INV-025** Přechod mezi poli a odeslání formuláře funguje klávesnicí.
- **INV-026** Faktuře jde volitelně přidat štítky. Štítky si uživatel zakládá sám přímo ve formuláři, bez štítků se formulář nijak nemění.

### 7.4 Seznam

- **INV-030** Filtrování podle stavu, zákazníka, období, měny, typu, štítků a příznaku „vytvořeno jinde“. Hledání podle čísla, zákazníka, položky.
- **INV-031** Řazení podle všech sloupců. Filtry jsou v URL, takže jdou sdílet a přežijí obnovení.
- **INV-032** Souhrn nad seznamem: fakturováno, uhrazeno, po splatnosti, pro každou měnu zvlášť.

### 7.5 Číselné řady (NUM)

- **NUM-001** Formát je plně nastavitelný šablonou s tokeny `{RRRR}`, `{RR}`, `{MM}`, `{DD}`, `{Q}`, pořadím `{N}` až `{NNNNNN}` (1 až 6 míst) a libovolným textem. Příklad: `{RRRR}-{NNN}` → `2026-040`. Pořadí se při překročení šířky nezkracuje: `{NN}` dá po 99 číslo 100.
- **NUM-008** Výběr z předpřipravených formátů: `2026-040`, `2026-0040`, `2026040`, `26040`, `2026/040`, `FV-2026-040`, `40/2026`, `202610040`, s možností napsat vlastní.
- **NUM-002** Reset počítadla: ročně, čtvrtletně, měsíčně, nikdy.
- **NUM-003** Každý typ dokladu může mít vlastní řadu. Uživatel může mít řad víc a jednu zvolit u faktury.
- **NUM-004** Nastavitelné další číslo, s kontrolou kolize.
- **NUM-005** Přidělení čísla je transakční. Dvě souběžná vystavení nedostanou stejné číslo.
- **NUM-006** Náhled formátu při úpravě.
- **NUM-007** Variabilní symbol se odvodí z čísla faktury odstraněním nečíslic (`2026-040` → `2026040`), je omezený na 10 číslic a jde ručně přepsat.

### 7.6 Zahraniční faktura (FOR)

- **FOR-001** Přepínač „zahraniční faktura“ ve formuláři odkryje měnu, kurz a doložky. Předvyplní se ze zákazníka podle státu.
- **FOR-002** Měny: CZK, EUR, USD, GBP, CHF, PLN **[návrh]**.
- **FOR-003** Kurz se automaticky načte z denního kurzovního lístku ČNB k rozhodnému dni a jde ručně přepsat. V konceptu se při změně data nebo měny sám přenačte, ručně zadaný kurz přepíše jen uživatel. Při vystavení se uloží na fakturu a dál se sám nemění.
- **FOR-004** Při nedostupnosti ČNB se použije poslední známý kurz s upozorněním, nebo ruční zadání.
- **FOR-005** Účet podle měny dle SET-021. Chybí-li účet v dané měně, UI na to upozorní před vystavením.
- **FOR-006** U identifikované osoby a služby pro firmu z EU se na fakturu doplní doložka o přenesení daňové povinnosti a VAT ID obou stran, bez výpočtu DPH. Doložka je předvyplněná a upravitelná. Přesné znění ověří daňový poradce před vydáním (viz 24).
- **FOR-007** Doložky jsou v jazyce faktury.
- **FOR-008** Statistiky přepočítávají cizí měny do CZK kurzem faktury, viz REP-009.
- **FOR-009** Rozhodný den je v nastavení: datum vystavení (výchozí), nebo DUZP, pokud je na faktuře vyplněný.
- **FOR-010** Pro každou měnu jde v nastavení zapnout vlastní pevný kurz. Použije se místo ČNB a ve formuláři je u něj vidět, že jde o pevný kurz. Pevný kurz ani ruční přepsání se od ČNB nesmí odchýlit o víc než 5 % bez upozornění.

### 7.7 Povinné a volitelné údaje na dokladu

- **INV-040** Vždy: typ a číslo, dodavatel, odběratel, datum vystavení, splatnost, položky, celkem, způsob platby, VS, účet, text o neplátcovství.
- **INV-041** Volitelně: logo, QR, kontakt, podpis, DUZP, reference, poznámky, doložky, údaj o zápisu v rejstříku.
- **INV-042** Patička neobsahuje reklamu ani značku aplikace, pokud ji uživatel sám nezapne.

### 7.8 Zálohová faktura (ADV)

- **ADV-001** Vlastní číselná řada a text „Toto není daňový doklad.“ s možností úpravy.
- **ADV-002** Po úhradě zálohy aplikace vytvoří běžnou fakturu podle nastavení: vypnuto, koncept, vystavená. Výchozí: koncept **[návrh]**. Odeslání se řídí SET-040.
- **ADV-003** Vzniklá faktura odkazuje na zálohu, zobrazuje „Uhrazeno zálohou“ a částka k úhradě je nula nebo zbývající doplatek.
- **ADV-004** Zálohovou fakturu jde ručně převést na fakturu kdykoli, i před úhradou.
- **ADV-005** **[návrh]** Platba zůstává na zálohové faktuře a do příjmů se počítá k datu úhrady, tedy jednou, i když konečná faktura vznikne až v dalším roce nebo vůbec. Konečná faktura ji jen odečte z částky k úhradě.
- **ADV-007** **[návrh]** Fakturováno a obrat zahrnují konečnou fakturu, ne zálohovou. Neuhrazené zálohy nejsou v pohledávkách ani po splatnosti běžných faktur, mají vlastní řádek v přehledech.
- **ADV-006** Pravidelná faktura může být typu zálohová.

### 7.9 Opravná faktura (CRN)

- **CRN-001** Vzniká z vystavené faktury a odkazuje na ni. Vlastní číselná řada.
- **CRN-002** Plná i částečná oprava, položky se předvyplní se zápornou hodnotou.
- **CRN-003** Opravná faktura snižuje fakturované částky v přehledech.
- **CRN-004** Vrácení peněz jde zaznamenat jako zápornou platbu.
- **CRN-005** **[návrh]** Zbývá uhradit = částka faktury + součet jejích opravných faktur (záporný) − součet plateb. Z této hodnoty vychází stav, QR, upomínky, pohledávky i karta zákazníka.
- **CRN-006** **[návrh]** Faktura s nulovým zůstatkem po úplné opravě a bez plateb má stav `dobropisovaná` a nejde na ni upomínka. Záporný zůstatek se zobrazí jako „přeplatek k vrácení“, kredit zákazníka se neeviduje.

## 8. PDF, designy a QR (PDF)

- **PDF-001** PDF se generuje na serveru. Stejná šablona slouží náhledu i stažení.
- **PDF-002** Sada aspoň 12 designů **[návrh]**, od střízlivých po výrazně barevné, s inspirací u Fakturoidu a konkurence: Čistý, Editorial, Barevný pás, Tabulkový, Blok, Minimal, Mono, Klasik, Geometric, Kontrast, Boční pruh, Kompaktní.
- **PDF-003** Každý design podporuje vlastní barvy (akcent, plochy, text, linky), logo vlevo/vpravo/bez, QR, podpis, češtinu a angličtinu. Barvy se volí v základu, výběrem nebo hex kódem, s kontrolou čitelnosti textu.
- **PDF-004** Výběr designu v nastavení s náhledem na vlastních datech.
- **PDF-005** Faktura s mnoha položkami se korektně láme na další strany, záhlaví tabulky se opakuje, stránkování „Strana X z Y“.
- **PDF-006** Fonty jsou vložené do PDF a zvládají českou diakritiku.
- **PDF-007** Všechny designy procházejí vizuálním regresním testem nad sadou fixture (krátká, dlouhá, EUR, angličtina, bez loga, dlouhé názvy).
- **PDF-008** Přidání nového designu je jeden soubor plus registrace, bez zásahu jinam.
- **PDF-009** Název staženého souboru je nastavitelný šablonou, výchozí `{cislo}.pdf`.
- **PDF-010** Vystavený PDF jde stáhnout, odeslaný PDF se archivuje v podobě, v jaké odešel (viz MAIL-006).

### QR platba

- **QR-001** Faktura v CZK na český účet má QR ve formátu SPAYD s IBAN, částkou, měnou, VS a zprávou.
- **QR-002** Faktura v EUR má QR ve formátu EPC (SEPA), pokud účet má IBAN a BIC. Jinak se QR nezobrazí a UI vysvětlí proč.
- **QR-003** Jiné měny QR nemají **[návrh]**.
- **QR-004** Volitelné logo uprostřed QR, s korekcí chyb úrovně H a omezenou plochou loga, aby byl kód čitelný. Test QR dekóduje a ověří obsah s logem i bez.
- **QR-005** QR je volitelné globálně i na faktuře. Uhrazená faktura QR nezobrazuje **[návrh]**.
- **QR-006** Částka v QR je zbývající částka k úhradě.

## 9. Ceník a šablony (CAT, TPL)

- **CAT-001** Položka: název, popis, jednotka, cena, měna, kategorie, štítky, archivace.
- **CAT-002** Hledání a filtr. Řazení podle použití.
- **CAT-003** Změna ceny v ceníku nemění vystavené faktury.
- **CAT-004** Správa jednotek (hod., ks, měsíc, den, projekt…).
- **TPL-001** Šablona: zákazník (volitelný), položky, poznámky, jazyk, měna, design, splatnost.
- **TPL-002** Faktura ze šablony vznikne jedním kliknutím, jako koncept.
- **TPL-003** Uložení existující faktury jako šablony.
- **TPL-004** Šablony podporují proměnné z kapitoly 10.3.

## 10. Pravidelné faktury (REC)

### 10.1 Plán

- **REC-001** Četnost: týdně, měsíčně, čtvrtletně, pololetně, ročně, nebo každých N týdnů/měsíců.
- **REC-002** Den vystavení: konkrétní den, poslední den období, první pracovní den, poslední pracovní den.
- **REC-003** Začátek, konec podle data nebo počtu, případně bez konce.
- **REC-004** Náhled nejbližších 12 termínů včetně vygenerovaných popisů.
- **REC-005** Pozastavení a obnovení. Po obnovení zmeškané termíny neběží automaticky, zobrazí se ke kontrole.
- **REC-006** Čas se počítá v zóně Europe/Prague.
- **REC-007** **[návrh]** Když je v termínu automatika vypnutá nebo je zapnutý hlavní vypínač SET-043, vznikne jen koncept bez čísla a upozornění. Po opětovném zapnutí se nic zadržené samo neodešle, koncepty a nevyřízené upomínky čekají na ruční kontrolu.

### 10.2 Režim

- **REC-010** Tři režimy: vytvořit koncept, vystavit, vystavit a odeslat. Výchozí je koncept.
- **REC-011** Režim „vystavit a odeslat“ je dostupný, jen když je zapnutý v Automatizaci (SET-040), a jeho zapnutí pro konkrétní fakturu vyžaduje potvrzení.
- **REC-012** Před odesláním může aplikace poslat uživateli upozornění N dní předem **[návrh]**.
- **REC-013** Selhání odeslání nezahazuje fakturu. Zůstane vystavená, uživatel dostane upozornění, automatický opakovaný pokus proběhne maximálně 3krát **[návrh]**.
- **REC-014** Faktury z pravidelné šablony mají odkaz zpět a na šabloně je jejich seznam.

### 10.3 Proměnné v popisu

Proměnné jde použít v položkách, poznámkách i předmětu e-mailu.

| Proměnná | Význam | Příklad |
|---|---|---|
| `{{ctvrtleti}}` | Číslo čtvrtletí | 3 |
| `{{pololeti}}` | Číslo pololetí | 2 |
| `{{mesic}}` | Číslo měsíce | 7 |
| `{{mesic_nazev}}` | Název měsíce v jazyce faktury | červenec / July |
| `{{rok}}` | Rok | 2026 |
| `{{obdobi_od}}`, `{{obdobi_do}}` | Začátek a konec období | 1. 7. 2026, 30. 9. 2026 |
| `{{cislo_faktury}}` | Číslo dokladu | 2026-040 |
| `{{zakaznik}}` | Název zákazníka | Příklad, s.r.o. |

- **REC-020** Text „faktura za {{ctvrtleti}}. čtvrtletí {{rok}}“ se vykreslí jako „faktura za 3. čtvrtletí 2026“.
- **REC-021** Posun období na šabloně: aktuální, předchozí, následující, nebo o N období. Faktura vystavená 1. 10. tak může fakturovat 3. čtvrtletí.
- **REC-022** Proměnné nabízí editor jako klikatelné vložení, neznámá proměnná je chyba při uložení.
- **REC-023** Hodnoty se počítají z data vystavení v plánu, ne z data skutečného běhu úlohy, takže opožděný běh dá správné období.
- **REC-024** Jazyk názvů se řídí jazykem faktury.

### 10.4 Spolehlivost

- **REC-030** Každý termín má unikátní klíč `(šablona, období)`. Opakované nebo souběžné spuštění nevytvoří duplicitu, testováno.
- **REC-031** Po výpadku serveru plánovač doběhne zmeškané termíny za poslední 3 dny **[návrh]**, starší nabídne ke kontrole.
- **REC-032** Doběhnuté termíny v režimu „vystavit a odeslat“ se nepošlou samy, pokud jsou starší než 3 dny **[návrh]**.

## 11. Odesílání e-mailem (MAIL)

- **MAIL-001** Tlačítko „Odeslat klientovi“ je na detailu každé vystavené faktury a po vystavení je nabídnuto hned. Odeslání z detailu faktury: příjemci, kopie, předmět, text, příloha PDF, volitelně ISDOC.
- **MAIL-002** Předvyplnění ze šablon e-mailů v jazyce faktury, s proměnnými.
- **MAIL-003** Šablony jsou upravitelné pro každý typ zprávy: faktura, záloha, opravná faktura, upomínka, potvrzení platby.
- **MAIL-004** Nic se neodešle bez kliknutí uživatele nebo zapnuté automatiky.
- **MAIL-005** Odeslání běží přes frontu s opakováním. Selhání je vidět na faktuře s důvodem.
- **MAIL-006** Historie odeslání na faktuře: kdy, komu, předmět, výsledek, archivovaný PDF.
- **MAIL-007** Odkaz „potvrzení přijetí“ a sledovací pixely se nepoužívají.
- **MAIL-008** Hromadné odeslání ukáže souhrn příjemců a vyžaduje potvrzení.
- **MAIL-009** Zprávy klientovi mají kromě prostého textu i HTML verzi. Uživatel v Nastavení vybírá ze sedmi vzhledů podle `docs/superpowers/mockups/email-sablony.html`: B1 až B5, A a C. Výchozí je B4 Tmavá hlavička, vše bez barev a značky Fakturanu. Vzhled s barvou přebírá akcent z designu faktury, s čitelným textem podle kontrastu, bez akcentu zůstává neutrální.
- **MAIL-010** V Nastavení jde k HTML zprávě zadat vlastní úvodní text, podpis a logo. Logo je ve výchozím stavu to z profilu dodavatele, jde nahradit vlastním nebo vypnout. Bez loga se v hlavičce zobrazí jméno dodavatele a každý vzhled funguje stejně. Hodnoty platí pro všechny typy zpráv, text konkrétní zprávy jde dál upravit v dialogu odeslání. Vzhledy s místem pro QR ho ukážou, pokud ho faktura má.

## 12. Upomínky (REM)

- **REM-001** Automatické upomínky jsou ve výchozím stavu vypnuté.
- **REM-002** Pravidla: N dní před splatností, N dní po splatnosti, více stupňů s vlastním textem.
- **REM-003** Ruční odeslání upomínky z faktury.
- **REM-004** Upomínka jde na faktuře odložit až o 30 dní nebo vypnout.
- **REM-005** Vypnutí na zákazníkovi (CUS-003).
- **REM-006** Upomínky nejdou na uhrazené, stornované a částečně uhrazené faktury bez výslovného zapnutí, u částečné se uvádí zbývající částka.
- **REM-007** Stejný stupeň upomínky se k faktuře nepošle dvakrát.
- **REM-008** Odesílá se v čase nastaveném uživatelem, výchozí 9:00 **[návrh]**.
- **REM-009** Upozornění pro uživatele na faktury po splatnosti a blížící se splatnost: vždy v centru upozornění a na Přehledu, volitelně denní e-mail uživateli. Výchozí stav e-mailu je vypnuto a nikdy nejde klientovi.
- **REM-010** Volitelný pravidelný souhrn e-mailem uživateli, v Nastavení ve výchozím stavu vypnutý, s volbou měsíčně nebo čtvrtletně: fakturováno, přijato, pohledávky, faktury po splatnosti a výhled na další období z otevřených a pravidelných faktur. Klientovi nejde nikdy.
- **REM-011** Volitelná lednová připomínka s ročním přehledem pro daně, zvlášť zapínaná a ve výchozím stavu vypnutá: příjmy, neuhrazené faktury k 31. 12. a odkaz na daňový přehled.
- **REM-012** Volitelné upozornění e-mailem při 80 a 95 % limitu pro povinnou registraci k DPH. Limit a prahy jsou pojmenované konstanty na jednom místě, aby šly při změně zákona upravit jednou úpravou.

## 13. Platby (PAY)

### 13.1 Ruční

- **PAY-001** Označení jako uhrazené jedním kliknutím s dnešním datem, datum jde změnit.
- **PAY-002** Více dílčích plateb na fakturu. Stav se odvodí ze součtu.
- **PAY-003** Platba má datum, částku, měnu, způsob (převod, hotovost, jiné), poznámku, zdroj (ruční, avízo, import).
- **PAY-004** Přeplatek se zvýrazní, faktura je uhrazená.
- **PAY-005** Platbu jde upravit a smazat, stav se přepočítá.
- **PAY-006** **[návrh]** Platba má částku v měně přijetí a částku připsanou na fakturu v její měně. U shodné měny jsou stejné. U jiné měny se předvyplní přepočet kurzem ČNB ke dni úhrady a uživatel ho může přepsat.
- **PAY-007** **[návrh]** Malý rozdíl z kurzu nebo poplatku uživatel uzavře akcí „Uzavřít jako uhrazené“ s uloženým rozdílem. Automaticky se nezaokrouhluje.

### 13.2 Avíza Fio (BNK)

Princip: uživatel si ve Fio nastaví e-mailová oznámení do své schránky a aplikace ji čte přes IMAP. Banka přístup k účtu neposkytuje, aplikace jen čte oznámení.

- **BNK-001** Nastavení IMAP: server, port, TLS, uživatel, heslo, složka. Doporučená je samostatná schránka. Test připojení.
- **BNK-002** Návod v aplikaci: Nastavení → Oznámení → Uživatelská oznámení → Pohyby → Přidat oznámení; e-mail, částka 0,01, formát „Fio banka - příjem na účtu“, zapnuté „Posílat online“.
- **BNK-003** Kontrola schránky každých 5 minut **[návrh]** a tlačítko „Zkontrolovat teď“.
- **BNK-004** Zpracovávají se jen zprávy od `automat@fio.cz` s předmětem „Fio banka - příjem na účtu“ nebo „Fio banka - new income on account“. Výdajová avíza („Fio banka - výdaj na účtu“) se ignorují.
- **BNK-005** Parser čte: cílový účet, částku, měnu, datum a čas, VS, KS, protiúčet, název protistrany, zprávu, ID pokynu, a to v české i anglické variantě. Česká varianta je ověřená na skutečném avízu: věta „zůstatek účtu <účet> se <dd.mm.rrrr> v <hh:mm> zvýšil o <částka> <měna>.“ (účet bez kódu banky znamená Fio 2010, částka s mezerami po tisících a desetinnou čárkou) a pod ní popisky v pevném pořadí `Typ pohybu`, `Protistrana` (`<účet>/<kód>` a volitelně jméno v závorce), `ID pokynu`, `Variabilní symbol`, `Specifický symbol`, `Konstantní symbol`, `Uživatelský symbol`, `Zpráva pro příjemce`; povinné jsou jen věta a ID pokynu. Anglicky je částka s desetinnou tečkou, datum m/d/rrrr a popisky `Variable symbol`, `Counterparty`, `Instruction ID`; tato varianta je sestavená jen z veřejných zmínek, proto je prozatímní a automaticky se nepáruje. Kód parseru je vlastní.
- **BNK-006** Podle ID pokynu se avízo zpracuje jen jednou. Znovu přečtená zpráva nic nezmění.
- **BNK-007** Cílový účet musí odpovídat účtu uživatele, jinak se avízo ignoruje a zaznamená.
- **BNK-008** Automatické spárování nastane, když sedí VS, částka a měna a faktura je otevřená. Datum platby se vezme z avíza.
- **BNK-009** Spárování faktury nikdy nic neposílá klientovi, pokud není zapnuté potvrzení platby (SET-040).
- **BNK-010** Fronta „Nespárované platby“: neznámý VS, jiná částka, jiná měna, shoda s více fakturami. Uživatel platbu přiřadí, rozdělí nebo zahodí.
- **BNK-011** Přijetí částečné platby z fronty funguje jako dílčí platba.
- **BNK-012** Nerozpoznané avízo od Fio se neztratí. Zobrazí se jako „Nerozpoznaný formát“ s upozorněním, protože jde pravděpodobně o změnu formátu.
- **BNK-013** Hlavičky SPF/DKIM se kontrolují, pokud jsou k dispozici. Selhání přesune platbu do fronty místo automatického spárování. Přeposlaná zpráva bez platného podpisu se nedá odlišit od podvržené, proto jde vždy do fronty k ručnímu potvrzení.
- **BNK-014** Spárování z avíza jde vrátit jedním kliknutím.
- **BNK-015** Stav napojení: poslední kontrola, poslední zpracované avízo, chyba připojení. Selhání opakovaně po sobě vytvoří upozornění.
- **BNK-016** Parsery jsou samostatné moduly s jednotným rozhraním, přidání banky neovlivní zbytek.
- **BNK-017** Avíza se ukládají maskovaně a zachovávají 90 dní **[návrh]**, spárovaná platba zůstává trvale.

## 14. Dashboard (DSH)

### 14.1 Mřížka

- **DSH-001** Mřížka widgetů, přesouvání a změna velikosti tažením, uložení rozložení.
- **DSH-002** Více dashboardů, jeden je výchozí. Přejmenování, duplikace, smazání.
- **DSH-003** Nový účet dostane výchozí dashboard.
- **DSH-004** Na úzké obrazovce se widgety skládají pod sebe.
- **DSH-005** Globální filtr dashboardu: období, měna.

### 14.2 Konfigurátor widgetu

- **DSH-010** Zdroj dat: faktury, položky faktur, platby, zákazníci.
- **DSH-011** Metrika: součet, počet, průměr, medián, minimum, maximum, dny do úhrady.
- **DSH-012** Seskupení: den, týden, měsíc, čtvrtletí, rok, zákazník, položka, měna, stav, typ.
- **DSH-013** Filtry: období (absolutní i relativní jako „letos“, „posledních 12 měsíců“), stav, zákazník, měna, typ, zahrnout/vyloučit importované.
- **DSH-014** Zobrazení: číslo, číslo s porovnáním, tabulka, sloupce, skládané sloupce, čára, plocha, koláč/prstenec, heatmapa.
- **DSH-015** Porovnání s předchozím obdobím.
- **DSH-016** Název, barva, popisky, formát čísel.
- **DSH-017** Živý náhled v konfigurátoru.
- **DSH-018** Konfigurace je deklarativní JSON se schématem a verzí. Server ho překládá na dotaz nad povolenými poli, nikdy nespouští žádný kód ani volné SQL. Dotaz je vždy omezen na účet uživatele.

### 14.3 Předpřipravené widgety

**[návrh]** Widgety jsou dvou druhů. **Dotazové** jsou běžná konfigurace, kterou jde otevřít v konfigurátoru a upravit. **Systémové** (nejbližší splatnosti, nadcházející pravidelné faktury, předpověď příjmů, nespárované platby, limity, stárnutí pohledávek) mají vlastní logiku na serveru, pevný identifikátor v JSON a jen parametry jako období nebo počet řádků. I ty jdou přesouvat, zvětšovat a exportovat.

- **DSH-020** Galerie aspoň těchto widgetů: fakturováno letos, uhrazeno letos, pohledávky, po splatnosti, tržby po měsících, po čtvrtletích, meziroční porovnání, top zákazníci, top položky, poměr uhrazeno/neuhrazeno, průměrná doba úhrady, stárnutí pohledávek, nejbližší splatnosti, nadcházející pravidelné faktury, předpověď příjmů, nespárované platby, roční obrat vs. limity, podíl měn, kumulativní obrat, heatmapa fakturace.

### 14.4 Sdílení

- **DSH-030** Export dashboardu i widgetu jako JSON.
- **DSH-031** Import JSON s validací proti schématu. Neplatný soubor ukáže konkrétní chybu a nic nezmění.
- **DSH-032** Import ukáže náhled před uložením a nezahrnuje žádná data, jen konfiguraci.

## 15. Statistiky (REP)

- **REP-001** Stránka Statistiky: fakturace, úhrady, pohledávky, zákazníci, položky, měny. Filtr období a porovnání.
- **REP-002** Stárnutí pohledávek v pásmech 0–30, 31–60, 61–90, 90+ dní.
- **REP-003** Předpověď příjmů z otevřených faktur a pravidelných šablon.
- **REP-004** Každý přehled jde exportovat do CSV a Excelu.
- **REP-005** Hlídání limitů: roční obrat proti hranici pro registraci k DPH a pro paušální daň. Částky jsou nastavitelné, upozornění při 80 a 95 % **[návrh]**. Obrat se počítá za kalendářní rok podle DUZP, případně data vystavení; základ jde přepnout na datum úhrady **[návrh]**.
- **REP-006** Importované faktury se ve výchozím stavu započítávají, filtr je jde vyloučit.
- **REP-007** Stornované faktury a koncepty se nezapočítávají.
- **REP-008** Opravné faktury snižují částky, zálohy se započítají jen jednou.
- **REP-009** Fakturované částky v cizí měně se přepočítají kurzem faktury. Platby kurzem ČNB ke dni úhrady.

### Daňový přehled (TAX)

- **TAX-001** Roční přehled: příjmy podle data úhrady, seznam plateb, součet v CZK, neuhrazené faktury k 31. 12. Neuhrazené k 31. 12. se skládají z historie, ne z dnešního zůstatku: doklady vystavené do toho dne mimo koncepty a storna, bez záloh, a odečítají se jen platby, opravy a uhrazená záloha s datem do toho dne. Pro běžný rok platí dnešek a nadpis to řekne. Doklad stornovaný až později se nezobrazí, protože storno nemá datum, a přehled to uvádí. Doklad bez kurzu je mezi nepřepočtenými.
- **TAX-002** Přepínač základu: datum úhrady, nebo datum vystavení. Výchozí datum úhrady.
- **TAX-003** Výstup PDF, Excel, CSV.
- **TAX-004** Přehled obsahuje upozornění, že jde o podklad, ne o daňové poradenství.

## 16. Import (IMP)

- **IMP-000** Hlavní cesta pro historické faktury je ISDOC, protože ho umí exportovat Fakturovač, Fakturoid, iDoklad, SuperFaktura, Vyfakturuj i ABRA Flexi. Import podporuje ISDOC 6.x, samostatné soubory, ZIP a PDF s vloženým ISDOC. Nepředpokládá konkrétní systém, zdroj se bere z `IssuingSystem`.
- **IMP-001** Import zákazníků, ceníku a faktur z CSV a Excelu přes průvodce: nahrání, mapování sloupců, náhled, kontrola chyb, potvrzení. Slouží jako záloha pro systémy bez ISDOC.
- **IMP-002** Mapování jde uložit jako předlohu. Součástí aplikace jsou předlohy pro CSV exporty Fakturoidu a iDokladu, pokud to umožní jejich reálné soubory (viz 24).
- **IMP-003** Import dokumentu ISDOC převezme číslo, UUID, typ dokladu, data, zákazníka, položky, měnu, částky, VS a účet. UUID je klíč proti duplicitám.
- **IMP-012** ISDOC neobsahuje datum úhrady. Doklad s `PayableAmount` 0 (ověřeno proti skutečným úhradám ve Fakturovači) se založí jako uhrazený s datem úhrady rovným datu splatnosti a příznakem „datum odhadnuto“. Náhled importu to ukáže a datum jde upravit jednotlivě i hromadně. Roční daňový přehled na odhadnutá data upozorní **[návrh]**. Doklad s `0 < PayableAmount < celek` dostane platbu na rozdíl, stav částečně uhrazeno, rovněž s odhadem. Platba z importu nespouští potvrzení ani konečnou fakturu zálohy, platby v cizí měně nesou kurz dokladu a dobropis platbu nedostává. `PaidDepositsAmount` se páruje se zálohou v dávce nebo v účtu: při shodě se konečná faktura naváže na zálohu a platba nevznikne, bez shody vznikne platba s odhadem a upozorněním „záloha nenalezena“, takže úhrada zálohy se nikdy nezapočte dvakrát.
- **IMP-013** Skutečné faktury se do repozitáře nedávají. Testovací fixture ISDOC jsou smyšlené, se strukturou podle reálného exportu.
- **IMP-004** Importovaná faktura má štítek „vytvořeno jinde“ a název zdroje, zachová původní číslo a nezasahuje do číselných řad.
- **IMP-005** Importovaná faktura jde jen číst **[návrh]**, lze k ní přiložit původní PDF. Uhrazení a smazání jsou povolené. Importovaný doklad nespouští žádnou automatiku: upomínky ho přeskakují, potvrzení platby ani konečná faktura zálohy nevzniknou ani po ruční platbě a avízo ho samo nespáruje, nabídne ho k ručnímu přiřazení. Upozornění na splatnost a pohledávky ho dál ukazují.
- **IMP-006** Zákazníci se párují podle IČO, jinak názvu. Chybějící se založí, náhled to ukáže.
- **IMP-007** Duplicity (stejné číslo) se přeskočí a vypíšou.
- **IMP-008** Celý import je transakční a jde vrátit zpět podle dávky.
- **IMP-009** Chybný řádek zastaví potvrzení s přesnou chybou, nebo jde přeskočit.
- **IMP-010** **[návrh]** Záloha se obnovuje jen do prázdného účtu, i na jiné instanci, s novými ID. Po obnově jsou všechny automatiky vypnuté a SMTP a IMAP je nutné zadat znovu. Audit log ze zálohy se neslučuje: přiloží se jako soubor ke čtení a do nového logu přibude záznam o obnovení.
- **IMP-011** Importovaný soubor má limit 25 MB **[návrh]**, zpracovává se na pozadí s průběhem. Výjimkou je záloha účtu: má vlastní nahrání s limitem 1 GiB a stejný limit platí už při jejím vytvoření, záloha, kterou by obnova odmítla, vůbec nevznikne. Formát ZIP bez ZIP64 nesmí ani tiše dojít ke 4 GiB. Archiv zálohy (manifest verze 2) má nejvýš 200 000 položek: manifest nese kontrolní součty dat, historie změn a seznamu souborů `files.jsonl` a má nejvýš 1 MiB, seznam souborů s velikostí a kontrolním součtem každého souboru leží hned za ním. Zálohy verze 1 jdou dál obnovit. Reverzní proxy musí mít limit těla aspoň 1 GiB.

## 17. Export (EXP)

- **EXP-001** Hromadný export faktur: PDF v ZIPu, ISDOC v ZIPu, CSV, Excel.
- **EXP-002** Filtr období, typu, zákazníka, stavu.
- **EXP-003** Export zákazníků, ceníku, plateb, šablon.
- **EXP-004** Export audit logu.
- **EXP-005** ISDOC prochází validací proti schématu dané verze.
- **EXP-006** Záloha účtu: všechna data uživatele včetně souborů v jednom archivu s verzí, obnovitelná přes IMP-010.
- **EXP-007** Velký export běží na pozadí a je ke stažení 7 dní **[návrh]**.
- **EXP-008** Hodnoty v CSV a Excelu začínající `=`, `+`, `-`, `@` se neutralizují proti formula injection.
- **EXP-009** Účet neobsahuje v exportu tajemství (hesla SMTP/IMAP).

## 18. Audit log (AUD): priorita

Audit log je základní vlastnost, ne doplněk. Zapisuje se **úplně všechno**.

- **AUD-001** Záznam vzniká pro každé vytvoření, změnu a smazání libovolné entity, včetně nastavení, a pro každou akci vůči klientovi (odeslání, upomínka).
- **AUD-002** Dále pro: přihlášení úspěšná i neúspěšná, odhlášení, reset hesla, změny auth, pozvánky, role, stažení PDF, exporty, importy, zálohy, zobrazení tajemství, zpracování avíz, párování, běhy plánovače a jejich výsledek, překročení rate limitu, odmítnutý přístup.
- **AUD-003** Záznam obsahuje: čas, aktéra, účet, zdroj (web, plánovač, import, systém, později API), akci, entitu, ID, změny před/po, IP, user agent, ID požadavku.
- **AUD-004** Tajemství a hesla se do záznamu nikdy nedostanou, hodnoty se nahrazují `[skryto]`. Test to ověřuje pro každé citlivé pole.
- **AUD-005** Zápis je ve stejné transakci jako změna. Když audit selže, selže i změna. Výjimka: vlastní zápisy Better Auth (účty, relace, hesla) běží v jeho transakci, audit se proto zapíše hned po nich a jeho selhání vrátí chybu 500, změnu ale nevrátí **[návrh]**.
- **AUD-006** Log je append-only: aplikace nemá cestu pro úpravu nebo smazání a databázové triggery to blokují.
- **AUD-007** Uživatel vidí vlastní log: filtr podle akce, entity, období, aktéra, zdroje; detail s rozdílem; export.
- **AUD-008** Administrátor vidí jen události instance: účty, pozvánky, role, konfigurace. Obsah fakturace jiných uživatelů ne.
- **AUD-009** Na detailu každé entity je její historie.
- **AUD-010** Výchozí retence je neomezená. Smazání uživatele (ADM-006) odstraní jeho záznamy jako jediná povolená výjimka, zůstane jen záznam instance, že účet byl smazán.
- **AUD-011** Testovací pomůcka ověřuje, že každá servisní mutace vytvoří záznam. Nová mutace bez auditu neprojde testem.

Upřesnění: přečtení upozornění (`notification.read`, `notification.read_all`) je stav zobrazení, ne změna dat účtu, takže ho AUD-001 nevyžaduje. Záznam přesto vzniká, protože každý zápis jde přes mutaci s auditem (AUD-011); jde o vedlejší důsledek, ne o požadavek.

## 19. Bezpečnost a architektura

### 19.1 Bezpečnost (SEC)

- **SEC-001** Rate limiting v úložišti sdíleném napříč restarty: přihlášení, reset hesla, pozvánky, registrace, odesílání, importy, exporty. Překročení vrátí 429 a zapíše se do auditu.
- **SEC-002** Izolace: každý dotaz na data účtu prochází vrstvou vyžadující ID vlastníka. Sada testů zkouší přístup ke každému typu entity cizím uživatelem, přímo i přes server actions.
- **SEC-003** Tajemství v databázi (SMTP, IMAP) jsou šifrovaná AES-256-GCM klíčem z konfigurace. Bez klíče aplikace nenastartuje. V UI se nikdy nezobrazí zpět.
- **SEC-004** Bezpečnostní hlavičky: CSP, HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors.
- **SEC-005** Nahrané soubory: kontrola obsahu a velikosti, SVG se sanitizuje, soubory se servírují s bezpečnými hlavičkami a jen vlastníkovi.
- **SEC-006** Vstupy se validují na serveru sdíleným schématem (Zod).
- **SEC-007** Uživatelské SMTP a IMAP servery se nesmí připojovat do privátních sítí, pokud to instance nepovolí (ochrana proti SSRF).
- **SEC-008** Chybové zprávy nerozlišují neexistující účet a špatné heslo.
- **SEC-009** Závislosti: audit v CI, lockfile verzovaný.
- **SEC-010** Cookies relace jsou `HttpOnly`, `Secure`, `SameSite=Lax`.
- **SEC-011** Text z uživatelského vstupu v PDF a e-mailech se escapuje. Šablony e-mailů nepodporují skripty.

### 19.2 Architektura

| Oblast | Volba |
|---|---|
| Framework | Next.js 16.4, výchozí nastavení: App Router, Turbopack, Cache Components, TypeScript strict |
| Databáze | SQLite v režimu WAL přes `better-sqlite3`, Drizzle ORM a migrace **[návrh k ovladači]** |
| Auth | Better Auth |
| UI | shadcn/ui s presetem `b5aa4wfToO`, Tailwind |
| Grafy | TanStack Charts (`@tanstack/charts/react`) |
| Mřížka dashboardu | `react-grid-layout` **[návrh]** |
| PDF | `@react-pdf/renderer`, bez prohlížeče v běhovém prostředí **[návrh]** |
| Pošta | `nodemailer`, `imapflow`, `mailparser` **[návrh]** |
| Plánovač | `croner` spuštěný ze `instrumentation.ts`, s tabulkou úloh a zámky v databázi **[návrh]** |
| Formát a lint | oxfmt a oxlint místo Prettieru a ESLintu |
| Testy | Vitest, Playwright |
| Monitoring | `@sentry/nextjs` |

Pravidla:

- **ARC-001** Doménová logika je ve službách (`src/server/services/*`) nezávislých na Next.js. Server actions, plánovač a později API je jen volají. Díky tomu budou API tokeny a MCP tenká vrstva.
- **ARC-002** Peníze se ukládají jako celé číslo v nejmenší jednotce měny, množství jako celé číslo v tisícinách. Žádná aritmetika v plovoucí desetinné čárce.
- **ARC-003** Čas se ukládá v UTC, obchodní data (vystavení, splatnost) jako kalendářní datum.
- **ARC-004** Aktuální čas se bere z injektovatelných hodin, aby šly testovat plány.
- **ARC-005** Cache Components: stránky mají statický shell a data účtu ve streamovaných částech. Každá položka `use cache` s daty účtu má ID uživatele v klíči a cache tag, který mutace invalidují. Test ověří, že cache nepřekročí hranici účtu. Mutace mimo požadavek (plánovač, fronta, avízo) tag zneplatnit neumí, proto má každá taková položka v klíči i razítko dat účtu (nejvyšší ID auditního záznamu účtu a čas posledního kurzovního lístku), které se změní s každou mutací v téže transakci.
- **ARC-006** Grafy jsou za vlastním obalem `Chart`, aby šlo knihovnu vyměnit. Použité jsou TanStack Charts 1.1.0 (viz 24).
- **ARC-007** Odeslání a automatika jsou úlohy v databázové frontě s idempotenčním klíčem.
- **ARC-008** Jedna instance běží jako jeden proces. SQLite ani plánovač nepočítají s více replikami.

### 19.3 Provoz

- **OPS-001** Aplikace běží v jednom Docker kontejneru, data (databáze, soubory) jsou na jednom trvalém svazku.
- **OPS-002** Migrace se spustí při startu. Selhání zastaví start.
- **OPS-003** Veškerá konfigurace jde přes proměnné prostředí, žádné domény ani údaje nejsou v kódu. `.env.example` je úplný.
- **OPS-004** `/api/health` ověřuje databázi a plánovač, bez citlivých údajů.
- **OPS-005** Denní záloha databáze přes `VACUUM INTO` do podsložky svazku, 14 kopií **[návrh]**. Postup obnovy je v README.
- **OPS-006** Strukturované logy na stdout.
- **OPS-007** Volitelný režim ukázky (`DEMO_MODE`): jeden účet se smyšlenými daty, registrace a odesílání pošty vypnuté, účet se každou noc vrátí do výchozího stavu.

### 19.4 Monitoring chyb (MON)

- **MON-001** Napojení na službu kompatibilní se Sentry (Sentry, GlitchTip a další) stačí nastavit proměnnou `SENTRY_DSN`. Bez ní se nic neposílá a aplikace funguje stejně.
- **MON-002** Volitelně `SENTRY_ENVIRONMENT` a `SENTRY_TRACES_SAMPLE_RATE`.
- **MON-003** Zachytávají se chyby serveru, klienta i plánovaných úloh. Plánovač jednou za hodinu hlásí i provozní stav, každou podmínku nejvýš jednou denně: volné místo na svazku pod 2 GiB nebo pod 10 %, poslední lístek ČNB starší než 3 pracovní dny, těžká úloha běžící déle než 30 minut a selhaná poslední noční záloha. Hlášení nese jen klíč podmínky a neosobní hodnoty (čísla, datum lístku, druh úlohy).
- **MON-004** Do události jde jen ID uživatele. E-mail, IP, obsah faktur a tajemství se nepřenášejí, zajišťuje to `beforeSend`, s testem.

### 19.5 Konfigurace

| Proměnná | Povinná | Účel |
|---|---|---|
| `DATABASE_PATH` | ne | Cesta k SQLite, výchozí ve složce dat |
| `DATA_DIR` | ne | Soubory a zálohy |
| `BETTER_AUTH_URL` | ano | Veřejná adresa |
| `BETTER_AUTH_SECRET` | ano | Tajemství auth |
| `ENCRYPTION_KEY` | ano | Šifrování tajemství, SEC-003 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | ne | SMTP instance |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ne | Google |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | ne | GitHub |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | ne | Microsoft |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | ne | Apple |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | ne | Monitoring |
| `ARES_BASE_URL` | ne | Adresa registru ARES, výchozí veřejné API; mění se jen kvůli testům |
| `CNB_BASE_URL` | ne | Adresa denního lístku kurzů ČNB, výchozí veřejná adresa; mění se jen kvůli testům |
| `VIES_BASE_URL` | ne | Adresa REST API VIES pro ověření DIČ, výchozí veřejné API EU; mění se jen kvůli testům |
| `ALLOW_PRIVATE_MAIL_HOSTS` | ne | Výjimka ze SEC-007 |
| `TRUST_PROXY` | ne | Čtení IP z hlavičky reverzní proxy pro rate limiting a audit |
| `SCHEDULER_TICK_SECONDS` | ne | Interval plánovače v sekundách, 1 až 60, výchozí 60; mění se jen kvůli testům |
| `DEMO_MODE` | ne | Režim ukázky, OPS-007 |
| `DEMO_EMAIL` | s `DEMO_MODE` | E-mail účtu ukázky, ukáže se na přihlášení |
| `DEMO_PASSWORD` | s `DEMO_MODE` | Heslo účtu ukázky, ukáže se na přihlášení |
| `MCP_ENABLED` | ne | Přístup AI asistentů přes MCP pro celou instanci, výchozí `true`; `false` vypne endpoint, metadata i autorizaci (MCP-038) |

## 20. Design a UI (UI)

- **UI-001** Vzhled je řízený tokeny na jednom místě (barvy, písmo, poloměry, stíny, hustota). Změna vzhledu aplikace je úprava jednoho souboru.
- **UI-002** Start: shadcn preset `b5aa4wfToO`.
- **UI-003** Komponenty nepoužívají natvrdo zadané barvy.
- **UI-004** Designy faktur mají vlastní tokeny oddělené od UI aplikace.
- **UI-005** Světlý a tmavý režim.
- **UI-006** Rozhraní je česky, texty jsou ale soustředěné do jednoho modulu, ne rozeseté, aby šlo později přidat i18n **[návrh]**.
- **UI-007** Responzivní, primárně pro počítač. Základní úkony (přehled faktur, označení úhrady) fungují na telefonu.
- **UI-008** Přístupnost: ovládání klávesnicí, popisky polí, WCAG AA kontrast.
- **UI-009** Prázdné stavy s jasnou další akcí. Stavy načítání a chyb u každé stránky.
- **UI-010** Rychlé hledání napříč aplikací (Ctrl+K).
- **UI-011** Centrum upozornění v aplikaci: selhání odeslání, faktury po splatnosti, nespárované platby, nerozpoznaná avíza, blížící se limity.
- **UI-012** Záložka Nápověda s návodem k hlavním úkonům a odpověďmi na časté otázky. Obsah vzniká až po dokončení ostatních funkcí.

Navigace: Přehled, Faktury, Pravidelné, Zákazníci, Ceník, Platby, Statistiky, Nápověda, Nastavení, Administrace.

## 21. Datový model (přehled)

Každá tabulka s daty účtu má `user_id`.

- auth: tabulky Better Auth, `invitation`
- `supplier_profile`, `bank_account`, `user_settings`, `automation_settings`, `mail_settings`, `bank_mailbox`
- `customer`, `catalog_item`, `unit`
- `number_series`, `invoice`, `invoice_line`, `invoice_version`, `payment`, `invoice_template`, `tag`, `invoice_tag`
- `recurring_invoice`, `recurring_run` (unikátní `(recurring_id, period_key)`)
- `reminder_rule`, `reminder_sent`, `email_template`, `email_log`
- `bank_notification`
- `dashboard`, `dashboard_widget`
- `import_batch`, `mapping_preset`, `export_job`, `file`
- `audit_log`, `job`, `scheduler_state`, `notification`, `exchange_rate`

Vztahy: `invoice.related_invoice_id` (záloha, oprava), `invoice.recurring_id`, `invoice.import_batch_id`. Faktura drží kopii údajů dodavatele a zákazníka.

## 22. Testování (TST)

Cíl: maximální pokrytí e2e testy podle této specifikace, doplněné backendovými testy.

- **TST-001** Každý požadavek s ID má aspoň jeden test. Název testu obsahuje ID, např. `test('[REC-020] ...')`.
- **TST-002** Skript `test:coverage-spec` načte ID ze specifikace a selže, když některé nemá test. Dočasné výjimky jsou v explicitním seznamu s důvodem.
- **TST-003** Backend (Vitest): služby proti skutečné SQLite v dočasném souboru, bez mockování databáze.
- **TST-004** E2E (Playwright): celé toky proti běžící aplikaci s čistou databází.
- **TST-005** Pošta: lokální SMTP server v testu, kontrola příjemců, příloh a hlavně **nepřítomnosti** zpráv u vypnutých automatik.
- **TST-006** IMAP: fixture avíz v obou jazycích, parser testován jednotkově, tok přes testovací IMAP server.
- **TST-007** Čas: plány se testují posunem injektovaných hodin, včetně přechodu roku, čtvrtletí, 31. dne a letního času.
- **TST-008** PDF: extrakce textu, dekódování QR, vizuální regrese pro každý design.
- **TST-009** Izolace a role: matice uživatel/administrátor/cizí uživatel přes všechny entity.
- **TST-010** Souběh: přidělení čísla a plánovač pod paralelním spuštěním.
- **TST-011** CI na každý commit: oxfmt check, oxlint, typová kontrola, Vitest, Playwright, build.
- **TST-012** Vlastnostní testy (`fast-check`) pokrývají výpočty částek, slev a zaokrouhlení, přepočty měn, přidělování čísel a výpočet plánů. Invariant: součet položek a slev vždy odpovídá celkové částce.
- **TST-013** Mutační testy (Stryker) běží nad jádrem: peníze, číselné řady, párování plateb, plánovač. Mutační skóre jádra je aspoň 90 %. Spouští se před vydáním, ne na každý commit.
- **TST-014** Sada ručně spočítaných vzorových faktur s očekávanými částkami. Každý design má schválený referenční výstup.
- **TST-015** Výstupy se ověřují zpětným čtením: QR se dekóduje a porovná s fakturou, ISDOC se validuje proti schématu a částky se porovnají s dokladem.
- **TST-016** U každé automatiky test ověří, že při vypnuté volbě nedostane SMTP žádnou zprávu, včetně doběhu po výpadku.
- **TST-017** Scénáře selhání uprostřed akce: nedostupné SMTP, plný disk, ukončení procesu během odesílání a běhu plánovače. Výsledek nesmí být duplicita ani ztráta dokladu.
- **TST-018** Po každém e2e toku běží kontrola souladu dat: stav faktury odpovídá platbám, přehledy odpovídají součtu dokladů, audit obsahuje každou změnu.
- **TST-019** Migrace se testují upgradem z každé vydané verze databáze. Záloha a obnova dají shodná data.
- **TST-020** Před prvním ostrým použitím proběhne lokální import skutečných faktur mimo repozitář a porovnání součtů se zdrojovým systémem.

Kritické e2e toky: první spuštění a onboarding, pozvánka, faktura od nuly po úhradu z avíza, zahraniční faktura v EUR, záloha → faktura, čtvrtletní pravidelná faktura, upomínka, import z CSV, záloha a obnovení účtu, přizpůsobení dashboardu a import JSON.

## 23. Pořadí implementace (návrh)

1. Základ: Next.js, tokeny, DB, auth, audit log, testovací infrastruktura.
2. Nastavení, zákazníci, ceník, číselné řady.
3. Faktury, PDF, QR, designy.
4. E-mail, upomínky, pravidelné faktury, plánovač.
5. Platby, avíza Fio.
6. Zálohy, opravné faktury, zahraniční faktury.
7. Dashboard a přehledy.
8. Import, export, daňový přehled.
9. Monitoring, provozní doplňky, dokumentace.

Všech devět bodů je hotových. Co zbývá, závisí na zadavateli a daňovém poradci (kap. 24).

## 24. Otevřené body

| Bod | Dopad | Kdo |
|---|---|---|
| Vzorek anglického avíza Fio | Česká varianta BNK-005 je ověřená na skutečném avízu. Anglická je sestavená z veřejných zmínek, do dodání vzorku je prozatímní a sama se nepáruje. | zadavatel |
| Vzorky ISDOC a CSV z Fakturoidu a iDokladu | Fakturovač je ověřený na 40 reálných dokladech, ostatní jen z dokumentace. Vestavěné předlohy (IMP-002) a porovnání součtů se zdrojem (TST-020) čekají na skutečné exporty | zadavatel, pak implementace |
| Znění doložky FOR-006, náležitosti neplátce, TAX-001, použití pevného kurzu FOR-010 | Daňová správnost, zatím z obecné znalosti | daňový poradce |
| Referenční PNG designů faktur | Vizuální regrese (TST-014, PDF-007) hlídá jen první stranu a čeká na schválení | zadavatel |

Uzavřené body: TanStack Charts (stabilní řada 1.x, použito přesně `@tanstack/charts@1.1.0` za obalem `Chart`; hydratace, CSP a tmavý režim ověřeny, při budoucím problému obal dostane `recharts@3.10.1` beze změny `ChartSpec`).

## 25. Přístup asistentů (MCP)

Požadavky převzaté z `2026-11-11-mcp-design.md`, kap. 4 (jen věty požadavků; zdůvodnění, uživatelský tok a architektura jsou tam).

### 25.1 Autorizace a připojení

- **MCP-001** Fakturan je autorizační server OAuth 2.1 pro vlastní MCP endpoint přes pluginy Better Auth. Publikuje metadata autorizačního serveru (RFC 8414) i chráněného zdroje (RFC 9728) na cestách, které klienti hledají, včetně variant pod `/.well-known/…` v kořeni domény.
- **MCP-002** Registrace klienta podporuje to, co potřebují Claude.ai, Claude Code a ChatGPT (dynamická registrace RFC 7591 a/nebo Client ID Metadata Document), ověřené na reálném klientovi. PKCE (S256) je povinné.
- **MCP-003** Přihlášení na `/prihlaseni` po úspěchu pokračuje v rozpracované autorizaci, heslem i přes sociální poskytovatele.
- **MCP-004** OAuth nikdy nezaloží účet. AUTH-002 a AUTH-005 platí beze změny.
- **MCP-005** Souhlasová stránka `/pristup-asistenta` zobrazí název a doménu klienta jako nedůvěryhodný text (žádné HTML, omezená délka) a upozorní, že název uvádí klient sám. Zamítnutí vrátí klientovi `access_denied`.
- **MCP-006** Když je přístup asistentů vypnutý (MCP-010), autorizace skončí na stránce s vysvětlením a odkazem do Nastavení. Souhlas se neukáže a token se nevydá.
- **MCP-007** Přístupový token platí nejvýš 15 minut, obnovovací token se při použití rotuje. Audience tokenu je přesně adresa `/api/mcp` této instance, token pro jiný zdroj endpoint odmítne.
- **MCP-008** Scope je jediný, `fakturan`. Co asistent smí, určuje úroveň oprávnění v Nastavení kontrolovaná při každém volání (MCP-012, MCP-052).
- **MCP-009** V režimu ukázky je MCP vypnuté: endpoint, metadata i autorizace vrací `404` a záložka v Nastavení se nezobrazí.

### 25.2 Nastavení › Asistenti

- **MCP-010** Hlavní vypínač „Povolit připojení asistentů“ je ve výchozím stavu vypnutý. Vypnutí okamžitě odmítne všechna volání a nové autorizace, propojení ale nesmaže.
- **MCP-011** Úroveň oprávnění (MCP-050) platí pro všechny asistenty uživatele; výchozí je Jen čtení. Nahrazuje přepínače schopností první verze.
- **MCP-012** Server při každém volání nástroje ověří platný token, hlavní vypínač, potřebnou úroveň, existující propojení klienta s uživatelem a že účet není zablokovaný. Nedostatečná úroveň vrátí chybu nástroje se srozumitelnou českou větou, ne HTTP chybu (pořadí kontrol MCP-052).
- **MCP-013** Seznam propojených asistentů ukáže název klienta, doménu, kdy byl připojen a kdy naposledy použit (na minuty) a tlačítko Odpojit. Odpojení smaže souhlas i obnovovací tokeny klienta a přestane platit i ještě neexpirovaný přístupový token.
- **MCP-014** Změny vypínače, úrovně, záznamu volání a odpojení se zapíší do auditu jako ostatní nastavení (zdroj `web`).
- **MCP-015** Záložka je dostupná každému uživateli a každý uživatel má vlastní nastavení.

### 25.3 Nástroje první verze

- **MCP-020** `get_overview` (Číst) vrátí za zvolené období vystaveno, uhrazeno, neuhrazeno, z toho po splatnosti, počty a rozdělení podle měny shodně se Statistikami (REP), bez konceptů a storen.
- **MCP-021** `list_unpaid_invoices` (Číst) vrátí neuhrazené a částečně uhrazené vystavené faktury, volitelně jen po splatnosti a jen pro zákazníka, se stránkováním a výchozím řazením podle splatnosti.
- **MCP-022** `get_invoice` (Číst) vrátí detail faktury podle ID nebo čísla. Faktura jiného účtu se chová jako neexistující.
- **MCP-023** `search_customers` a `search_catalog` (Číst) hledají zákazníka a položku ceníku podle textu stávajícím hledáním.
- **MCP-024** `create_draft_invoice` (Zakládat) založí jen koncept přes stejné schéma a službu jako web, doplní výchozí hodnoty uživatele, nespálí žádné číslo a chyby validace vrátí jako chybu nástroje s výčtem polí.
- **MCP-025** Nahrazeno MCP-053: `tools/list` vrací jen nástroje do aktuální úrovně a instrukce serveru říkají, že chybějící nástroj může vyžadovat vyšší úroveň.

### 25.4 Audit, limity, bezpečnost

- **MCP-030** Audit má zdroj `mcp`. Záznam nese ID a název klienta a historie ve webu ukáže „Asistent: <název>“.
- **MCP-031** Čtení přes MCP se do auditu nezapisuje. Zapisuje se vydání a odvolání přístupu (autorizace, odpojení). Každé volání včetně čtení jde do samostatného logu volání (MCP-060), pokud ho uživatel nevypnul.
- **MCP-032** Endpoint má limit volání na uživatele a klienta (60 za minutu) a registrace klientů limit podle IP. Překročení vrátí `429`. Platí i limity účtu.
- **MCP-033** Výstupy nástrojů jsou data, ne instrukce: texty z dokladů jsou v `structuredContent` jako hodnoty a v textu zřetelně oddělené. Žádný nástroj nesmí na základě obsahu dokumentu provést další akci.
- **MCP-034** `proxy.ts` endpoint MCP, metadata ani OAuth trasy nepřesměrovává na přihlášení. Odpověď bez tokenu je `401` s hlavičkou `WWW-Authenticate` podle RFC 9728.
- **MCP-035** Endpoint je bezstavový, každý požadavek nese token.
- **MCP-036** Do Sentry jde u chyb MCP jen ID uživatele a název nástroje, ne argumenty ani výstup.
- **MCP-037** MCP nepřidává žádnou povinnou proměnnou. Adresa instance se bere z `BETTER_AUTH_URL`; nová proměnná se přidá do `.env.example` a kap. 19.5.
- **MCP-038** Volitelná proměnná `MCP_ENABLED` (výchozí `true`) vypne MCP pro celou instanci stejně jako režim ukázky.

### 25.5 Upřesnění

- **MCP-040** Autorizační server staví výhradně na ekosystému Better Auth a tenkém lepidle kolem něj. Povinné jsou PKCE, audience, okamžité odpojení a funkční registrace aspoň pro Claude Code a Claude.ai. Odchylky se zapíší do PR.
- **MCP-041** Propojení je řádek souhlasu pro dvojici uživatel a klient, který obal nástrojů čte při každém volání. „Naposledy použit“ se zapisuje nejvýš jednou za minutu na propojení, mimo audit.
- **MCP-042** `mcp_settings` je součástí zálohy účtu a po obnově je hlavní vypínač vždy vypnutý, úroveň a přepínač logu se obnoví. Log volání v záloze není (MCP-065). OAuth tabulky nejsou v záloze, exportu ani obnově. Smazání uživatele smaže jeho souhlasy a tokeny, klienti zůstanou.
- **MCP-043** `create_draft_invoice` zakládá běžnou fakturu ve výchozí řadě, ceny a množství přijímá jako desetinné řetězce převedené stávajícími pomocníky, kurz cizí měny doplní z ČNB, `idempotency_key` předá jako `clientId` konceptu a odkaz ve výstupu je absolutní.
- **MCP-044** Souhlasová stránka ukáže hostitele z `redirect_uri` („aplikace na tomto počítači“ pro `localhost` a `127.0.0.1`, hostitele dokumentu u CIMD). Stránka ukáže aktuální úroveň oprávnění a větu, že ji lze změnit v Nastavení › Asistenti (MCP-054).
- **MCP-045** Na `http://localhost` a `http://127.0.0.1` funguje celý tok bez HTTPS. Vydavatel, audience i metadata se odvozují z `BETTER_AUTH_URL`.

### 25.6 Úrovně oprávnění, log volání a plná sada nástrojů

Návrh: `docs/superpowers/specs/2026-11-12-mcp-full-design.md` (kap. 5 je závazný seznam nástrojů).

- **MCP-050** Úroveň je jedna na uživatele a platí pro všechny jeho asistenty (jako v1). Výchozí je `read`. Hlavní vypínač (MCP-010) zůstává beze změny.
- **MCP-051** Nástroj deklaruje minimální úroveň. U `save_recurring` je požadovaná úroveň vyšší ze dvou: podle režimu na vstupu a podle režimu uloženého plánu (`draft` = 3, `issue` a `send` = 4). Uložený plán se čte přes `getRecurring`. Asistent s úrovní 3 tak nezmění běžící plán, který sám vystavuje nebo odesílá.
- **MCP-052** Ověření při každém volání (rozšíření MCP-012) v tomto pořadí: dostupnost → účet → vypínač → propojení → minimální úroveň nástroje (před validací vstupu, takže asistent pod úrovní se nedozví nic o vstupu) → validace vstupu → případně úroveň odvozená ze vstupu (MCP-051) → služba. Odmítnutí je chyba nástroje s českou větou, která říká potřebnou úroveň („Tahle operace vyžaduje úroveň Vystavování a odesílání. Úroveň nastavíte v Nastavení › Asistenti.“). Zachycuje i volání nástroje, který klient zná ze staršího seznamu.
- **MCP-053** `tools/list` vrací jen nástroje dostupné na aktuální úrovni uživatele (nahrazuje MCP-025). Když je hlavní vypínač vypnutý nebo klient odpojený, seznam je prázdný. Server posílá MCP `instructions` (a stejnou větu má popis každého nástroje úrovně nižší než 5): „Fakturan má pět úrovní oprávnění (Jen čtení, Koncepty, Účetní operace, Vystavování a odesílání, Plný přístup). Aktuální úroveň je <název>. Pokud ti chybí nástroj pro to, co uživatel chce, je možné, že vyžaduje vyšší úroveň; řekni uživateli, že ji může nastavit v Nastavení › Asistenti. Operace, které ve webu potvrzuje člověk, přes asistenta nejdou vůbec.“ Endpoint je bezstavový (MCP-035), takže změnu úrovně klient uvidí po novém načtení seznamu nástrojů; do té doby ho chrání MCP-052. Anotace: `readOnlyHint` pro úroveň 1, `destructiveHint` pro úroveň 5.
- **MCP-054** Nastavení › Asistenti: místo přepínačů schopností volba úrovně (5 možností s jednou větou popisu, co úroveň přidává). Souhlasová stránka ukazuje aktuální úroveň místo seznamu schopností.
- **MCP-055** Migrace dat: nový sloupec `level` v `mcp_settings`, sloupce `can_*` se odstraní. Převod: `can_create = true` → `drafts`, jinak `read`. Registr záloh (`server/backup/tables.ts`) a obnova se upraví; starší záloha se sloupci `can_*` se při obnově převede stejným pravidlem. Po obnově zůstává hlavní vypínač vypnutý (MCP-042). Souhlasy a tokeny OAuth schopnosti neobsahují (jediný scope `fakturan`, MCP-008), takže stávající propojení po migraci fungují dál bez nového souhlasu.
- **MCP-056** Změna úrovně se zapíše do Historie změn jako dosud (`mcp.settings_changed`, zdroj `web`).
- **MCP-060** Nová tabulka `mcp_call_log`: id, `owner_id`, `at`, `client_id`, `client_name`, `tool`, `outcome` (`ok` | `denied` | `error`), `reason` (krátký kód: např. `level`, `disabled`, `not_connected`, `invalid_input`, `service_error`, `confirm_in_web`), `required_level`, `request_id`. Neukládají se argumenty ani výstup (data z dokladů v logu nebudou; v souladu s MCP-036).
- **MCP-061** Zápis dělá obal `runTool` u každého volání, kde je znám vlastník (claim `sub` odpovídá aktivnímu účtu), včetně odmítnutí před `admit` dokončením. Zápis logu nesmí změnit výsledek volání: selhání zápisu jde do Sentry a volání pokračuje. Zápis logu je mimo audit transakci služby.
- **MCP-062** Přepínač „Zaznamenávat volání asistentů“ v Nastavení › Asistenti, výchozí zapnuto. Když je vypnutý, do logu se nic nezapisuje. Změny dat jdou do Historie změn vždy (MCP-030) bez ohledu na přepínač. Změna přepínače se zapíše do Historie změn.
- **MCP-063** Nastavení › Asistenti zobrazí log: čas, asistent, nástroj, výsledek, důvod odmítnutí česky; stránkování, nejnovější nahoře; filtr podle asistenta a výsledku.
- **MCP-064** Záznamy starší než 90 dní maže plánovač (stejný vzor jako ostatní `purge*` v `server/scheduler/start.ts`). Tlačítko „Smazat log“ ve webu.
- **MCP-065** Log patří k účtu: maže se se smazáním uživatele (cascade). V záloze účtu není (je to provozní záznam s krátkou životností).
- **MCP-066** Rate limit (HTTP 429, MCP-032) se do logu nezapisuje, protože odmítnutí nastane před rozlišením nástroje.
- **MCP-067** U odmítnutí kvůli úrovni se do `required_level` zapíše úroveň, která chyběla; u neplatného vstupu a chyb před ověřením úrovně je prázdná.
- **MCP-070** Každý nástroj volá právě tu službu (nebo službu přesunutou z akce podle kap. 6), kterou volá odpovídající akce webu, se stejným vstupním schématem (Zod schéma služby nebo akce, viz inventura). Mutace dostávají `ctx.actor` (audit se zdrojem `mcp`), čtení `ctx.ownerId`.
- **MCP-071** Konvence v1 platí dál: anglické `snake_case` názvy, české popisy, částky na vstupu jako desetinné řetězce převedené stávajícími pomocníky (`parseMoney`, `parseQuantity`), ve výstupu formátované i strojové (`server/mcp/format.ts`), data `RRRR-MM-DD`, texty z dokladů ohraničené `quoted()` (MCP-033), odkazy do webu absolutní. Kde webové schéma bere částky v nejmenších jednotkách, nástroj převede desetinný řetězec stávajícím pomocníkem; jiné převody nevznikají.
- **MCP-072** Optimistická souběžnost: nástroje měnící fakturu nebo platbu přijímají `revision` stejně jako web. `get_invoice` proto nově vrací `revision`, ID plateb, ID verzí a ID záznamů pošty. Chyba „zastaralé“ vrací text s radou znovu načíst fakturu.
- **MCP-073** Chyby služeb se mapují jako v1 (`toolErrorResult`). `NotIssuableError` vrátí výčet problémů v textu i ve `structuredContent`.
- **MCP-074** Izolace účtů: cizí ID se chová jako neexistující (jako MCP-022), u všech nástrojů.
- **MCP-075** Stránkování a limity velikosti výstupu převzaté ze služeb; tam, kde služba limit nemá, nástroj omezí stránku na nejvýš 50 položek.

