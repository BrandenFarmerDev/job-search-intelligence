import { Alert } from "./ui";
import { sessionUrl } from "../lib/api";

export function ErrorAlert({ message, title }: { message: string; title?: string }) {
  return <Alert tone="danger" title={title}>{message} <a href={sessionUrl()}>Sign in to the private API</a></Alert>;
}
