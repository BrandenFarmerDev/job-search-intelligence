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
})();
