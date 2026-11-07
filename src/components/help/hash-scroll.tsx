"use client";

import { useEffect } from "react";

// The chapters stream in behind Suspense, after the browser has already tried to jump to the hash.
export function HashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);
  return null;
}
