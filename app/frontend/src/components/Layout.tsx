import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { REVIEW_CAP } from "../lib/applications";
import { DashboardProvider, useDashboard } from "../lib/dashboard-context";
import { freshnessText } from "../lib/format";
import { useSidebar } from "../lib/sidebar";
import { useTheme, type ThemePreference } from "../lib/theme";
import { ErrorAlert } from "./ErrorAlert";
import { Alert, BriefcaseIcon, Button, CloseIcon, DatabaseIcon, GridIcon, InboxIcon, InfoIcon, MenuIcon, MonitorIcon, MoonIcon, PanelCloseIcon, PanelOpenIcon, SegmentedControl, SunIcon, type SegmentedOption } from "./ui";

const navItems = [
  { to: "/", label: "Overview", end: true, Icon: GridIcon }, { to: "/applications", label: "Applications", Icon: BriefcaseIcon }, { to: "/review", label: "Review", Icon: InboxIcon },
  { to: "/sources", label: "Sources & privacy", Icon: DatabaseIcon }, { to: "/about", label: "About", Icon: InfoIcon },
];
const WIDE = "(width >= 64rem)";
const themes: SegmentedOption<ThemePreference>[] = [
  { value: "system", label: <MonitorIcon />, name: "System theme" }, { value: "light", label: <SunIcon />, name: "Light theme" }, { value: "dark", label: <MoonIcon />, name: "Dark theme" },
];

export function Layout() {
  return <DashboardProvider><Shell /></DashboardProvider>;
}

function Shell() {
  const { dashboard, reviews, error, notice } = useDashboard();
  const { pathname } = useLocation();
  const { preference, setPreference } = useTheme();
  const { collapsed, toggle: toggleSidebar } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  // Any navigation, including Back to a previously visited route, closes the menu.
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) { setMenuPath(pathname); setMenuOpen(false); }
  const toggle = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const visited = useRef(pathname);
  const wasOpen = useRef(false);
  const closeMenu = () => setMenuOpen(false);
  // Declared before the route effect so that, after navigation, the page heading wins focus over the Menu button.
  useEffect(() => {
    if (menuOpen) (nav.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav.current?.querySelector("a"))?.focus();
    // After the window widens the Menu button is hidden, so focus goes to the page instead.
    else if (wasOpen.current) (toggle.current?.checkVisibility?.() ?? true ? toggle.current : main.current)?.focus();
    wasOpen.current = menuOpen;
  }, [menuOpen]);
  useEffect(() => {
    if (visited.current === pathname) return;
    visited.current = pathname;
    main.current?.querySelector("h1")?.focus();
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    // The overlay only exists below the desktop breakpoint, so widening the window must not leave the page inert.
    const wide = window.matchMedia?.(WIDE);
    const onWide = (event: MediaQueryListEvent) => { if (event.matches) closeMenu(); };
    document.addEventListener("keydown", onKey);
    wide?.addEventListener("change", onWide);
    return () => { document.removeEventListener("keydown", onKey); wide?.removeEventListener("change", onWide); };
  }, [menuOpen]);
  const waiting = reviews.length;
  return <>
    <a className="qe-skip-link" href="#main-content" inert={menuOpen}>Skip to main content</a>
    <div className="qe-shell">
      <header className="qe-shell-header" inert={menuOpen}>
        <Button ref={toggle} className="qe-nav-toggle" size="compact" aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen(!menuOpen)}><MenuIcon /><span className="qe-nav-toggle-label">Menu</span></Button>
        <Link className="qe-brand" to="/">Job Search Intelligence</Link>
        <div className="qe-shell-actions">
          <p className="qe-freshness">{freshnessText(dashboard?.lastSuccessfulSyncAt)}</p>
          <SegmentedControl label="Theme" options={themes} value={preference} onChange={setPreference} iconOnly />
        </div>
      </header>
      {menuOpen && <button type="button" className="qe-scrim" aria-label="Close navigation" aria-hidden="true" tabIndex={-1} onClick={closeMenu} />}
      <nav id="primary-navigation" className="qe-sidebar" aria-label="Primary navigation" ref={nav} data-open={menuOpen}>
        <Button className="qe-sidebar-close" variant="quiet" size="compact" onClick={closeMenu}><CloseIcon />Close</Button>
        <ul className="qe-nav">{navItems.map((item) => <li key={item.to}>
          <NavLink className="qe-nav-link" to={item.to} end={item.end} title={collapsed ? item.label : undefined} onClick={closeMenu}>
            <item.Icon size="lg" /><span className="qe-nav-label">{item.label}</span>{" "}
            {item.to === "/review" && waiting > 0 && <span className="qe-nav-badge">{waiting >= REVIEW_CAP ? `${REVIEW_CAP}+` : waiting}<span className="qe-visually-hidden"> records waiting</span></span>}
          </NavLink>
        </li>)}</ul>
        <Button className="qe-sidebar-toggle" variant="quiet" iconOnly aria-expanded={!collapsed} aria-controls="primary-navigation" aria-label="Navigation panel" title={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={toggleSidebar}>
          {collapsed ? <PanelOpenIcon size="lg" /> : <PanelCloseIcon size="lg" />}
        </Button>
      </nav>
      <main id="main-content" className="qe-main" ref={main} tabIndex={-1} inert={menuOpen}>
        <div className="qe-container qe-stack" data-gap="section">
          {(error || notice) && <div className="qe-stack" data-gap="3">
            {error && <ErrorAlert message={error} />}
            {notice && <Alert tone="success">{notice}</Alert>}
          </div>}
          <Outlet />
        </div>
      </main>
      <footer className="qe-footer" inert={menuOpen}><p>Private owner workspace. Outlook and tracker connections are read-only.</p></footer>
    </div>
  </>;
}
