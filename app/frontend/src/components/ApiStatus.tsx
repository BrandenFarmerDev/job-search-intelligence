import { useEffect, useState } from "react";
import { getApiHealth } from "../lib/api";

export function ApiStatus() {
  const [status, setStatus] = useState("Checking API connection…");
  useEffect(() => {
    const controller = new AbortController();
    getApiHealth(controller.signal)
      .then(() => { if (!controller.signal.aborted) setStatus("API connected"); })
      .catch(() => { if (!controller.signal.aborted) setStatus("API unavailable. Check your owner session and try again."); });
    return () => controller.abort();
  }, []);
  return <p role="status" className="api-status">{status}</p>;
}
