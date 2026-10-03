import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

export function NotFoundPage() {
  return <>
    <PageHeader title="Page not found" description="This page is not part of the workspace." />
    <p><Link className="qe-button" data-variant="primary" to="/">Return home</Link></p>
  </>;
}
