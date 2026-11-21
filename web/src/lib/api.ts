import { idbSet } from "./idb";
import { BASE } from "./base";
import { getPreviewMe, previewToken, setPreviewMe } from "./portal";

// Talking to the server. The sign-in token is kept in localStorage (so a coach
// stays signed in) and mirrored into IndexedDB so the service worker can sync
// the offline queue while the app is closed.

const TOKEN_KEY = "af.token";
const ME_KEY = "af.me";

export function getToken(): string | null {
  const preview = previewToken();
  if (preview) return preview;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string | null): void {
  if (previewToken()) return; // a preview tab never touches the real sign-in
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
  void idbSet("meta", "token", token ?? undefined);
}

export function getStoredMe<T>(): T | null {
  if (previewToken()) return getPreviewMe<T>();
  try { return JSON.parse(localStorage.getItem(ME_KEY) ?? "null"); } catch { return null; }
}

export function setStoredMe(me: unknown): void {
  if (previewToken()) { setPreviewMe(me); return; }
  try {
    if (me) localStorage.setItem(ME_KEY, JSON.stringify(me));
    else localStorage.removeItem(ME_KEY);
  } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

type Listener = (online: boolean) => void;
const connectionListeners = new Set<Listener>();
export function onConnection(fn: Listener) {
  connectionListeners.add(fn);
  return () => connectionListeners.delete(fn);
}

let signedOut: () => void = () => {};
export function onSignedOut(fn: () => void) {
  signedOut = fn;
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}api${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    connectionListeners.forEach((l) => l(false));
    throw new ApiError(0, "No connection. Your change is saved on this phone if it can be.", null);
  }
  connectionListeners.forEach((l) => l(true));
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith("/auth/")) signedOut();
    throw new ApiError(res.status, body?.error ?? "Something went wrong. Try again.", body);
  }
  return body as T;
}

/** Downloads a file (the PDF report) with the sign-in token. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(`${BASE}api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? "Could not create the file", body);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
