"use client";

import { useEffect } from "react";
import { identifyClientUser } from "@/lib/monitoring-client";

export function MonitoringUser({ id }: { id: string }) {
  useEffect(() => identifyClientUser(id), [id]);
  return null;
}
