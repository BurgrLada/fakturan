"use client";

import { Fragment, type ReactNode } from "react";

// Uncontrolled filter fields keep their values across a soft navigation. A key set in a server
// component leaves the previous form in the DOM after a streamed page load, so it lives here.
export function Remount({ on, children }: { on: string; children: ReactNode }) {
  return <Fragment key={on}>{children}</Fragment>;
}
