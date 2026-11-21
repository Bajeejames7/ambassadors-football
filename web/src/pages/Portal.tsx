import { useEffect, useState } from "react";
import { ClipboardPen, Eye, LogOut } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { endPreview, inPreview, STAFF_PATH } from "../lib/portal";
import { asset } from "../lib/base";

interface Registration { url: string; programs: { id: number; name: string; formUrl: string }[] }

let cache: Registration | null = null;

/** The Super Admin's "Register a Child" link (public, so it works before sign-in). */
export function useRegistration(): Registration | null {
  const [data, setData] = useState<Registration | null>(cache);
  useEffect(() => {
    if (cache) return;
    api<Registration>("/registration").then((r) => { cache = r; setData(r); }).catch(() => {});
  }, []);
  return data;
}

/** The big "Register a Child" button: opens the registration form the Super Admin pasted. */
export function RegisterChildButton({ className = "" }: { className?: string }) {
  const reg = useRegistration();
  const url = reg?.url || reg?.programs[0]?.formUrl;
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className={`btn h-12 w-full bg-[#f2c14e] text-[15px] text-navy shadow-[0_6px_0_#c99a26] hover:brightness-105 ${className}`}>
      <ClipboardPen className="h-5 w-5" aria-hidden /> Register a Child
    </a>
  );
}

/** Shown along the top while a Super Admin is looking at a parent's portal. */
export function PreviewBanner() {
  const { me } = useAuth();
  if (!inPreview() || !me) return null;
  return (
    <div role="status" className="sticky top-0 z-40 flex items-center justify-between gap-3 bg-[#f2c14e] px-4 py-2.5 text-sm font-semibold text-navy">
      <span className="flex min-w-0 items-center gap-2">
        <Eye className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">Viewing as {me.name}. Read-only: nothing you tap here changes anything.</span>
      </span>
      <button className="shrink-0 rounded-full bg-navy px-3 py-1.5 text-white" onClick={endPreview}>Exit preview</button>
    </div>
  );
}

/** A coach or admin who opened the parent portal while signed in. */
export function WrongDoor() {
  const { me, signOut } = useAuth();
  return (
    <div className="photo-navy grid min-h-screen place-items-center px-5 text-white">
      <div className="w-full max-w-sm rounded-[26px] bg-white p-6 text-ink">
        <img src={asset("logo.jpg")} alt="" className="h-12 w-12 rounded-lg" />
        <h1 className="condensed mt-4 text-2xl text-navy">This is the parent portal</h1>
        <p className="mt-2 text-[15px] text-slate">
          You're signed in as {me?.name}, a staff account. Staff use the main app. To see what a parent sees, open
          Creator Control, then Parents, and choose View as parent.
        </p>
        <a href={STAFF_PATH} className="btn-primary mt-5 h-12 w-full">Go to the staff app</a>
        <button className="btn-ghost mt-2 h-11 w-full" onClick={() => void signOut()}>
          <LogOut className="h-4 w-4" aria-hidden /> Sign out and sign in as a parent
        </button>
      </div>
    </div>
  );
}
