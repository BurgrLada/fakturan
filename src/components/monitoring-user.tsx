"use client";

import { useEffect } from "react";
import { identifyClientUser } from "@/lib/monitoring-client";

export function MonitoringUser({ id }: { id: string }) {
  useEffect(() => {
    identifyClientUser(id);
    return () => identifyClientUser(null);
  }, [id]);
  return null;
}
