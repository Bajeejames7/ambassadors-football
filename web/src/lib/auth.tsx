import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getStoredMe, getToken, onSignedOut, setStoredMe, setToken } from "./api";
import { clearOfflineData } from "./offline";
import { endPreview, inPreview } from "./portal";

export type Role = "super_admin" | "admin" | "coach" | "parent";

export type Restriction =
  | "intramurals.edit" | "payments.view" | "coaches.manage" | "parents.manage" | "players.register"
  | "attendance.take" | "reports.generate" | "equipment.check" | "analytics.view" | "parents.preview";

/** Admins have every power unless the Super Admin switched it off (Privilege Control). */
export const allowed = (me: Me | null, r: Restriction) => !!me && me.isSuperAdmin && !(me.restrictions ?? []).includes(r);

export interface Me {
  id: number;
  email: string;
  phone: string | null;
  name: string;
  role: Role;
  status: "pending" | "active" | "suspended";
  countryId: number | null;
  mustChangePassword: boolean;
  isSuperAdmin: boolean;
  /** The real Super Admin (not an Admin with equal powers). */
  isRealSuperAdmin: boolean;
  /** Powers a Super Admin has switched off for this Admin. */
  restrictions: Restriction[];
  /** Set while a Super Admin previews this parent's portal. */
  previewBy?: number;
  intramurals: number[];
  grants: { permission: string; intramuralId: number | null; expiresAt: string | null }[];
  children: number[];
  childIntramurals: number[];
}

interface AuthState {
  me: Me | null;
  signIn: (token: string, me: Me) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Opens with the saved profile so the app works offline straight away.
  const [me, setMe] = useState<Me | null>(() => (getToken() ? getStoredMe<Me>() : null));

  const signIn = useCallback((token: string, next: Me) => {
    setToken(token);
    setStoredMe(next);
    setMe(next);
  }, []);

  const signOut = useCallback(async () => {
    if (inPreview()) { endPreview(); return; }
    setToken(null);
    setStoredMe(null);
    await clearOfflineData();
    setMe(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try {
      const fresh = await api<Me>("/me");
      setStoredMe(fresh);
      setMe(fresh);
    } catch { /* offline: keep the saved profile */ }
  }, []);

  useEffect(() => {
    onSignedOut(() => void signOut());
    void refresh();
    // The token also lives in IndexedDB for the service worker (setToken skips preview tabs).
    if (getToken()) setToken(getToken());
  }, [refresh, signOut]);

  return <Ctx.Provider value={{ me, signIn, signOut, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export const isStaff = (me: Me | null) => !!me && me.role !== "parent";
