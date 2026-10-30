import { connection } from "next/server";
import { db } from "@/server/db";
import { checkHealth } from "@/server/health";

export async function GET() {
  await connection();
  const health = checkHealth(db);
  return Response.json(health, {
    status: health.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
