import { useLayoutEffect, useRef, useState } from "react";

const PARKED_ID = "data-parked-id";

// A route hidden by Next stays in the DOM, and its ids would capture the labels of the same form on
// the visible route. Returning null keeps the state but is a deferred update on a hidden tree, so
// the ids are also parked synchronously for the commit in which the next route appears.
export function useRouteShown<T extends HTMLElement>() {
  const root = useRef<T>(null);
  const attached = useRef<T>(null);
  const [shown, setShown] = useState(true);
  useLayoutEffect(() => {
    attached.current = root.current;
  });
  useLayoutEffect(() => {
    setShown(true);
    attached.current?.querySelectorAll(`[${PARKED_ID}]`).forEach((element) => {
      element.id = element.getAttribute(PARKED_ID)!;
      element.removeAttribute(PARKED_ID);
    });
    return () => {
      setShown(false);
      attached.current?.querySelectorAll("[id]").forEach((element) => {
        element.setAttribute(PARKED_ID, element.id);
        element.removeAttribute("id");
      });
    };
  }, []);
  return { shown, root };
}
