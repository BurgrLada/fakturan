import { isFakturanNext, reapRecorded, REGISTRY_DIR } from "./process-registry";

// Normally empty: each fixture stops its own server. Left over only after a crashed worker.
export default function globalTeardown() {
  const reaped = reapRecorded(REGISTRY_DIR, (pid) => isFakturanNext(pid));
  if (reaped.length > 0) console.warn(`Ukončené servery po pádu workeru: ${reaped.join(", ")}`);
}
