(function () {
  var theme = "system";
  try {
    var stored = localStorage.getItem("qe-theme");
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {
    // Storage can be blocked; fall back to the system preference.
  }
  if (theme === "system") theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  // Keep in sync with src/lib/sidebar.ts: restore the collapsed navigation rail before first paint.
  var sidebar = "expanded";
  try {
    if (localStorage.getItem("qe-sidebar") === "collapsed") sidebar = "collapsed";
  } catch {
    // Storage can be blocked; the navigation starts expanded.
  }
  document.documentElement.dataset.sidebar = sidebar;
})();
