import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { DashboardProvider, useDashboard } from "../lib/dashboard-context";
import { freshnessText } from "../lib/format";
import { useTheme, type ThemePreference } from "../lib/theme";
import { ErrorAlert } from "./ErrorAlert";
import { Alert, Button, MenuIcon } from "./ui";

const navItems = [
  { to: "/", label: "Overview", end: true }, { to: "/applications", label: "Applications" }, { to: "/review", label: "Review" },
  { to: "/sources", label: "Sources & privacy" }, { to: "/about", label: "About" },
];
const themes: { value: ThemePreference; label: string }[] = [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
const REVIEW_CAP = 100;

export function Layout() {
  return <DashboardProvider><Shell /></DashboardProvider>;
}

function Shell() {
  const { dashboard, reviews, error, notice } = useDashboard();
  const { pathname } = useLocation();
  const { preference, setPreference } = useTheme();
  // The menu stays open only for the route it was opened on, so any navigation closes it.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const menuOpen = openAt === pathname;
  const toggle = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const visited = useRef(pathname);
  useEffect(() => {
    if (visited.current === pathname) return;
    visited.current = pathname;
    main.current?.querySelector("h1")?.focus();
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpenAt(null); toggle.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  const waiting = reviews.length;
  return <>
    <a className="qe-skip-link" href="#main-content">Skip to main content</a>
    <div className="qe-shell">
      <header className="qe-shell-header">
        <Button ref={toggle} className="qe-nav-toggle" size="compact" aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setOpenAt(menuOpen ? null : pathname)}><MenuIcon />Menu</Button>
        <Link className="qe-brand" to="/">Job Search Intelligence</Link>
        <div className="qe-shell-actions">
          <p className="qe-freshness">{freshnessText(dashboard?.lastSuccessfulSyncAt)}</p>
          <div className="qe-theme">
            <label className="qe-label" htmlFor="theme-preference">Theme</label>
            <select id="theme-preference" className="qe-input" value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)}>
              {themes.map((theme) => <option key={theme.value} value={theme.value}>{theme.label}</option>)}
            </select>
          </div>
        </div>
      </header>
      <nav id="primary-navigation" className="qe-sidebar" aria-label="Primary navigation" data-open={menuOpen}>
        <ul className="qe-nav">{navItems.map((item) => <li key={item.to}>
          <NavLink className="qe-nav-link" to={item.to} end={item.end}>
            {item.label}{" "}
            {item.to === "/review" && waiting > 0 && <span className="qe-nav-badge">{waiting >= REVIEW_CAP ? `${REVIEW_CAP}+` : waiting}<span className="qe-visually-hidden"> records waiting</span></span>}
          </NavLink>
        </li>)}</ul>
      </nav>
      <main id="main-content" className="qe-main" ref={main} tabIndex={-1}>
        <div className="qe-container qe-stack" data-gap="8">
          {(error || notice) && <div className="qe-stack" data-gap="3">
            {error && <ErrorAlert message={error} />}
            {notice && <Alert tone="success">{notice}</Alert>}
          </div>}
          <Outlet />
        </div>
      </main>
      <footer className="qe-footer"><p>Private owner workspace. Outlook and tracker connections are read-only.</p></footer>
    </div>
  </>;
}
