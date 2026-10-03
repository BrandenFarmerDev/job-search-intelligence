import { useEffect, useState } from "react";
import { errorMessage, intelligenceApi } from "./api";

interface Loaded<T> { path: string | null; key: string; data?: T; error?: string }

// Keeps the previous result for the same path while a refresh is in flight; a different path never shows stale data.
export function useApiResource<T>(path: string | null, refreshKey: number, failure: string) {
  const [state, setState] = useState<Loaded<T>>({ path: null, key: "" });
  const key = path === null ? "" : `${refreshKey}|${path}`;
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    intelligenceApi<T>(path, "GET", undefined, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ path, key, data }); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setState({ path, key, error: errorMessage(reason, failure) }); });
    return () => controller.abort();
  }, [path, key, failure]);
  return {
    data: state.path === path ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    loading: key !== "" && state.key !== key,
  };
}
