const DATE_TIME = new Intl.DateTimeFormat("cs-CZ", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Prague",
});

export function formatDateTime(value: Date | null): string {
  return value ? DATE_TIME.format(value) : "–";
}
