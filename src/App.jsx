import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useOutlet } from "react-router-dom";
import { api, jsonRequest } from "./api.js";
import { AuthContext, useAuth } from "./auth.js";
import { DevicesProvider, useDevices } from "./DevicesContext.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import IncidentsPage from "./pages/IncidentsPage.jsx";
import DevicesPage from "./pages/DevicesPage.jsx";
import LiveFeedPage from "./pages/LiveFeedPage.jsx";
import UsersPage from "./pages/UsersPage.jsx";
import { LoadingMark, MotionButton, MotionNavLink } from "./motion.jsx";

function Protected({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="loading-screen"><LoadingMark />Checking your session…</main>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children ?? <Outlet />;
}

function PermissionRoute({ permission, children }) {
  const { user } = useAuth();
  if (!user?.permissions?.[permission]) return <Navigate to="/overview" replace />;
  return children;
}

function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const outlet = useOutlet();
  const navRef = useRef(null);
  const [indicator, setIndicator] = useState({ x: 0, width: 0 });
  const navItems = [
    ["/overview", "Overview"],
    ["/live-feed", "Live Feed"],
    ["/incidents", "Incidents"],
    ["/devices", "Devices"],
    ...(user.permissions.manageUsers ? [["/users", "Users"]] : [])
  ];
  const devices = useDevices();
  const { stream } = devices;
  const prefersReducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const placeIndicator = () => {
      const activeLink = nav.querySelector(".nav-link.is-active");
      if (!activeLink) return;
      setIndicator({ x: activeLink.offsetLeft, width: activeLink.offsetWidth });
    };
    placeIndicator();
    const observer = new ResizeObserver(placeIndicator);
    observer.observe(nav);
    nav.querySelectorAll(".nav-link").forEach((link) => observer.observe(link));
    return () => observer.disconnect();
  }, [location.pathname, navItems.length]);

  return (
    <div className="app-frame">
      <motion.header className="topbar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: "easeOut" }}>
        <MotionNavLink className="brand" to="/overview" aria-label="Site safety overview">
          <span className="brand-copy"><strong>Site safety</strong><small>Operations console</small></span>
        </MotionNavLink>
        <nav className="primary-nav" aria-label="Main navigation" ref={navRef}>
          {navItems.map(([to, label]) => <MotionNavLink key={to} to={to} end className={({ isActive }) => `nav-link${isActive ? " is-active" : ""}`}>{label}</MotionNavLink>)}
          <motion.span className="nav-indicator" aria-hidden="true" animate={{ x: indicator.x, scaleX: indicator.width }} transition={{ type: "tween", duration: 0.22, ease: "easeOut" }} />
        </nav>
        <div className="account-area">
          <span className={"status-indicator" + (stream ? " status-indicator--live" : "")}><i /> {stream ? "Camera active" : "Local devices"}</span>
          <ThemeToggle />
          <span className="account-divider" />
          <span className="account-name"><strong>{user.displayName}</strong><small>{user.role}</small></span>
          <MotionButton className="icon-button signout-button" type="button" onClick={async () => { devices.stopCamera(); await devices.disconnectSensor(); await logout(); navigate("/login", { replace: true }); }} aria-label="Sign out" title="Sign out"><SignOutIcon /></MotionButton>
        </div>
      </motion.header>
      <main className="page-wrap" id="main">{outlet && <motion.div key={location.pathname} className="route-transition" initial={{ opacity: 0.94 }} animate={{ opacity: 1 }} transition={{ duration: prefersReducedMotion ? 0 : 0.14, ease: "easeOut" }}>{outlet}</motion.div>}</main>
      <footer className="app-footer"><span>Site safety console</span><span className="app-footer__credit">Made By Sreesanth &lt;3</span><span>Local device access <i /> Human review required for every alert</span></footer>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem("safety.theme") || "dark");
  const prefersReducedMotion = useReducedMotion();
  const previousTheme = useRef(theme);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const changed = previousTheme.current !== theme;
    if (changed) root.classList.add("theme-transitioning");
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    localStorage.setItem("safety.theme", theme);
    if (!changed) return undefined;
    previousTheme.current = theme;
    const timer = window.setTimeout(() => root.classList.remove("theme-transitioning"), prefersReducedMotion ? 0 : 300);
    return () => {
      window.clearTimeout(timer);
      root.classList.remove("theme-transitioning");
    };
  }, [prefersReducedMotion, theme]);
  const next = theme === "dark" ? "light" : "dark";
  return <MotionButton className="theme-toggle" type="button" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
    <span className="theme-toggle__orbit" aria-hidden="true"><AnimatePresence initial={false}>
      <motion.svg key={theme} className={`theme-icon theme-icon--${theme === "dark" ? "moon" : "sun"}`} viewBox="0 0 24 24" initial={{ opacity: 0, rotate: -24 }} animate={{ opacity: 1, rotate: 0 }} exit={{ opacity: 0, rotate: 24 }} transition={{ duration: prefersReducedMotion ? 0 : 0.16, ease: "easeOut" }}>
        {theme === "dark" ? <path d="M20.4 15.3A8.4 8.4 0 0 1 8.7 3.6 8.5 8.5 0 1 0 20.4 15.3Z" /> : <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>}
      </motion.svg>
    </AnimatePresence></span><span className="theme-toggle__label">{theme === "dark" ? "Dark" : "Light"}</span>
  </MotionButton>;
}

function SignOutIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3H4.7A1.7 1.7 0 0 0 3 4.7v10.6A1.7 1.7 0 0 0 4.7 17H8M11.5 6.5 15 10l-3.5 3.5M15 10H7" /></svg>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const location = useLocation();

  const refreshSession = useCallback(async () => {
    try {
      const session = await api("/api/session");
      setUser(session.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshSession(); }, [refreshSession]);
  useEffect(() => {
    const expire = () => { setUser(null); setLoading(false); };
    window.addEventListener("safety:session-expired", expire);
    return () => window.removeEventListener("safety:session-expired", expire);
  }, []);

  const login = async (credentials) => {
    const result = await api("/api/auth/login", jsonRequest("POST", credentials));
    setUser(result.user);
    return result.user;
  };
  const logout = async () => {
    try { await api("/api/auth/logout", jsonRequest("POST", {})); } finally { setUser(null); }
  };

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshSession }}>
      <DevicesProvider><Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Protected />}>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="overview" element={<OverviewPage />} />
            <Route path="live-feed" element={<LiveFeedPage />} />
            <Route path="incidents" element={<IncidentsPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="users" element={<PermissionRoute permission="manageUsers"><UsersPage /></PermissionRoute>} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to={user ? "/overview" : "/login"} replace />} />
      </Routes></DevicesProvider>
    </AuthContext.Provider>
  );
}
