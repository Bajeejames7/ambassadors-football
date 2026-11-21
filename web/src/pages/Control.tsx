import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, Lock } from "lucide-react";
import { api } from "../lib/api";
import { money } from "../lib/format";
import { Empty, ErrorNote, Notice, SectionTitle, Spinner } from "../components/ui";

// ---- Privilege Control (Super Admin only) ---------------------------------------------------

interface Privileges { options: { key: string; label: string }[]; admins: { id: number; name: string; email: string; status: string; restrictions: string[] }[] }

/**
 * Admins have every Super Admin power by default. Untick a power to switch it
 * off for that one Admin; the server blocks it and the app hides it.
 */
export function PrivilegeControl() {
  const q = useQuery({ queryKey: ["privileges"], queryFn: () => api<Privileges>("/control/privileges") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { options, admins } = q.data!;
  return (
    <>
      <p className="mb-3 text-[15px] text-slate">
        Admins can do everything a Super Admin can, until you switch a power off here. Changes apply the next time they open the app.
        Only you can change Admin accounts and the payment details.
      </p>
      {admins.length === 0 ? <Empty>No Admins yet. Make someone an Admin in Staff & Coaches.</Empty> : (
        <ul className="grid gap-3">
          {admins.map((a) => <AdminPrivileges key={a.id} admin={a} options={options} />)}
        </ul>
      )}
    </>
  );
}

function AdminPrivileges({ admin, options }: { admin: Privileges["admins"][number]; options: Privileges["options"] }) {
  const qc = useQueryClient();
  const [off, setOff] = useState<string[]>(admin.restrictions);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const dirty = [...off].sort().join() !== [...admin.restrictions].sort().join();
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/control/privileges/${admin.id}`, { method: "PUT", body: { restrictions: off } });
      await qc.invalidateQueries({ queryKey: ["privileges"] });
      setMsg({ tone: "good", text: off.length ? `Saved. ${off.length} power${off.length === 1 ? "" : "s"} switched off.` : "Saved. Same powers as a Super Admin." });
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="sheet">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-bold text-navy">{admin.name}</p>
        <p className="text-sm text-slate">{off.length === 0 ? "Full Super Admin powers" : `${options.length - off.length} of ${options.length} powers on`}</p>
      </div>
      <p className="truncate text-sm text-slate">{admin.email}</p>
      <ul className="mt-3 grid gap-1 sm:grid-cols-2">
        {options.map((o) => {
          const on = !off.includes(o.key);
          return (
            <li key={o.key}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 text-[15px] hover:bg-page">
                <input type="checkbox" className="h-5 w-5" checked={on}
                  onChange={() => setOff(on ? [...off, o.key] : off.filter((k) => k !== o.key))} />
                <span className={on ? "text-ink" : "text-slate line-through"}>{o.label}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Save
        </button>
        {off.length > 0 && <button className="text-sm font-semibold text-brand" onClick={() => setOff([])}>Turn everything back on</button>}
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </li>
  );
}

// ---- Payment Configuration & registration link ------------------------------------------------

interface Config {
  intramuralId: number; name: string; shortCode: string; programMode: "school" | "club"; currency: string;
  termLabel: string | null; feeAmount: number | null; method: "paybill" | "till"; paybill: string; till: string;
  accountRefFormat: string; deadline: string | null; instructions: string; updatedAt: string | null; formUrl: string;
}
interface ConfigData { canEdit: boolean; configs: Config[]; registration: { url: string } }

export function PaymentConfiguration() {
  const q = useQuery({ queryKey: ["payment-config"], queryFn: () => api<ConfigData>("/control/payment-config") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { canEdit, configs, registration } = q.data!;
  return (
    <>
      {!canEdit && (
        <p className="mb-3 flex items-center gap-2 rounded-xl bg-white/90 p-3 text-sm font-semibold text-slate">
          <Lock className="h-4 w-4" aria-hidden /> Only the Super Admin can change payment details and the registration link.
        </p>
      )}
      <RegistrationLink url={registration.url} canEdit={canEdit} />
      <SectionTitle>Fees and M-PESA details, per school or club</SectionTitle>
      <p className="mb-3 text-sm text-white/80">Parents see exactly these details on their payment card, and the M-PESA prompt is always for this fee.</p>
      <ul className="grid gap-3">
        {configs.map((c) => <ConfigCard key={c.intramuralId} c={c} canEdit={canEdit} />)}
      </ul>
    </>
  );
}

function RegistrationLink({ url, canEdit }: { url: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(url);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/control/registration", { method: "PUT", body: { url: value.trim() } });
      await qc.invalidateQueries({ queryKey: ["payment-config"] });
      setMsg({ tone: "good", text: "Saved. The Register a Child button now opens this link." });
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="sheet">
      <label className="font-bold text-navy" htmlFor="reg-url">Register a Child link</label>
      <p className="text-sm text-slate">
        The registration form parents use for new children (for example your Airtable form). It opens from the big
        Register a Child button on the parent portal and its sign-in page.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input id="reg-url" className="field min-w-0 flex-1" type="url" placeholder="https://airtable.com/…" value={value}
          onChange={(e) => setValue(e.target.value)} disabled={!canEdit} />
        {canEdit && <button className="btn-primary" disabled={busy || value.trim() === url}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Save</button>}
        {url && <a className="btn-ghost" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /> Open</a>}
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </form>
  );
}

function ConfigCard({ c, canEdit }: { c: Config; canEdit: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    termLabel: c.termLabel ?? "",
    feeAmount: c.feeAmount ? String(Math.round(Number(c.feeAmount))) : "",
    method: c.method,
    paybill: c.paybill,
    till: c.till,
    accountRefFormat: c.accountRefFormat,
    deadline: c.deadline ?? "",
    instructions: c.instructions,
    formUrl: c.formUrl,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const example = (f.accountRefFormat || "{CODE}-{CHILD}").replaceAll("{CODE}", c.shortCode).replaceAll("{CHILD}", "AMANI").replaceAll("{ID}", "42").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api(`/control/payment-config/${c.intramuralId}`, {
        method: "PUT",
        body: {
          termLabel: f.termLabel.trim(), feeAmount: f.feeAmount ? Number(f.feeAmount) : null, method: f.method,
          paybill: f.paybill.trim(), till: f.till.trim(), accountRefFormat: f.accountRefFormat.trim(),
          deadline: f.deadline || null, instructions: f.instructions, formUrl: f.formUrl.trim(),
        },
      });
      await qc.invalidateQueries({ queryKey: ["payment-config"] });
      await qc.invalidateQueries({ queryKey: ["payments", c.intramuralId] });
      setMsg({ tone: "good", text: "Saved. Every child's term fee now uses this amount." });
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="sheet">
      <form onSubmit={save}>
        <fieldset disabled={!canEdit} className="grid gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-bold text-navy">{c.name}</p>
            <span className="text-sm text-slate">{c.feeAmount ? `${money(Number(c.feeAmount), c.currency)} · ${c.termLabel}` : "No fee set"}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor={`t-${c.intramuralId}`}>{c.programMode === "club" ? "Camp or term" : "Term"}</label>
              <input id={`t-${c.intramuralId}`} className="field" placeholder={c.programMode === "club" ? "Summer Camp 2027" : "Term 1 2027"} value={f.termLabel} onChange={(e) => set("termLabel", e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor={`a-${c.intramuralId}`}>Fee ({c.currency})</label>
              <input id={`a-${c.intramuralId}`} className="field" inputMode="numeric" placeholder="3000" value={f.feeAmount} onChange={(e) => set("feeAmount", e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <div className="grid grid-cols-[auto_1fr] items-end gap-2">
            <div>
              <span className="label">Paid to</span>
              <div className="inline-flex rounded-xl bg-page p-1 ring-1 ring-line" role="radiogroup" aria-label="M-PESA method">
                {(["paybill", "till"] as const).map((m) => (
                  <label key={m} className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-bold ${f.method === m ? "bg-navy text-white" : "text-slate"}`}>
                    <input type="radio" className="sr-only" checked={f.method === m} onChange={() => set("method", m)} />{m === "paybill" ? "Paybill" : "Till"}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="label" htmlFor={`n-${c.intramuralId}`}>{f.method === "paybill" ? "Paybill number" : "Till number"}</label>
              <input id={`n-${c.intramuralId}`} className="field" inputMode="numeric" value={f.method === "paybill" ? f.paybill : f.till}
                onChange={(e) => set(f.method, e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          {f.method === "paybill" && (
            <div>
              <label className="label" htmlFor={`r-${c.intramuralId}`}>Account reference format</label>
              <input id={`r-${c.intramuralId}`} className="field" value={f.accountRefFormat} onChange={(e) => set("accountRefFormat", e.target.value)} />
              <p className="mt-1 text-xs text-slate">Use {"{CODE}"} for the school code, {"{CHILD}"} for the child's first name, {"{ID}"} for their number. Example: <strong>{example}</strong> (12 characters at most).</p>
            </div>
          )}
          <div>
            <label className="label" htmlFor={`d-${c.intramuralId}`}>Payment deadline</label>
            <input id={`d-${c.intramuralId}`} className="field" type="date" value={f.deadline} onChange={(e) => set("deadline", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor={`i-${c.intramuralId}`}>Instructions for parents</label>
            <textarea id={`i-${c.intramuralId}`} className="field min-h-20" value={f.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="What the fee covers, and who to ask about payment plans." />
          </div>
          <div>
            <label className="label" htmlFor={`f-${c.intramuralId}`}>This school's registration form link</label>
            <input id={`f-${c.intramuralId}`} className="field" type="url" placeholder="https://airtable.com/…" value={f.formUrl} onChange={(e) => set("formUrl", e.target.value)} />
          </div>
          {canEdit && <button className="btn-primary justify-self-start" disabled={busy}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Save {c.shortCode}</button>}
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </fieldset>
      </form>
    </li>
  );
}
