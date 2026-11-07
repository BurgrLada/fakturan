"use client";

import { useEffect } from "react";

// The chapters stream in behind Suspense, after the browser has already tried to jump to the hash.
// Focus follows the jump so keyboard and screen reader users land in the chapter too.
function jump() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  const target = id ? document.getElementById(id) : null;
  if (!target) return;
  target.scrollIntoView();
  target.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
}

export function HashScroll() {
  useEffect(() => {
    jump();
    window.addEventListener("hashchange", jump);
    return () => window.removeEventListener("hashchange", jump);
  }, []);
  return null;
}
