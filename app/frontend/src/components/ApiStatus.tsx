import { useEffect, useState } from "react";
import { getApiHealth } from "../lib/api";
import { Alert } from "./ui";

type Status = { tone: "info" | "success" | "warning"; text: string };

export function ApiStatus() {
  const [status, setStatus] = useState<Status>({ tone: "info", text: "Checking API connection…" });
  useEffect(() => {
    const controller = new AbortController();
    getApiHealth(controller.signal)
      .then(() => { if (!controller.signal.aborted) setStatus({ tone: "success", text: "API connected" }); })
      .catch(() => { if (!controller.signal.aborted) setStatus({ tone: "warning", text: "API unavailable. Check your owner session and try again." }); });
    return () => controller.abort();
  }, []);
  return <Alert tone={status.tone}>{status.text}</Alert>;
}
