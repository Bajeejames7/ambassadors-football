import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { api } from "../lib/api";
import { asset } from "../lib/base";
import { useAuth, type Me } from "../lib/auth";
import { NameInput, Notice } from "../components/ui";
import { InstallApp } from "../components/InstallApp";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="photo-navy min-h-screen bg-fixed text-white">
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col px-5 pb-10 pt-[calc(2.5rem+env(safe-area-inset-top))]">
        <svg className="pointer-events-none absolute -right-24 top-8 h-80 w-80 opacity-[0.08]" viewBox="0 0 200 200" aria-hidden>
          <circle cx="100" cy="100" r="70" fill="none" stroke="white" strokeWidth="3" />
          <line x1="100" y1="0" x2="100" y2="200" stroke="white" strokeWidth="3" />
        </svg>
        <img src={asset("logo.jpg")} alt="" className="h-16 w-16 rounded-xl" />
        <h1 className="display mt-6 text-[3.3rem]">Football.<br />Faith.<br />Future.</h1>
        <p className="mt-3 text-[15px] text-white/75">Ambassadors Football — for coaches, coordinators and parents.</p>
        <div className="mt-8 rounded-[26px] bg-white p-5 text-ink">{children}</div>
        <div className="mt-4 text-ink"><InstallApp /></div>
        <p className="mt-6 text-center text-sm text-white/60">
          <Link to="/privacy" className="underline">Privacy policy</Link> · <Link to="/delete-account" className="underline">Delete an account</Link>
        </p>
      </div>
    </div>
  );
}

interface DemoInfo { demo: boolean; password?: string; accounts?: { role: string; email: string }[] }

export function LoginPage() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  useEffect(() => {
    api<DemoInfo>("/info").then(setDemo).catch(() => {});
  }, []);
  const signInAs = async (id: string, pw: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string; me: Me }>("/auth/login", { method: "POST", body: { identifier: id, password: pw } });
      signIn(r.token, r.me);
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string; me: Me }>("/auth/login", { method: "POST", body: { identifier, password } });
      signIn(r.token, r.me);
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <form onSubmit={submit} className="grid gap-4">
        <h2 className="condensed text-2xl text-navy">Sign in</h2>
        <div>
          <label className="label" htmlFor="id">Email or phone</label>
          <input id="id" className="field" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="pw">Password</label>
          <input id="pw" className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary h-12" disabled={busy}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Sign in</button>
        <p className="text-center text-sm text-slate">New here? <Link to="/signup" className="font-semibold text-brand">Create an account</Link></p>
      </form>
      {demo?.demo && demo.accounts && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="font-bold text-navy">Try the demo</p>
          <p className="text-sm text-slate">Sample data only. Sign in as:</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {demo.accounts.map((a) => (
              <button key={a.email} type="button" disabled={busy} onClick={() => signInAs(a.email, demo.password!)}
                className="rounded-xl px-3 py-2.5 text-left ring-1 ring-line hover:bg-page disabled:opacity-50">
                <span className="block text-[15px] font-bold text-navy">{a.role}</span>
                <span className="block truncate text-xs text-slate">{a.email}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

interface Country { id: number; code: string; name: string; phonePrefix: string }

/** Onboarding: country → who you are → your details. */
export function SignupPage() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [countries, setCountries] = useState<Country[]>([]);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ countryId: 0, role: "" as "" | "coach" | "parent", name: "", email: "", phone: "", password: "" });
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Country[]>("/countries").then((c) => {
      setCountries(c);
      if (c.length === 1) setForm((f) => ({ ...f, countryId: c[0].id }));
    }).catch((e) => setError(e.message));
  }, []);
  const country = countries.find((c) => c.id === form.countryId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string; me: Me }>("/auth/signup", { method: "POST", body: form });
      signIn(r.token, r.me);
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <p className="text-sm font-semibold text-slate">Step {step} of 3</p>
      {step === 1 && (
        <div className="mt-2 grid gap-3">
          <h2 className="condensed text-2xl text-navy">Where do you play?</h2>
          <p className="text-[15px] text-slate">You will see the schools and clubs in your country.</p>
          <div className="grid gap-2">
            {countries.map((c) => (
              <button key={c.id} type="button" onClick={() => { setForm({ ...form, countryId: c.id }); setStep(2); }}
                className={`flex items-center justify-between rounded-xl px-4 py-3 text-left font-semibold ring-1 ${form.countryId === c.id ? "bg-navy text-white ring-navy" : "ring-line hover:bg-page"}`}>
                {c.name} <span className="text-sm opacity-70">{c.phonePrefix}</span>
              </button>
            ))}
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <p className="text-center text-sm text-slate">Already have an account? <Link to="/login" className="font-semibold text-brand">Sign in</Link></p>
        </div>
      )}
      {step === 2 && (
        <div className="mt-2 grid gap-3">
          <h2 className="condensed text-2xl text-navy">I am a…</h2>
          {[
            { id: "parent", title: "Parent or guardian", text: "Follow your child's attendance, growth, fees and matchdays." },
            { id: "coach", title: "Coach", text: "Sessions, roll call, mentorship logs and tallies. A coordinator adds you to your school." },
          ].map((r) => (
            <button key={r.id} type="button" onClick={() => { setForm({ ...form, role: r.id as "coach" | "parent" }); setStep(3); }}
              className="rounded-xl px-4 py-3 text-left ring-1 ring-line hover:bg-page">
              <span className="block font-bold text-navy">{r.title}</span>
              <span className="text-sm text-slate">{r.text}</span>
            </button>
          ))}
          <button type="button" className="btn-ghost" onClick={() => setStep(1)}>Back</button>
        </div>
      )}
      {step === 3 && (
        <form onSubmit={submit} className="mt-2 grid gap-4">
          <h2 className="condensed text-2xl text-navy">Your details</h2>
          {form.role === "parent" && (
            <p className="rounded-xl bg-page p-3 text-sm text-slate">Use the same email or phone you gave when registering your child. A coordinator confirms the link before you can see their progress.</p>
          )}
          <div>
            <label className="label" htmlFor="nm">Full name</label>
            <NameInput id="nm" value={form.name} onChange={(name) => setForm({ ...form, name })} required />
          </div>
          <div>
            <label className="label" htmlFor="em">Email</label>
            <input id="em" className="field" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="ph">Phone</label>
            <input id="ph" className="field" type="tel" autoComplete="tel" placeholder={country?.code === "KE" ? "0712 345 678" : country?.phonePrefix} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="pw2">Password</label>
            <input id="pw2" className="field" type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            <p className="mt-1 text-xs text-slate">At least 8 characters.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-slate">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} required />
            <span>I have read the <Link to="/privacy" className="font-semibold text-brand" target="_blank">privacy policy</Link>, including how children's information is protected.</span>
          </label>
          {error && <Notice tone="bad">{error}</Notice>}
          <button className="btn-primary h-12" disabled={busy || !agree}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Create account</button>
          <button type="button" className="btn-ghost" onClick={() => setStep(2)}>Back</button>
        </form>
      )}
    </Shell>
  );
}

function Doc({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-page">
      <header className="bg-navy px-5 py-6 text-white">
        <div className="mx-auto max-w-2xl">
          <Link to="/" className="text-sm text-white/70 underline">Ambassadors Football</Link>
          <h1 className="display mt-2 text-[2.4rem]">{title}</h1>
        </div>
      </header>
      <article className="mx-auto max-w-2xl px-5 py-8 text-[16px] leading-relaxed text-ink [&_h2]:condensed [&_h2]:mt-7 [&_h2]:text-xl [&_li]:mt-1 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </article>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <Doc title="Privacy policy">
      <p>Last updated: 20 November 2026. This policy explains what the Ambassadors Football app collects, why, and the choices you have. The app is used by coaches, coordinators and parents of children who play in our school intramurals and clubs.</p>
      <h2>Children's information</h2>
      <p>Children do not create accounts. A coordinator or coach registers a child, usually from the school's registration form. For each child we keep:</p>
      <ul>
        <li>name, age group, team and, if given, date of birth;</li>
        <li>parent or guardian name, email and phone;</li>
        <li>medical notes the parent chose to share, so coaches can keep the child safe;</li>
        <li>attendance, coach feedback, character and virtue scores, awards, and injury reports.</li>
      </ul>
      <p>Only the child's own verified parents and the coaches and coordinators of the child's school can see this information. Parents never see other children. Coaches' mentorship notes (discussion, scripture and prayer points, welfare observations) are kept for coaches and coordinators and are never shown to other parents.</p>
      <h2>Accounts</h2>
      <p>For parents, coaches and coordinators we keep name, email, phone, country, password (stored only as a secure hash) and which schools they work with. We use the email and phone to stop duplicate accounts and to link parents to their children.</p>
      <h2>Payments</h2>
      <p>When you pay with M-PESA, your phone number and the amount are sent to Safaricom to send the PIN prompt. We store the M-PESA receipt number and the result. We never see or store your M-PESA PIN.</p>
      <h2>Who we share with</h2>
      <ul>
        <li>Safaricom (M-PESA), only to process a payment you start;</li>
        <li>Airtable, where your school keeps its registration forms;</li>
        <li>our hosting and database providers, who store the data for us.</li>
      </ul>
      <p>We do not sell data and do not show advertising. Data is not used for any purpose other than running the programme.</p>
      <h2>Security and storage</h2>
      <p>Data travels encrypted (HTTPS). Every request is checked on the server against the person's role, country and school. Coaches' phones keep a copy of their school's roster so the app works on the pitch without signal; signing out removes it.</p>
      <h2>How long we keep data</h2>
      <p>Player records are kept while the child is in the programme and for up to two years after, for safeguarding. Payment records are kept as long as the law requires for accounts.</p>
      <h2>Your choices</h2>
      <ul>
        <li>See and correct your details in Account.</li>
        <li>Delete your account at any time: Account → Delete my account. This removes your sign-in, your link to your children, and your notifications.</li>
        <li>Ask your school's coordinator to remove your child's record, or write to us.</li>
      </ul>
      <h2>Contact</h2>
      <p>Questions or requests: speak to your school's coordinator, or email the Ambassadors Football team at the address on our registration forms.</p>
    </Doc>
  );
}

export function DeleteAccountInfoPage() {
  return (
    <Doc title="Delete your account">
      <p>You can delete your Ambassadors Football account yourself, at any time.</p>
      <h2>In the app</h2>
      <ul>
        <li>Sign in and open <strong>Account</strong>.</li>
        <li>Choose <strong>Delete my account</strong> and enter your password to confirm.</li>
      </ul>
      <h2>What is deleted</h2>
      <p>Your sign-in, profile, phone and email, your links to your children, your notifications, your availability answers and any permissions. This cannot be undone.</p>
      <h2>What is kept</h2>
      <p>Payment records are kept for the organisation's accounts as the law requires, with your phone number removed. Your child's player record belongs to the school's programme; ask the coordinator if you also want it removed.</p>
      <h2>Can't sign in?</h2>
      <p>Ask your school's coordinator to delete the account for you, or email the Ambassadors Football team from the email address on the account.</p>
    </Doc>
  );
}
