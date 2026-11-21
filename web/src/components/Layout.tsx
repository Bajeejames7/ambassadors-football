import { NavLink, Outlet, Link } from "react-router-dom";
import { Bell, CalendarDays, ClipboardCheck, ClipboardPen, CloudOff, Home, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { asset } from "../lib/base";
import { useAuth } from "../lib/auth";
import { useOffline } from "../lib/offline";
import { useNotifications } from "../lib/queries";
import { Parent3D } from "./Parent3D";
import { InstallApp } from "./InstallApp";
import { useLocation } from "react-router-dom";
import type { CSSProperties } from "react";
import { cssPhoto, photoForPath } from "../lib/photos";

function navFor(role: string, isSuper: boolean) {
  if (role === "parent") {
    return [
      { to: "/", label: "Home", icon: Home },
      { to: "/schedule", label: "Schedule", icon: CalendarDays },
      { to: "/register", label: "Register", icon: ClipboardPen },
      { to: "/notifications", label: "Alerts", icon: Bell },
      { to: "/account", label: "Account", icon: UserRound },
    ];
  }
  return [
    { to: "/", label: "Home", icon: Home },
    { to: "/field", label: "Field", icon: ClipboardCheck },
    isSuper ? { to: "/creator", label: "Creator", icon: ShieldCheck } : { to: "/schedule", label: "Schedule", icon: CalendarDays },
    { to: "/notifications", label: "Alerts", icon: Bell },
    { to: "/account", label: "Account", icon: UserRound },
  ];
}

export function Layout() {
  const { me } = useAuth();
  const location = useLocation();
  const notes = useNotifications();
  const unread = (notes.data ?? []).filter?.((n: { readAt: string | null }) => !n.readAt).length ?? 0;
  const items = navFor(me!.role, me!.isSuperAdmin);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col bg-navy p-5 text-white md:flex">
        <Link to="/" className="flex items-center gap-3">
          <img src={asset("logo.jpg")} alt="" className="h-11 w-11 rounded-lg" />
          <span className="display text-[1.35rem] leading-[0.9]">Ambassadors<br />Football</span>
        </Link>
        <nav className="mt-8 grid gap-1" aria-label="Main">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-semibold ${isActive ? "bg-white text-navy" : "text-white/80 hover:bg-white/10"}`}>
              <Icon className="h-5 w-5" aria-hidden /> {label}
              {label === "Alerts" && unread > 0 && <span className="ml-auto rounded-full bg-bad px-2 text-xs text-white">{unread}</span>}
            </NavLink>
          ))}
          {me!.isSuperAdmin && (
            <NavLink to="/schedule" className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-semibold ${isActive ? "bg-white text-navy" : "text-white/80 hover:bg-white/10"}`}>
              <CalendarDays className="h-5 w-5" aria-hidden /> Schedule
            </NavLink>
          )}
        </nav>
        <p className="mt-auto text-xs text-white/50">Football. Faith. Future.</p>
      </aside>

      <div className="min-w-0">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 bg-navy text-white md:hidden" style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <div className="flex h-14 items-center gap-3 px-4">
            <img src={asset("logo.jpg")} alt="Ambassadors Football" className="h-9 w-9 rounded-md" />
            <span className="display flex-1 text-lg">Ambassadors Football</span>
          </div>
          <SyncBar />
        </header>
        <div className="hidden md:block"><SyncBar /></div>
        <main className="mx-auto max-w-3xl px-4 pb-32 pt-6 md:pb-12" style={{ "--photo": cssPhoto(photoForPath(location.pathname, me!.role)) } as CSSProperties}>
          {location.pathname === "/" && <InstallApp variant="banner" />}
          {me!.role === "parent" ? <Parent3D><Outlet /></Parent3D> : <Outlet />}
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="grid grid-cols-5">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${isActive ? "text-navy" : "text-slate"}`}>
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute top-0 h-[3px] w-8 rounded-b bg-brand" aria-hidden />}
                  <Icon className="h-[22px] w-[22px]" aria-hidden />
                  {label}
                  {label === "Alerts" && unread > 0 && <span className="absolute right-[22%] top-1 h-2.5 w-2.5 rounded-full bg-bad" aria-label={`${unread} unread`} />}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** Offline / pending-sync strip under the top bar. */
function SyncBar() {
  const { online, pending, syncing, failed } = useOffline();
  if (online && pending.length === 0 && failed.length === 0) return null;
  const n = pending.length;
  const changes = n === 1 ? "1 change" : `${n} changes`;
  return (
    <Link to="/field/queue" role="status" className={`flex items-center justify-center gap-2 px-4 py-1.5 text-[13px] font-semibold ${online ? (failed.length && !n ? "bg-bad text-white" : "bg-brand text-white") : "bg-warn text-navy"}`}>
      {online ? <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden /> : <CloudOff className="h-3.5 w-3.5" aria-hidden />}
      {!online
        ? `Field mode: offline${n ? ` · ${changes} saved on this phone` : ""}`
        : n
          ? `Syncing ${changes}…`
          : `${failed.length} change${failed.length === 1 ? "" : "s"} could not be saved. Tap to see.`}
    </Link>
  );
}
