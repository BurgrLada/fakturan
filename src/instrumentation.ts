export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { db, runMigrations } = await import("./server/db");
  runMigrations(db);
  const trusted = ["1", "true"].includes(process.env.TRUST_PROXY ?? "");
  if (process.env.NODE_ENV === "production" && !trusted) {
    console.warn(
      "TRUST_PROXY není nastaveno: všichni klienti sdílejí jeden bucket rate limitu. Za reverzní proxy nastavte TRUST_PROXY=1.",
    );
  }
}
