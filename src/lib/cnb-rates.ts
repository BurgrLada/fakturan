import { CURRENCIES, type Currency } from "./currency";
import { MAX_EXCHANGE_RATE_MICROS, rateFromList } from "./fx";
import { isCalendarDate, type CalendarDate } from "./number-format";

export type ParsedRates = {
  listDate: CalendarDate;
  rates: { currency: Currency; rateMicros: number }[];
};

const HEADER = "země|měna|množství|kód|kurz";
const TITLE = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) #\d{1,3}$/;
const AMOUNT = /^[1-9]\d{0,5}$/;
const CODE = /^[A-Z]{3}$/;
const MAX_LINE = 200;

const KEPT: ReadonlySet<string> = new Set(CURRENCIES.filter((code) => code !== "CZK"));

function dateOf(line: string): CalendarDate | null {
  const match = TITLE.exec(line);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  return isCalendarDate(iso) ? iso : null;
}

// All or nothing, and a list without the euro is refused as well, because it is the one every
// account relies on to tell a healthy list from a broken one: a list that fails anywhere is not trusted in part, because a shifted column
// would store a plausible but wrong rate.
export function parseDailyRates(text: string): ParsedRates | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 3 || lines.some((line) => line.length > MAX_LINE)) return null;
  const listDate = dateOf(lines[0]!);
  if (!listDate || lines[1] !== HEADER) return null;

  const seen = new Set<string>();
  const rates: ParsedRates["rates"] = [];
  for (const line of lines.slice(2)) {
    const cells = line.split("|");
    if (cells.length !== 5) return null;
    const [country, name, amount, code, rate] = cells as [string, string, string, string, string];
    if (!country || !name || !AMOUNT.test(amount) || !CODE.test(code) || seen.has(code)) {
      return null;
    }
    seen.add(code);
    const rateMicros = rateFromList(rate, Number(amount));
    if (rateMicros === null || rateMicros > MAX_EXCHANGE_RATE_MICROS) return null;
    if (KEPT.has(code)) rates.push({ currency: code as Currency, rateMicros });
  }
  return rates.some((item) => item.currency === "EUR") ? { listDate, rates } : null;
}
