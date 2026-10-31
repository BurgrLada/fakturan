import type { Db } from "./db";
import { schedulerHealth, type SchedulerHealth } from "./scheduler/start";

export type Health = {
  status: "ok" | "error";
  database: "ok" | "error";
  scheduler: SchedulerHealth;
};

export function checkHealth(db: Pick<Db, "$client">): Health {
  let database: Health["database"] = "ok";
  try {
    db.$client.prepare("SELECT 1").get();
  } catch {
    database = "error";
  }
  const scheduler = schedulerHealth(db);
  const healthy = database === "ok" && scheduler !== "stale";
  return { status: healthy ? "ok" : "error", database, scheduler };
}
