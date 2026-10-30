import { useLayoutEffect, useState } from "react";

// A route hidden by Next stays in the DOM. A form returning null while hidden keeps its state, but
// its ids no longer capture the labels of the same form on the visible route.
export function useRouteShown(): boolean {
  const [shown, setShown] = useState(true);
  useLayoutEffect(() => {
    setShown(true);
    return () => setShown(false);
  }, []);
  return shown;
}
