import { BASE } from "./base";

/**
 * Two doors into one app:
 * - the staff app at /ambassadors/ (coaches, admins, Super Admin)
 * - the parent portal at /ambassadors/parents (parents only)
 * The router's basename follows the door, so every parent screen lives under /parents.
 *
 * "View as Parent": Creator Control gets a 30-minute read-only token for one
 * parent, hands it to a new tab through localStorage (never in the URL), and that
 * tab keeps it in sessionStorage, so the Super Admin's own sign-in is untouched.
 */

export const PORTAL_PATH = `${BASE}parents`;
export const PORTAL_URL = `${location.origin}${PORTAL_PATH}`;
export const STAFF_PATH = BASE;

export const IN_PARENT_PORTAL = location.pathname === PORTAL_PATH || location.pathname.startsWith(`${PORTAL_PATH}/`);
export const ROUTER_BASE = IN_PARENT_PORTAL ? PORTAL_PATH : BASE.replace(/\/$/, "");

const PENDING = "af.preview.pending";
const KEY = "af.preview";
const ME_KEY = "af.preview.me";

/** Called once at start-up in the portal tab. */
export function takePreviewHandoff(): void {
  if (!IN_PARENT_PORTAL) return;
  try {
    const token = localStorage.getItem(PENDING);
    if (token) {
      sessionStorage.setItem(KEY, token);
      sessionStorage.removeItem(ME_KEY);
      localStorage.removeItem(PENDING);
    }
  } catch { /* private mode */ }
}

export function previewToken(): string | null {
  if (!IN_PARENT_PORTAL) return null;
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

export const inPreview = () => previewToken() !== null;

export function getPreviewMe<T>(): T | null {
  try { return JSON.parse(sessionStorage.getItem(ME_KEY) ?? "null"); } catch { return null; }
}

export function setPreviewMe(me: unknown): void {
  try {
    if (me) sessionStorage.setItem(ME_KEY, JSON.stringify(me));
    else sessionStorage.removeItem(ME_KEY);
  } catch { /* ignore */ }
}

export function endPreview(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(ME_KEY);
  } catch { /* ignore */ }
  window.close();
  // If the browser keeps the tab open, go back to the staff app.
  setTimeout(() => location.replace(STAFF_PATH), 150);
}

/** From Creator Control: open this parent's portal in a new tab. */
export function openPreview(token: string): void {
  try { localStorage.setItem(PENDING, token); } catch { /* ignore */ }
  window.open(`${PORTAL_PATH}/`, "_blank", "noopener");
}

/** Use the parent's app icon and start page when installed from the portal. */
export function usePortalManifest(): void {
  if (!IN_PARENT_PORTAL) return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = `${BASE}manifest-parents.webmanifest`;
}
