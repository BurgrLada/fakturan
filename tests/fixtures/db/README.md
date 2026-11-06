# Body vydání databáze (TST-019)

Každý soubor `<verze>.sql` je stav databáze vydané verze se smyšlenými daty jednoho účtu.
`tests/backend/migrations-upgrade.test.ts` ho načte, spustí všechny migrace z `drizzle/` a ověří
`foreign_key_check`, `integrity_check` a `assertConsistent` každého účtu. Nad `0.1.0.sql` navíc
proběhne záloha a obnova a obnovený účet se porovná kanonicky se zdrojem.

Při každém vydání přidejte soubor pro novou verzi z `package.json`:

```bash
WRITE_DB_FIXTURE=1 timeout 170 pnpm exec vitest run tests/backend/migrations-upgrade.test.ts -t "bod vydání"
```

Starší soubory se nemění ani nemažou: test je čte všechny, takže každá vydaná verze musí projít
upgradem až na aktuální schéma. Skutečná data sem nikdy nepatří (IMP-013).
