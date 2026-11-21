import { useState } from "react";
import { Download, MoreVertical, Share, SquarePlus, X } from "lucide-react";
import { asset } from "../lib/base";
import { dismissInstall, useInstall, wasDismissedRecently } from "../lib/install";

/**
 * "Install the app" in three places:
 * - variant="card": full explanation (Account page, sign-in screen)
 * - variant="banner": a slim, dismissible strip on the home screen
 * Hidden once the app is installed (opened from the home-screen icon).
 */
export function InstallApp({ variant = "card" }: { variant?: "card" | "banner" }) {
  const install = useInstall();
  const [hidden, setHidden] = useState(() => variant === "banner" && wasDismissedRecently());
  const [done, setDone] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  if (install.installed || hidden) return null;
  // Desktop without a native prompt: nothing useful to say in a banner.
  if (variant === "banner" && install.platform === "desktop" && !install.canPrompt) return null;

  const onInstall = async () => {
    if (install.canPrompt) {
      const ok = await install.prompt();
      if (ok) setDone(true);
    } else {
      setShowSteps(true);
    }
  };

  if (done) {
    return <p role="status" className="sheet text-[15px] font-semibold text-good">Installed. Open Ambassadors Football from your home screen.</p>;
  }

  const steps = <Steps install={install} />;

  if (variant === "banner") {
    return (
      <div className="mb-5 rounded-[22px] bg-navy p-3 pr-2 text-white">
        <div className="flex items-center gap-3">
          <img src={asset("icon-192.png")} alt="" className="h-11 w-11 rounded-xl" />
          <div className="min-w-0 flex-1">
            <p className="font-bold leading-tight">Install the app</p>
            <p className="text-sm text-white/75">Opens from your home screen and works without signal.</p>
          </div>
          {install.platform !== "ios" && !install.inApp && (
            <button onClick={onInstall} className="btn min-h-10 bg-white px-4 text-navy">Install</button>
          )}
          {(install.platform === "ios" || install.inApp) && (
            <button onClick={() => setShowSteps((s) => !s)} className="btn min-h-10 bg-white px-4 text-navy">How</button>
          )}
          <button aria-label="Not now" onClick={() => { dismissInstall(); setHidden(true); }} className="rounded-full p-2 text-white/70 hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>
        {showSteps && <div className="mt-3 rounded-2xl bg-white p-3 text-ink">{steps}</div>}
      </div>
    );
  }

  return (
    <div className="sheet">
      <div className="flex items-center gap-3">
        <img src={asset("icon-192.png")} alt="" className="h-12 w-12 rounded-xl" />
        <div className="flex-1">
          <p className="font-bold text-navy">Install Ambassadors Football</p>
          <p className="text-sm text-slate">Get an app icon on your phone. It opens full screen and works on the pitch without signal.</p>
        </div>
      </div>
      {install.platform !== "ios" && !install.inApp && (
        <button onClick={onInstall} className="btn-primary mt-4 w-full"><Download className="h-4 w-4" /> Install app</button>
      )}
      {(install.platform === "ios" || install.inApp || showSteps) && <div className="mt-4">{steps}</div>}
    </div>
  );
}

function Steps({ install }: { install: ReturnType<typeof useInstall> }) {
  if (install.inApp) {
    return (
      <ol className="grid gap-2 text-[15px]">
        <li>This page is open inside another app (like WhatsApp), which can't install apps.</li>
        <li className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-page"><MoreVertical className="h-4 w-4" /></span>
          <span>Tap the menu, then <strong>Open in {install.platform === "ios" ? "Safari" : "Chrome"}</strong>.</span>
        </li>
        <li>Then tap <strong>Install app</strong> there.</li>
      </ol>
    );
  }
  if (install.platform === "ios") {
    if (install.iosNotSafari) {
      return <p className="text-[15px]">On iPhone, apps install from <strong>Safari</strong>. Open this page in Safari, then tap <strong>Share</strong> and <strong>Add to Home Screen</strong>.</p>;
    }
    return (
      <ol className="grid gap-2 text-[15px]">
        <li className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-page text-brand"><Share className="h-4 w-4" /></span>
          <span>Tap <strong>Share</strong> at the bottom of Safari.</span>
        </li>
        <li className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-page"><SquarePlus className="h-4 w-4" /></span>
          <span>Scroll down and tap <strong>Add to Home Screen</strong>.</span>
        </li>
        <li>Tap <strong>Add</strong>. The app appears on your home screen.</li>
      </ol>
    );
  }
  // Android/desktop when the browser hasn't offered its install prompt.
  return (
    <ol className="grid gap-2 text-[15px]">
      <li className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-page"><MoreVertical className="h-4 w-4" /></span>
        <span>Tap the <strong>⋮</strong> menu in Chrome (top right).</span>
      </li>
      <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
      <li>Tap <strong>Install</strong>. The app appears on your home screen.</li>
    </ol>
  );
}
