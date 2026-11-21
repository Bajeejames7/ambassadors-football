import { useSyncExternalStore } from "react";
import { ApiError, api, onConnection } from "./api";
import { db, idbGet, idbSet } from "./idb";

/**
 * Field Mode: working on the pitch with no signal.
 *
 * - Reads: `cached(path)` fetches from the server and keeps a copy in
 *   IndexedDB; with no connection it returns the copy (rosters, sessions,
 *   the child dashboard).
 * - Writes: `enqueue(op)` puts a change in the outbox. Each op has its own id,
 *   which the server uses so a re-sent op counts once. The outbox is sent to
 *   /api/sync as soon as there is a connection: from the app (online event,
 *   every 20 s, when the app comes to the front) or from the service worker's
 *   Background Sync when the app is closed.
 */

export type OpType = "attendance" | "walk_in" | "tally" | "equipment" | "mentorship" | "injury" | "availability" | "session_report";

export interface Op {
  id: string;
  type: OpType;
  payload: any;
  /** Shown in the "Pending sync" list. */
  label: string;
  createdAt: number;
  error?: string;
}

// ---- a tiny store the screens subscribe to ----------------------------------------------

let state = { online: typeof navigator === "undefined" ? true : navigator.onLine, pending: [] as Op[], failed: [] as Op[], syncing: false, lastSync: 0 };
const listeners = new Set<() => void>();
function set(next: Partial<typeof state>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useOffline() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
  );
}

async function reload() {
  const d = await db();
  const pending = ((await d.getAll("outbox")) as Op[]).sort((a, b) => a.createdAt - b.createdAt);
  const failed = ((await d.getAll("failed")) as Op[]).sort((a, b) => b.createdAt - a.createdAt);
  set({ pending, failed });
}

const afterSync = new Set<() => void>();
/** Screens reload server data after a sync. */
export function onSynced(fn: () => void) {
  afterSync.add(fn);
  return () => afterSync.delete(fn);
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Queue a change. Returns its id (also the server-side clientId). */
export async function enqueue(type: OpType, payload: unknown, label: string): Promise<string> {
  const op: Op = { id: newId(), type, payload, label, createdAt: Date.now() };
  await (await db()).put("outbox", op);
  await reload();
  // Ask the browser to wake the service worker when the connection is back.
  try {
    const reg = await navigator.serviceWorker?.ready;
    await (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } })?.sync?.register("ambassadors-sync");
  } catch { /* Background Sync not supported (iOS): the app flushes itself */ }
  void flush();
  return op.id;
}

let flushing: Promise<void> | null = null;

export function flush(): Promise<void> {
  flushing ??= (async () => {
    try {
      const d = await db();
      const ops = ((await d.getAll("outbox")) as Op[]).sort((a, b) => a.createdAt - b.createdAt);
      if (ops.length === 0) return;
      set({ syncing: true });
      for (let k = 0; k < ops.length; k += 50) {
        const batch = ops.slice(k, k + 50);
        const { results } = await api<{ results: { id: string; ok: boolean; status?: number; error?: string }[] }>("/sync", {
          method: "POST",
          body: { ops: batch.map((o) => ({ id: o.id, type: o.type, payload: o.payload })) },
        });
        const tx = d.transaction(["outbox", "failed"], "readwrite");
        for (const r of results) {
          const op = batch.find((o) => o.id === r.id);
          if (r.ok) await tx.objectStore("outbox").delete(r.id);
          else if (r.status && r.status < 500) {
            // Refused for good (no permission, removed session…): show it, never block the rest.
            await tx.objectStore("outbox").delete(r.id);
            if (op) await tx.objectStore("failed").put({ ...op, error: r.error });
          }
        }
        await tx.done;
      }
      set({ lastSync: Date.now() });
      afterSync.forEach((fn) => fn());
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 0)) console.warn("sync", err);
    } finally {
      set({ syncing: false });
      await reload();
      flushing = null;
    }
  })();
  return flushing;
}

export async function dismissFailed(id?: string) {
  const d = await db();
  if (id) await d.delete("failed", id);
  else await d.clear("failed");
  await reload();
}

export async function clearOfflineData() {
  const d = await db();
  await Promise.all(["outbox", "failed", "cache", "meta"].map((s) => d.clear(s)));
  await reload();
}

/** GET with an offline fallback to the last saved copy. */
export async function cached<T>(path: string): Promise<T & { __offline?: number }> {
  try {
    const data = await api<T>(path);
    void idbSet("cache", path, { data, savedAt: Date.now() });
    return data as T & { __offline?: number };
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      const saved = await idbGet<{ data: T; savedAt: number }>("cache", path);
      if (saved) {
        const data = saved.data as T & { __offline?: number };
        if (data && typeof data === "object" && !Array.isArray(data)) return { ...data, __offline: saved.savedAt };
        return data;
      }
    }
    throw err;
  }
}

if (typeof window !== "undefined") {
  void reload();
  onConnection((online) => {
    if (online !== state.online) set({ online });
    if (online && state.pending.length) void flush();
  });
  window.addEventListener("online", () => { set({ online: true }); void flush(); });
  window.addEventListener("offline", () => set({ online: false }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void flush(); });
  setInterval(() => { if (state.pending.length) void flush(); }, 20_000);
  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data?.type === "synced") { void reload(); afterSync.forEach((fn) => fn()); }
  });
}
