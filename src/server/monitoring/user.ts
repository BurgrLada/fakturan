type Sdk = { setUser: (user: { id: string }) => void };

// Id only, never e-mail or IP (MON-004). The SDK is loaded lazily, and only when monitoring is on.
export async function setMonitoringUser(
  id: string,
  dsn = process.env.SENTRY_DSN,
  load: () => Promise<Sdk> = () => import("@sentry/nextjs"),
): Promise<void> {
  if (!dsn) return;
  (await load()).setUser({ id });
}
