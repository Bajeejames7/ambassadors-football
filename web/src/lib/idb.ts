import { openDB, type IDBPDatabase } from "idb";

/**
 * IndexedDB "ambassadors":
 *   outbox — changes made offline, waiting to sync (keyPath id)
 *   failed — changes the server refused for good, shown to the coach
 *   cache  — the last copy of rosters, sessions and dashboards
 *   meta   — the sign-in token (read by the service worker)
 * The service worker opens the same database (web/sw-template.js).
 */
let dbPromise: Promise<IDBPDatabase> | null = null;

export function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB("ambassadors", 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "id" });
      if (!d.objectStoreNames.contains("failed")) d.createObjectStore("failed", { keyPath: "id" });
      if (!d.objectStoreNames.contains("cache")) d.createObjectStore("cache");
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    },
  });
  return dbPromise;
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  try { return (await db()).get(store, key); } catch { return undefined; }
}

export async function idbSet(store: string, key: string, value: unknown): Promise<void> {
  try {
    const d = await db();
    if (value === undefined) await d.delete(store, key);
    else await d.put(store, value, key);
  } catch { /* storage blocked */ }
}
