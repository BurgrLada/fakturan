import type { Db } from "./db";

export type Health = {
  status: "ok" | "error";
  database: "ok" | "error";
  scheduler: "not_started";
};

// Health is the database alone for now: the scheduler lands in a later plan and then reports here.
export function checkHealth(db: Pick<Db, "$client">): Health {
  let database: Health["database"] = "ok";
  try {
    db.$client.prepare("SELECT 1").get();
  } catch {
    database = "error";
  }
  return { status: database, database, scheduler: "not_started" };
}
