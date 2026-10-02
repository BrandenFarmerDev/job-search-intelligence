import { Link } from "react-router-dom";

export function NotFoundPage() {
  return <><h1>Page not found</h1><p>This page is not part of the workspace.</p><Link to="/">Return home</Link></>;
}
