import { Link, Outlet } from "react-router-dom";

export function Layout() {
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Link to="/">Job Search Intelligence</Link><Link to="/about">About this workspace</Link><span>Private · owner access</span></header>
    <main id="main" tabIndex={-1}><Outlet /></main>
    <footer>Private owner workspace. Outlook and tracker connections are read-only.</footer>
  </>;
}
