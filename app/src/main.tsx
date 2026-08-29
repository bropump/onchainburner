import "./polyfills";
import "./reown";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import "./styles.css";
import { AppProvider } from "./state/AppContext";
import { HomePage } from "./pages/home";
import { LaunchPage } from "./pages/launch";
import { ExistingPage } from "./pages/existing";
import { VaultPage, VaultSearch } from "./pages/vault";
import { WalletGate } from "./pages/walletGate";
import { PROGRAM } from "./chain/constants";
import {
  CommunityLaunchPage,
  CommunityVaultDetailPage,
  CommunityVaultsPage,
} from "./pages/communityVaults";

const THEME_KEY = "onchainburner.theme";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function initialTheme(): "light" | "dark" {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function Shell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const onLaunch = pathname === "/launch";
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  return (
    <div className="shell">
      <header className={`topbar${menuOpen ? " menu-open" : ""}`}>
        <Link to="/" className="brand" aria-label="Cooked home">
          <img src="/cooked-flame.png" alt="" />
          <span>Cooked</span>
        </Link>
        <nav id="primary-navigation" aria-label="Primary navigation">
          <Link to="/launch" activeProps={{ className: "active" }}>
            Launch
          </Link>
          <Link to="/existing" activeProps={{ className: "active" }}>
            Create vault
          </Link>
          <Link to="/community" activeProps={{ className: "active" }}>
            Community
          </Link>
        </nav>
        <span className="spacer" />
        <div className="topbar-wallet">
          <WalletGate />
        </div>
        <button
          className="header-iconbtn theme-toggle"
          aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Use ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <span aria-hidden="true">{theme === "dark" ? "☀" : "◐"}</span>
          <span className="theme-label">
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </span>
        </button>
        <button
          className="header-iconbtn menu-toggle"
          type="button"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="menu-lines" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </button>
      </header>
      <Outlet />
      {!onLaunch && (
        <footer className="footer">
          <span>
            program <code>{PROGRAM.toBase58()}</code>
          </span>
        </footer>
      )}
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <AppProvider>
      <Shell />
    </AppProvider>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const launchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/launch",
  component: LaunchPage,
});

const existingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/existing",
  component: ExistingPage,
});

const communityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/community",
  component: CommunityVaultsPage,
});

const communityLaunchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/community/launch/$mint",
  component: function CommunityLaunchRouteComponent() {
    const { mint } = communityLaunchRoute.useParams();
    return <CommunityLaunchPage mint={mint} />;
  },
});

const communityVaultRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/community/vault/$vault",
  component: function CommunityVaultRouteComponent() {
    const { vault } = communityVaultRoute.useParams();
    return <CommunityVaultDetailPage vault={vault} />;
  },
});

const vaultRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vault",
  validateSearch: (search: Record<string, unknown>): VaultSearch => ({
    launch: String(search.launch ?? ""),
    legs: String(search.legs ?? ""),
    label: search.label ? String(search.label) : undefined,
  }),
  component: function VaultRouteComponent() {
    const search = vaultRoute.useSearch();
    return <VaultPage search={search} />;
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    launchRoute,
    existingRoute,
    communityRoute,
    communityLaunchRoute,
    communityVaultRoute,
    vaultRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// HMR-safe root: an edit to a module with non-component exports (service,
// context) invalidates up to this entry and re-runs it. createRoot() on a
// container that already has a root crashes React's reconciler (removeChild
// NotFoundError) and remounts the app mid-flow, so the root is created once
// and reused. Production builds run this exactly once either way.
type RootHost = { __appRoot?: ReactDOM.Root };
const container = document.getElementById("root")! as HTMLElement & RootHost;
const root = (container.__appRoot ??= ReactDOM.createRoot(container));
root.render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
