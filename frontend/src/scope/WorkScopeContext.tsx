import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "rcrm_my_work_only";

interface WorkScopeValue {
  /** true = "My Work" (just this person's own book); false = "My Team/Branch". */
  myWorkOnly: boolean;
  setMyWorkOnly: (v: boolean) => void;
}

const WorkScopeContext = createContext<WorkScopeValue | null>(null);

/**
 * One app-level "My Team ↔ My Work" preference, not three. Previously the
 * same choice existed as three separate controls with three different
 * labels and semantics -- an unlabelled Switch on the Dashboard, a
 * "Personal | Team" Segmented on My Worklist, and a "Personal | Branch"
 * Segmented on My Worklist's Today section -- and only the first of the
 * three actually changed anything outside its own widget. Persisted to
 * localStorage so the choice survives navigation and a refresh, matching
 * "app-level" rather than "per-page" framing.
 */
export function WorkScopeProvider({ children }: { children: ReactNode }) {
  const [myWorkOnly, setMyWorkOnlyState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(myWorkOnly));
    } catch {
      // Private browsing / storage disabled -- the toggle still works for
      // the current session, it just won't be remembered next time.
    }
  }, [myWorkOnly]);

  const value = useMemo(() => ({ myWorkOnly, setMyWorkOnly: setMyWorkOnlyState }), [myWorkOnly]);

  return <WorkScopeContext.Provider value={value}>{children}</WorkScopeContext.Provider>;
}

export function useWorkScope(): WorkScopeValue {
  const ctx = useContext(WorkScopeContext);
  if (!ctx) throw new Error("useWorkScope must be used within a WorkScopeProvider");
  return ctx;
}
