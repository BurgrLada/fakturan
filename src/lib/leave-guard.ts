type LeaveGuard = () => Promise<boolean>;

let guard: LeaveGuard | null = null;

// For leaving by something other than a link, which the form cannot intercept on its own.
export function setLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

export function mayLeave(): Promise<boolean> {
  return guard ? guard() : Promise.resolve(true);
}
