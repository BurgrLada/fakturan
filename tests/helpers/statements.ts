import type { Db } from "@/server/db";

// Drizzle prepares every query on its client, so the prepared SQL is the list of statements run.
export function recordStatements<T>(db: Db, run: () => T): { result: T; statements: string[] } {
  const client = db.$client;
  const original = client.prepare;
  const statements: string[] = [];
  client.prepare = ((source: string) => {
    statements.push(source);
    return original.call(client, source);
  }) as typeof client.prepare;
  try {
    return { result: run(), statements };
  } finally {
    client.prepare = original;
  }
}
