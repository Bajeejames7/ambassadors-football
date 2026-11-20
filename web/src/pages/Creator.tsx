import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, Search, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime12, money, PERMISSION_LABELS, WEEKDAYS } from "../lib/format";
import { Empty, ErrorNote, Modal, NameInput, Notice, PageTitle, Spinner, Tabs } from "../components/ui";

const ADMIN_PERMS = ["schedules.edit", "players.register", "roles.assign", "airtable.manage", "parents.approve", "attendance.take", "equipment.check", "payments.manage", "reports.generate", "privileges.grant"];
const ROLE_LABEL: Record<string, string> = { super_admin: "Super Admin", admin: "Admin", coach: "Coach", parent: "Parent" };

/** Creator Control: Super Admins only (the server refuses everyone else). */
export function CreatorControl() {
  const { me } = useAuth();
  const [tab, setTab] = useState<"people" | "impact" | "places" | "audit">("people");
  if (!me?.isSuperAdmin) return <ErrorNote error={new Error("Creator Control is only for Super Admins.")} />;
  return (
    <>
      <PageTitle title="Creator Control" sub="People, permissions and countries across Ambassadors Football." />
      <Tabs tabs={[{ id: "people", label: "People & permissions" }, { id: "impact", label: "International impact" }, { id: "places", label: "Countries & schools" }, { id: "audit", label: "Activity log" }]} value={tab} onChange={setTab} />
      {tab === "people" && <People />}
      {tab === "impact" && <Impact />}
      {tab === "places" && <Places />}
      {tab === "audit" && <Audit />}
    </>
  );
}

function useCountries() {
  return useQuery({ queryKey: ["creator-countries"], queryFn: () => api<any[]>("/creator/countries") });
}
function useAllIntramurals() {
  return useQuery({ queryKey: ["intramurals"], queryFn: () => api<any[]>("/intramurals") });
}

function People() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["creator-users"], queryFn: () => api<any[]>("/creator/users") });
  const countries = useCountries();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [country, setCountry] = useState("");
  const [open, setOpen] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useMemo(() => (users.data ?? []).filter((u) =>
    (!role || u.role === role) && (!country || String(u.countryId) === country) &&
    `${u.name} ${u.email} ${u.phone ?? ""}`.toLowerCase().includes(q.toLowerCase())), [users.data, q, role, country]);
  if (users.isLoading) return <Spinner />;
  if (users.error) return <ErrorNote error={users.error} />;
  return (
    <>
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate" aria-hidden /><input className="field pl-10" placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" /></div>
        <select className="field" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option value="">All roles</option>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="field" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country"><option value="">All countries</option>{(countries.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn-primary" onClick={() => setCreating(true)}><UserPlus className="h-4 w-4" /> Add person</button>
      </div>
      <ul className="sheet divide-y divide-line py-1">
        {list.map((u) => (
          <li key={u.id}>
            <button className="flex w-full items-center gap-3 py-2.5 text-left" onClick={() => setOpen(u)}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-navy">{u.name}</p>
                <p className="truncate text-sm text-slate">{u.email} · {u.country ?? "No country"}</p>
              </div>
              {u.status !== "active" && <span className={`chip ${u.status === "pending" ? "bg-warn/15 text-warn" : "bg-bad/10 text-bad"}`}>{u.status}</span>}
              <span className={`chip ${u.role === "super_admin" ? "bg-navy text-white" : u.role === "admin" ? "bg-brand/10 text-brand" : "bg-page text-slate"}`}>{ROLE_LABEL[u.role]}</span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="py-3 text-slate">Nobody matches.</li>}
      </ul>
      {open && <UserEditor user={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ["creator-users"] }); }} />}
      {creating && <CreateUser onClose={() => setCreating(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ["creator-users"] })} />}
    </>
  );
}

function UserEditor({ user, onClose, onSaved }: { user: any; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const countries = useCountries();
  const intramurals = useAllIntramurals();
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState(user.status);
  const [countryId, setCountryId] = useState(user.countryId ?? 0);
  const accountWide = user.grants.filter((g: any) => g.intramuralId === null).map((g: any) => g.permission);
  const [perms, setPerms] = useState<string[]>(accountWide);
  const [assigned, setAssigned] = useState<number[]>(user.intramurals);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const self = user.id === me!.id;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (role !== user.role || status !== user.status || countryId !== user.countryId) {
        await api(`/creator/users/${user.id}`, { method: "PATCH", body: { ...(role !== user.role ? { role } : {}), ...(status !== user.status ? { status } : {}), ...(countryId && countryId !== user.countryId ? { countryId } : {}) } });
      }
      if (role !== "parent") {
        // A newly promoted admin gets every permission from the server; only send ticks for existing admins or the override.
        const promoted = role === "admin" && user.role !== "admin";
        if (!promoted) await api(`/creator/users/${user.id}/permissions`, { method: "PUT", body: { permissions: role === "admin" ? perms : perms.filter((p) => p === "country.override") } });
        await api(`/creator/users/${user.id}/intramurals`, { method: "PUT", body: { intramuralIds: assigned } });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete ${user.name}'s account? This cannot be undone.`)) return;
    try { await api(`/creator/users/${user.id}`, { method: "DELETE" }); onSaved(); } catch (err) { setError((err as Error).message); }
  };
  const byCountry = new Map<string, any[]>();
  for (const i of intramurals.data ?? []) byCountry.set(i.countryName, [...(byCountry.get(i.countryName) ?? []), i]);
  return (
    <Modal open onClose={onClose} title={user.name}>
      <p className="-mt-2 mb-4 text-sm text-slate">{user.email}{user.phone ? ` · ${user.phone}` : ""}</p>
      {user.isCreator && <p className="mb-3 rounded-xl bg-page p-3 text-sm text-slate"><ShieldCheck className="mr-1 inline h-4 w-4" />The creator account. Its role comes from CREATOR_EMAIL.</p>}
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="ur">Role</label>
            <select id="ur" className="field" value={role} disabled={user.isCreator || self} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="us">Status</label>
            <select id="us" className="field" value={status} disabled={user.isCreator} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option>
            </select>
          </div>
        </div>
        <div><label className="label" htmlFor="uc">Country</label>
          <select id="uc" className="field" value={countryId} onChange={(e) => setCountryId(Number(e.target.value))}>
            {(countries.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {role === "admin" && user.role === "admin" && (
          <fieldset className="rounded-xl p-3 ring-1 ring-line">
            <legend className="px-1 text-sm font-bold text-navy">What this admin can do</legend>
            {ADMIN_PERMS.map((p) => (
              <label key={p} className="flex items-center gap-2 py-1 text-[15px]">
                <input type="checkbox" className="h-4 w-4" checked={perms.includes(p)} onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} />
                {PERMISSION_LABELS[p]}
              </label>
            ))}
          </fieldset>
        )}
        {role === "admin" && user.role !== "admin" && <p className="text-sm text-slate">New admins start with every permission. Open them again after saving to untick any.</p>}

        {role !== "parent" && role !== "super_admin" && (
          <>
            <fieldset className="rounded-xl p-3 ring-1 ring-line">
              <legend className="px-1 text-sm font-bold text-navy">Schools and clubs</legend>
              {[...byCountry].map(([cn, list]) => (
                <div key={cn} className="mt-1">
                  <p className="text-xs font-semibold text-slate">{cn}{list[0].countryId !== countryId ? " (another country)" : ""}</p>
                  {list.map((i) => (
                    <label key={i.id} className="flex items-center gap-2 py-1 text-[15px]">
                      <input type="checkbox" className="h-4 w-4" checked={assigned.includes(i.id)} onChange={(e) => setAssigned(e.target.checked ? [...assigned, i.id] : assigned.filter((x) => x !== i.id))} />
                      {i.name} <span className="text-xs text-slate">{WEEKDAYS[i.sessionWeekday]}s</span>
                    </label>
                  ))}
                </div>
              ))}
            </fieldset>
            <label className="flex items-start gap-2 rounded-xl p-3 text-[15px] ring-1 ring-line">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={perms.includes("country.override")} onChange={(e) => setPerms(e.target.checked ? [...perms, "country.override"] : perms.filter((x) => x !== "country.override"))} />
              <span><span className="font-semibold">Override country restriction</span><span className="block text-sm text-slate">Lets them work in assigned schools outside their own country.</span></span>
            </label>
          </>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary" disabled={busy} onClick={save}>Save changes</button>
        {!user.isCreator && !self && <button className="btn-ghost text-bad" onClick={remove}><Trash2 className="h-4 w-4" /> Delete account</button>}
      </div>
    </Modal>
  );
}

function CreateUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const countries = useCountries();
  const [f, setF] = useState({ name: "", email: "", phone: "", role: "coach", countryId: 0 });
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ temporaryPassword: string }>("/creator/users", { method: "POST", body: { ...f, countryId: f.countryId || countries.data?.[0]?.id } });
      setResult(r.temporaryPassword);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title="Add a person">
      {result ? (
        <div className="grid gap-3">
          <p className="text-[15px]">Account created. Share this temporary password with {f.name.split(" ")[0]} privately. They will choose their own when they first sign in.</p>
          <p className="display select-all rounded-xl bg-page p-4 text-center text-3xl tracking-wide">{result}</p>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form onSubmit={save} className="grid gap-3">
          <div><label className="label" htmlFor="cn">Full name</label><NameInput id="cn" value={f.name} onChange={(v) => setF({ ...f, name: v })} required /></div>
          <div><label className="label" htmlFor="ce">Email</label><input id="ce" type="email" className="field" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div><label className="label" htmlFor="cp">Phone</label><input id="cp" type="tel" className="field" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <select className="field" aria-label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select className="field" aria-label="Country" value={f.countryId} onChange={(e) => setF({ ...f, countryId: Number(e.target.value) })}>{(countries.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <button className="btn-primary">Create account</button>
        </form>
      )}
    </Modal>
  );
}

function Impact() {
  const q = useQuery({ queryKey: ["metrics"], queryFn: () => api<any[]>("/creator/metrics") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const total = (k: string) => q.data!.reduce((s, c) => s + Number(c[k] ?? 0), 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Players", total("players")], ["Coaches", total("coaches")], ["Schools & clubs", total("intramurals")], ["Mentorship logs", total("mentorshipLogs")]].map(([l, v]) => (
          <div key={l} className="sheet"><p className="display text-[2.4rem] text-navy">{Number(v).toLocaleString()}</p><p className="text-sm text-slate">{l}</p></div>
        ))}
      </div>
      <h2 className="condensed mb-2 mt-6 text-lg text-navy">By country</h2>
      <div className="sheet overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-left text-[14px]">
          <thead className="text-slate"><tr className="border-b border-line">{["Country", "Schools", "Players", "Coaches", "Parents", "Sessions (30 days)", "Attendance (90 days)", "Virtue avg", "Collected"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {q.data!.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <th scope="row" className="px-3 py-2 font-bold text-navy"><Globe2 className="mr-1 inline h-4 w-4 text-slate" aria-hidden />{c.name}</th>
                <td className="px-3 py-2">{c.intramurals}</td><td className="px-3 py-2">{c.players}</td><td className="px-3 py-2">{c.coaches}</td><td className="px-3 py-2">{c.parents}</td>
                <td className="px-3 py-2">{c.sessions30d}</td><td className="px-3 py-2">{c.attendanceRate90d == null ? "—" : `${c.attendanceRate90d}%`}</td>
                <td className="px-3 py-2">{c.virtueAverage ?? "—"}</td><td className="px-3 py-2">{money(c.collected, c.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Places() {
  const qc = useQueryClient();
  const countries = useCountries();
  const intramurals = useAllIntramurals();
  const [c, setC] = useState({ code: "", name: "", currency: "", timeZone: "", phonePrefix: "+", mpesa: false });
  const [i, setI] = useState({ countryId: 0, name: "", shortCode: "", kind: "intramural", sessionWeekday: 2 });
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const addCountry = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/creator/countries", { method: "POST", body: c }); setMsg({ tone: "good", text: `${c.name} added.` }); setC({ code: "", name: "", currency: "", timeZone: "", phonePrefix: "+", mpesa: false }); void qc.invalidateQueries({ queryKey: ["creator-countries"] }); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message }); }
  };
  const addIntramural = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/creator/intramurals", { method: "POST", body: { ...i, countryId: i.countryId || countries.data?.[0]?.id } }); setMsg({ tone: "good", text: `${i.name} added. Assign an admin to it under People.` }); setI({ ...i, name: "", shortCode: "" }); void qc.invalidateQueries({ queryKey: ["intramurals"] }); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message }); }
  };
  const toggle = async (country: any, key: "active" | "mpesa") => {
    await api(`/creator/countries/${country.id}`, { method: "PATCH", body: { [key]: !country[key] } });
    void qc.invalidateQueries({ queryKey: ["creator-countries"] });
  };
  return (
    <>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <h2 className="condensed mb-2 mt-2 text-lg text-navy">Countries</h2>
      <ul className="sheet divide-y divide-line py-1">
        {(countries.data ?? []).map((ct) => (
          <li key={ct.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="flex-1 font-bold text-navy">{ct.name} <span className="text-sm font-normal text-slate">{ct.code} · {ct.currency} · {ct.timeZone} · {ct.phonePrefix}</span></span>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ct.mpesa} onChange={() => toggle(ct, "mpesa")} /> M-PESA</label>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ct.active} onChange={() => toggle(ct, "active")} /> Open for sign-up</label>
          </li>
        ))}
      </ul>
      <form onSubmit={addCountry} className="sheet mt-3 grid gap-3">
        <p className="font-bold text-navy">Add a country</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <input className="field" placeholder="Name, e.g. Uganda" aria-label="Country name" required value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          <input className="field" placeholder="Code, e.g. UG" aria-label="Country code" maxLength={2} required value={c.code} onChange={(e) => setC({ ...c, code: e.target.value.toUpperCase() })} />
          <input className="field" placeholder="Currency, e.g. UGX" aria-label="Currency" maxLength={3} required value={c.currency} onChange={(e) => setC({ ...c, currency: e.target.value.toUpperCase() })} />
          <input className="field" placeholder="Time zone, e.g. Africa/Kampala" aria-label="Time zone" required value={c.timeZone} onChange={(e) => setC({ ...c, timeZone: e.target.value })} />
          <input className="field" placeholder="Phone prefix, e.g. +256" aria-label="Phone prefix" required value={c.phonePrefix} onChange={(e) => setC({ ...c, phonePrefix: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.mpesa} onChange={(e) => setC({ ...c, mpesa: e.target.checked })} /> M-PESA available</label>
        </div>
        <button className="btn-primary justify-self-start">Add country</button>
      </form>

      <h2 className="condensed mb-2 mt-6 text-lg text-navy">Schools and clubs</h2>
      {(intramurals.data ?? []).length === 0 ? <Empty>None yet.</Empty> : (
        <ul className="sheet divide-y divide-line py-1">
          {intramurals.data!.map((x) => <li key={x.id} className="py-2 text-[15px]"><span className="font-semibold">{x.name}</span> <span className="text-sm text-slate">{x.countryName} · {x.dayLabel}</span></li>)}
        </ul>
      )}
      <form onSubmit={addIntramural} className="sheet mt-3 grid gap-3">
        <p className="font-bold text-navy">Add a school intramural or club</p>
        <div className="grid grid-cols-2 gap-3">
          <input className="field" placeholder="Name" aria-label="Name" required value={i.name} onChange={(e) => setI({ ...i, name: e.target.value })} />
          <input className="field" placeholder="Short code, e.g. KH" aria-label="Short code" maxLength={6} required value={i.shortCode} onChange={(e) => setI({ ...i, shortCode: e.target.value })} />
          <select className="field" aria-label="Country" value={i.countryId} onChange={(e) => setI({ ...i, countryId: Number(e.target.value) })}>{(countries.data ?? []).map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}</select>
          <select className="field" aria-label="Kind" value={i.kind} onChange={(e) => setI({ ...i, kind: e.target.value })}><option value="intramural">Intramural</option><option value="club">Club</option></select>
          <select className="field" aria-label="Session day" value={i.sessionWeekday} onChange={(e) => setI({ ...i, sessionWeekday: Number(e.target.value) })}>{WEEKDAYS.map((d, n) => <option key={d} value={n}>{d}s</option>)}</select>
        </div>
        <button className="btn-primary justify-self-start">Add</button>
      </form>
    </>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<any[]>("/creator/audit") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  return (
    <ul className="sheet divide-y divide-line py-1">
      {q.data!.map((a) => (
        <li key={a.id} className="py-2 text-[14px]">
          <span className="font-semibold">{a.actor ?? "System"}</span> · {a.action.replace(/_/g, " ")} <span className="text-xs text-slate">{dateTime12(a.createdAt)}</span>
          <span className="block truncate text-xs text-slate">{JSON.stringify(a.detail)}</span>
        </li>
      ))}
    </ul>
  );
}
