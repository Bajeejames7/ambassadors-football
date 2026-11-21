import { useEffect, useState } from "react";

/**
 * Installing the PWA. Chrome/Edge/Samsung on Android (and desktop Chrome) fire
 * `beforeinstallprompt` once the app qualifies; we keep that event so a button
 * can show the browser's own install dialog later. iPhones have no such event:
 * people install from Safari's Share menu, so we show the steps instead.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Call once, before React renders, so the event is never missed. */
export function captureInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own button instead of the mini-infobar
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

export type Platform = "android" | "ios" | "desktop";

function detect() {
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  // Built-in browsers inside other apps can't install web apps.
  const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|; wv\)/i.test(ua);
  const iosNotSafari = ios && /CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return { platform: (ios ? "ios" : android ? "android" : "desktop") as Platform, standalone, inApp, iosNotSafari };
}

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    const mq = window.matchMedia("(display-mode: standalone)");
    mq.addEventListener?.("change", l);
    return () => {
      listeners.delete(l);
      mq.removeEventListener?.("change", l);
    };
  }, []);
  const d = detect();
  return {
    ...d,
    installed: installed || d.standalone,
    canPrompt: !!deferred,
    async prompt(): Promise<boolean> {
      if (!deferred) return false;
      const e = deferred;
      deferred = null;
      await e.prompt();
      const { outcome } = await e.userChoice;
      emit();
      return outcome === "accepted";
    },
  };
}

const DISMISS_KEY = "af.installDismissedAt";

export function wasDismissedRecently(days = 14): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < days * 86_400_000;
  } catch {
    return false;
  }
}

export function dismissInstall(): void {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
}
