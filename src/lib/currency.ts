export const CURRENCIES = ["CZK", "EUR", "USD", "GBP", "CHF", "PLN"] as const;
export type Currency = (typeof CURRENCIES)[number];
