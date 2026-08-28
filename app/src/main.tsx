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
  const onLaunch = useRouterState({
    select: (state) => state.location.pathname === "/launch",
  });
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="wordmark">
          ONCHAIN<em>BURNER</em>
        </span>
        <nav>
          <Link
            to="/"
            activeOptions={{ exact: true }}
            activeProps={{ className: "active" }}
          >
            Overview
          </Link>
          <Link to="/launch" activeProps={{ className: "active" }}>
            Launch
          </Link>
          <Link to="/existing" activeProps={{ className: "active" }}>
            Existing token
          </Link>
        </nav>
        <span className="spacer" />
        <WalletGate />
        <button
          className="iconbtn"
          title="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "light" : "dark"}
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
