import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Dashboard } from "@job-search/shared";
import type { ReviewItem } from "./applications";
import { errorMessage, intelligenceApi } from "./api";

const SAVED = "Saved. The dashboard has been refreshed.";
export interface DashboardContextValue {
  dashboard: Dashboard | null; reviews: ReviewItem[]; error: string; notice: string;
  /** True from the first request (and each refresh) until it settles. */
  loading: boolean; busy: boolean;
  /** Increments after every refresh so views with their own requests can reload too. */
  revision: number;
  refresh: () => void;
  /** Runs any owner action, reports its outcome in the shell, and refreshes every cache on success. */
  perform: (task: () => Promise<string | void>) => Promise<boolean>;
  runAction: (path: string, method?: string, body?: object, notice?: string) => Promise<boolean>;
}
const Context = createContext<DashboardContextValue | null>(null);

export function useDashboard(): DashboardContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("useDashboard must be used inside DashboardProvider");
  return value;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([intelligenceApi<Dashboard>("/dashboard", "GET", undefined, controller.signal), intelligenceApi<ReviewItem[]>("/review", "GET", undefined, controller.signal)])
      .then(([view, queue]) => { if (!controller.signal.aborted) { setDashboard(view); setReviews(queue); setError(""); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason, "Dashboard unavailable")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const refresh = useCallback(() => { setLoading(true); setRevision((value) => value + 1); }, []);
  const perform = useCallback(async (task: () => Promise<string | void>) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const message = await task();
      if (mounted.current) { setNotice(message || SAVED); refresh(); }
      return true;
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason, "Request failed"));
      return false;
    } finally { if (mounted.current) setBusy(false); }
  }, [refresh]);
  const runAction = useCallback((path: string, method = "POST", body?: object, message?: string) => perform(async () => { await intelligenceApi(path, method, body); return message; }), [perform]);
  const value = useMemo(() => ({ dashboard, reviews, error, notice, loading, busy, revision, refresh, perform, runAction }), [dashboard, reviews, error, notice, loading, busy, revision, refresh, perform, runAction]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
