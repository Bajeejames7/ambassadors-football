import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Award, Bell, CalendarDays, HeartPulse, ShieldCheck, Wallet } from "lucide-react";
import { api, setToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useNotifications } from "../lib/queries";
import { dateTime12, PERMISSION_LABELS } from "../lib/format";
import { Empty, Modal, NameInput, Notice, PageTitle, SectionTitle, Spinner } from "../components/ui";

const ICON: Record<string, typeof Bell> = { injury: HeartPulse, payment: Wallet, schedule: CalendarDays, award: Award, approval: ShieldCheck, privileges: ShieldCheck };

export function NotificationsPage() {
  const q = useNotifications();
  const qc = useQueryClient();
  const nav = useNavigate();
  if (q.isLoading) return <Spinner />;
  const list = (q.data ?? []) as any[];
  const unread = list.filter((n) => !n.readAt);
  const open = async (n: any) => {
    if (!n.readAt) await api("/notifications/read", { method: "POST", body: { ids: [n.id] } }).catch(() => {});
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    if (n.link) nav(n.link);
  };
  return (
    <>
      <PageTitle title="Alerts" action={unread.length > 0 && (
        <button className="btn-ghost" onClick={async () => { await api("/notifications/read", { method: "POST", body: {} }); void qc.invalidateQueries({ queryKey: ["notifications"] }); }}>Mark all read</button>
      )} />
      {list.length === 0 ? <Empty>No alerts yet. Injuries, payments, schedule changes and awards show up here.</Empty> : (
        <ul className="grid gap-2">
          {list.map((n) => {
            const Icon = ICON[n.kind] ?? Bell;
            return (
              <li key={n.id}>
                <button onClick={() => open(n)} className={`sheet flex w-full items-start gap-3 text-left ${n.urgent && !n.readAt ? "ring-2 ring-bad" : ""} ${n.readAt ? "opacity-70" : ""}`}>
                  <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${n.kind === "injury" ? "text-bad" : "text-brand"}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className={`text-[15px] ${n.readAt ? "" : "font-bold"} text-navy`}>{n.title}</p>
                    {n.body && <p className="mt-0.5 whitespace-pre-line text-sm text-ink">{n.body}</p>}
                    <p className="mt-1 text-xs text-slate">{dateTime12(n.createdAt)}</p>
                  </div>
                  {!n.readAt && <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-brand" aria-label="Unread" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export function AccountPage() {
  const { me, signOut, refresh } = useAuth();
  const [name, setName] = useState(me!.name);
  const [phone, setPhone] = useState(me!.phone ?? "");
  const [pw, setPw] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string; where: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmPw, setConfirmPw] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const nav = useNavigate();

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/me", { method: "PATCH", body: { name, phone } }); await refresh(); setMsg({ tone: "good", text: "Saved.", where: "profile" }); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message, where: "profile" }); }
  };
  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    try { const r = await api<{ token: string }>("/me/password", { method: "POST", body: pw }); setToken(r.token); setPw({ current: "", next: "" }); await refresh(); setMsg({ tone: "good", text: "Password changed. Other devices are signed out.", where: "pw" }); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message, where: "pw" }); }
  };
  const deleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/me", { method: "DELETE", body: { password: confirmPw } }); await signOut(); nav("/login"); }
    catch (err) { setDeleteError((err as Error).message); }
  };
  const grants = me!.grants.filter((g) => g.permission !== "country.override" || me!.role !== "parent");
  return (
    <>
      <PageTitle title="Account" sub={`${me!.role === "super_admin" ? "Super Admin" : me!.role === "admin" ? "Admin" : me!.role === "coach" ? "Coach" : "Parent"} · ${me!.email}`} />
      <form onSubmit={saveProfile} className="sheet grid gap-3">
        <div><label className="label" htmlFor="an">Name</label><NameInput id="an" value={name} onChange={setName} required /></div>
        <div><label className="label" htmlFor="ap">Phone</label><input id="ap" className="field" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        {msg?.where === "profile" && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <button className="btn-primary justify-self-start">Save</button>
      </form>

      {me!.role !== "parent" && grants.length > 0 && (
        <>
          <SectionTitle>Your permissions</SectionTitle>
          <ul className="sheet grid gap-1 text-[15px]">
            {grants.map((g, k) => <li key={k}>{PERMISSION_LABELS[g.permission] ?? g.permission}{g.expiresAt ? ` (until ${new Date(g.expiresAt).toLocaleDateString("en-GB")})` : ""}</li>)}
          </ul>
        </>
      )}

      <SectionTitle>Password</SectionTitle>
      <form onSubmit={changePw} className="sheet grid gap-3">
        <div><label className="label" htmlFor="pc">Current password</label><input id="pc" type="password" className="field" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
        <div><label className="label" htmlFor="pn">New password</label><input id="pn" type="password" className="field" autoComplete="new-password" minLength={8} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
        {msg?.where === "pw" && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <button className="btn-ghost justify-self-start">Change password</button>
      </form>

      <div className="mt-6 grid gap-2">
        <button className="btn-ghost" onClick={async () => { await signOut(); nav("/login"); }}>Sign out</button>
        <Link to="/privacy" className="btn-ghost">Privacy policy</Link>
        <button className="btn-ghost text-bad" onClick={() => setDeleting(true)}>Delete my account</button>
      </div>

      <Modal open={deleting} onClose={() => setDeleting(false)} title="Delete your account?">
        <form onSubmit={deleteAccount} className="grid gap-3">
          <p className="flex gap-2 text-[15px]"><AlertTriangle className="h-5 w-5 shrink-0 text-bad" aria-hidden /> This removes your sign-in, profile{me!.role === "parent" ? ", links to your children" : ""} and alerts. It cannot be undone.</p>
          <p className="text-sm text-slate">Payment records stay with the organisation for its accounts, without your phone number.</p>
          <div><label className="label" htmlFor="dp">Enter your password to confirm</label><input id="dp" type="password" className="field" required value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} /></div>
          {deleteError && <Notice tone="bad">{deleteError}</Notice>}
          <button className="btn-danger">Delete my account</button>
        </form>
      </Modal>
    </>
  );
}

/** Shown when a Super Admin created the account with a temporary password. */
export function ChooseOwnPassword() {
  const { refresh, signOut } = useAuth();
  const [pw, setPw] = useState({ current: "", next: "" });
  const [error, setError] = useState("");
  return (
    <div className="mx-auto max-w-md px-5 py-12">
      <h1 className="display text-[2.4rem] text-navy">Choose your password</h1>
      <p className="mt-2 text-slate">You signed in with a temporary password. Choose your own to continue.</p>
      <form className="sheet mt-6 grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        try { const r = await api<{ token: string }>("/me/password", { method: "POST", body: pw }); setToken(r.token); await refresh(); }
        catch (err) { setError((err as Error).message); }
      }}>
        <div><label className="label" htmlFor="tc">Temporary password</label><input id="tc" type="password" className="field" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
        <div><label className="label" htmlFor="tn">New password</label><input id="tn" type="password" className="field" minLength={8} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary">Save and continue</button>
        <button type="button" className="btn-ghost" onClick={() => void signOut()}>Sign out</button>
      </form>
    </div>
  );
}
