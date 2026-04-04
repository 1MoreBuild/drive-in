// Simple pushState router

let onNavigate = null;

export function initRouter(handler) {
  onNavigate = handler;
  window.addEventListener("popstate", () => {
    onNavigate(parseRoute());
  });
}

export function parseRoute() {
  const path = location.pathname;
  const showMatch = path.match(/^\/show\/(\d+)$/);
  if (showMatch) return { view: "show", ratingKey: showMatch[1] };
  if (path === "/play") return { view: "player" };
  return { view: "browse" };
}

export function navigate(path, replace = false) {
  if (location.pathname === path) return;
  if (replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  if (onNavigate) onNavigate(parseRoute());
}
