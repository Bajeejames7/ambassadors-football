import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, CheckCircle2, HeartPulse, UserPlus, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { cached } from "../lib/offline";
import { useUpcoming } from "../lib/queries";
import { dateRange, dateTime12, money, sessionLabel, shortDate, VIRTUE_LABELS } from "../lib/format";
import { Crest, Empty, ErrorNote, FixtureBoard, PageTitle, SectionTitle, Spinner } from "../components/ui";
import { VirtueRadar } from "../components/VirtueRadar";
import { useAuth } from "../lib/auth";
import { AttendanceCard, CoachTimeline, PaymentCard, Placement, type Overview } from "../components/ChildProgress";
import { RegisterChildButton } from "./Portal";

export interface Child {
  id: number;
  firstName: string;
  lastName: string;
  category: string;
  team: string;
  intramuralId: number;
  intramuralName: string;
  color: string;
  shortCode: string;
  logo: string;
  currency: string;
  mpesa: boolean;
  balance: number;
  unacknowledgedInjuries: number;
  registrationFormUrl: string | null;
  unpaidAlerts: number;
  programMode: "school" | "club";
}

export const useChildren = () => useQuery({ queryKey: ["children"], queryFn: () => cached<{ pending: boolean; children: Child[] }>("/parent/children") });

/** Parent home: one child at a time, switched with the chips at the top. */
export function ParentHome() {
  const { me } = useAuth();
  const kids = useChildren();
  const [selected, setSelected] = useState<number | null>(null);
  if (kids.isLoading) return <Spinner />;
  if (kids.error) return <ErrorNote error={kids.error} onRetry={() => kids.refetch()} />;
  const { pending, children } = kids.data!;
  const first = me!.name.split(" ")[0];
  if (pending || children.length === 0) {
    return (
      <>
        <PageTitle title={`Welcome, ${first}`} />
        <div className="mb-5"><RegisterChildButton /></div>
        <div className="sheet">
          <h2 className="condensed text-xl text-navy">We're confirming your children</h2>
          <p className="mt-2 text-[15px] text-slate">
            A coordinator checks that you are the parent or guardian on your child's registration. You'll get an alert here as soon as it's done.
            It helps if you signed up with the same email or phone you used on the registration form.
          </p>
        </div>
      </>
    );
  }
  const child = children.find((c) => c.id === selected) ?? children[0];
  return (
    <>
      <PageTitle banner title={`Hello, ${first}`} sub={children.length > 1 ? "Choose a child to see their progress." : "Your child's progress, sessions and registration."} />
      <div className="mb-5"><RegisterChildButton /></div>
      {children.length > 1 && (
        <div className="-mx-4 mb-2 flex gap-3 overflow-x-auto px-4 pb-6 pt-2" role="tablist" aria-label="Your children">
          {children.map((c) => (
            <button key={c.id} role="tab" aria-selected={c.id === child.id} onClick={() => setSelected(c.id)}
              className="token flex items-center gap-2 whitespace-nowrap rounded-full py-1.5 pl-1.5 pr-4 text-[15px] font-semibold text-navy">
              <span className="bead grid h-8 w-8 place-items-center rounded-full text-sm text-white" style={{ background: c.color }}>{c.firstName[0]}</span>
              {c.firstName}
            </button>
          ))}
        </div>
      )}
      <ChildDashboard key={child.id} child={child} />
    </>
  );
}

export function ChildRoute() {
  const { id } = useParams();
  const kids = useChildren();
  if (kids.isLoading) return <Spinner />;
  const child = kids.data?.children.find((c) => c.id === Number(id));
  if (!child) return <Navigate to="/" replace />;
  return (
    <>
      <PageTitle banner title={`${child.firstName} ${child.lastName}`} />
      <ChildDashboard child={child} />
    </>
  );
}

/**
 * One child's progress. `preview` is the admin's read-only view of what the
 * parent sees (Creator Control → Parents → Preview): no parent-only actions.
 */
export function ChildDashboard({ child, preview = false }: { child: Child; preview?: boolean }) {
  const qc = useQueryClient();
  const progress = useQuery({ queryKey: ["progress", child.id], queryFn: () => cached<any>(`/players/${child.id}/progress`) });
  const overview = useQuery({ queryKey: ["overview", child.id], queryFn: () => cached<Overview>(`/players/${child.id}/overview`) });
  const paid = () => {
    void qc.invalidateQueries({ queryKey: ["overview", child.id] });
    void qc.invalidateQueries({ queryKey: ["children"] });
  };
  const unpaid = useQuery({ queryKey: ["unpaid", child.id], queryFn: () => cached<any[]>(`/players/${child.id}/unpaid-alerts`) });
  const upcoming = useUpcoming();
  const openUnpaid = (unpaid.data ?? []).filter((u) => !u.resolvedAt);
  const next = (upcoming.data ?? []).find((s) => s.intramuralId === child.intramuralId && !s.cancelled);
  const fixtures = (upcoming.data ?? []).filter((s) => s.intramuralId === child.intramuralId && s.kind !== "training").slice(0, 3);

  // Compare with the first month of the season, to show growth.
  const firstMonth = useMemo(() => {
    const trend = (progress.data?.virtueTrend ?? []) as { month: string; virtue: string; average: number }[];
    if (trend.length === 0) return undefined;
    const m = trend[0].month;
    const months = new Set(trend.map((t) => t.month));
    if (months.size < 2) return undefined;
    return trend.filter((t) => t.month === m).map((t) => ({ virtue: t.virtue, average: Number(t.average) }));
  }, [progress.data]);

  if (progress.isLoading) return <Spinner />;
  if (progress.error) return <ErrorNote error={progress.error} onRetry={() => progress.refetch()} />;
  const p = progress.data;
  const openInjuries = (p.injuries as any[]).filter((j) => !j.acknowledgedAt);
  const acknowledge = async (id: number) => {
    await api(`/injuries/${id}/acknowledge`, { method: "POST" });
    void qc.invalidateQueries({ queryKey: ["progress", child.id] });
    void qc.invalidateQueries({ queryKey: ["children"] });
  };

  return (
    <div className="rise">
      <p className="mb-4 flex flex-wrap items-center gap-2 text-[15px] text-slate">
        <span className="chip bg-navy text-white">{child.category || "Age group not set"}</span>
        {child.intramuralName}
      </p>
      {openUnpaid.map((u) => (
        <div key={u.id} role="alert" className="slab slab-alert mb-5 p-4">
          <p className="font-bold text-navy">Unpaid: {u.title}{u.amount ? ` · ${money(Number(u.amount), child.currency)}` : ""}</p>
          {u.note && <p className="mt-1 text-[15px]">{u.note}</p>}
          <p className="mt-1 text-xs text-slate">Flagged {dateTime12(u.createdAt)}</p>
          {!preview && (
            <Link to={`/register?school=${child.intramuralId}`} className="btn btn-mpesa mt-3 min-h-10 px-4"><Wallet className="h-4 w-4" /> Pay through the form</Link>
          )}
        </div>
      ))}
      {p.__offline && <p className="mb-3 rounded-xl bg-warn/15 p-3 text-sm font-semibold text-warn">Offline: showing what was saved on {dateTime12(new Date(p.__offline).toISOString())}.</p>}

      {/* Welfare first: an injury is the most urgent thing a parent can see. */}
      {openInjuries.map((j) => (
        <div key={j.id} role="alert" className={`slab mb-5 p-4 ${j.severity === "serious" || j.severity === "moderate" ? "slab-alert" : "slab-caution"}`}>
          <div className="flex items-start gap-3">
            <HeartPulse className={`mt-0.5 h-6 w-6 shrink-0 ${j.severity === "knock" || j.severity === "minor" ? "text-warn" : "text-bad"}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-bold text-navy">{child.firstName} picked up {j.severity === "knock" ? "a knock" : `a ${j.severity} injury`}{j.bodyPart ? ` (${j.bodyPart})` : ""}</p>
              <p className="mt-1 text-[15px] text-ink">{j.description}</p>
              {j.actionTaken && <p className="mt-1 text-sm text-slate">What the coach did: {j.actionTaken}</p>}
              <p className="mt-1 text-xs text-slate">Reported by {j.reportedBy ?? "a coach"}, {dateTime12(j.createdAt)}</p>
              {!preview && <button className="btn-ghost mt-3" onClick={() => acknowledge(j.id)}><CheckCircle2 className="h-4 w-4" /> I've seen this</button>}
            </div>
          </div>
        </div>
      ))}

      {next && <FixtureBoard s={next} title={child.intramuralName} footer={<Link to="/schedule" className="text-sm font-semibold text-white underline">Full schedule</Link>} />}

      {overview.data ? (
        <>
          <SectionTitle>Program & team</SectionTitle>
          <Placement o={overview.data} />
          <SectionTitle>Payment</SectionTitle>
          <PaymentCard o={overview.data} childName={child.firstName} preview={preview} onPaid={paid} />
          <SectionTitle>Attendance</SectionTitle>
          <AttendanceCard o={overview.data} />
        </>
      ) : overview.isLoading ? <Spinner /> : null}

      <SectionTitle>Character & virtue growth</SectionTitle>
      <div className="sheet">
        {(p.virtues as { entries: number }[]).some((v) => v.entries > 0) ? (
          <>
            <div className="well"><VirtueRadar data={p.virtues} compare={firstMonth} /></div>
            <p className="mt-3 text-center text-sm text-slate">
              Season {p.season} average out of 10{firstMonth ? "; the dashed shape is the first month, for comparison" : ""}.
            </p>
          </>
        ) : (
          <p className="py-6 text-center text-[15px] text-slate">Coaches score {Object.values(VIRTUE_LABELS).join(", ")} through the season. The chart appears after the first scores.</p>
        )}
      </div>

      <SectionTitle>Coach feedback & milestones</SectionTitle>
      {overview.data && <CoachTimeline o={overview.data} />}

      {fixtures.length > 0 && (
        <>
          <SectionTitle>Upcoming matches, camps & travel</SectionTitle>
          <ul className="grid gap-3">
            {fixtures.map((s) => (
              <li key={s.id} className="sheet">
                <p className="font-bold text-navy">{sessionLabel(s)}</p>
                <p className="text-[15px]">{dateRange(s.date, s.endDate)}, {s.timeLabel}</p>
                {s.location && <p className="text-sm text-slate">Pitch: {s.location}</p>}
                {s.dressCode && <p className="text-sm text-slate">Kit: {s.dressCode}</p>}
                {s.travelNotes && <p className="mt-1 text-sm text-ink">{s.travelNotes}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionTitle>Register a brother or sister</SectionTitle>
      <div className="sheet flex items-center gap-3">
        <Crest i={{ logo: child.logo, shortCode: child.shortCode, color: child.color, name: child.intramuralName }} />
        <p className="flex-1 text-[15px] text-slate">Register and pay through {child.intramuralName}'s form, or pick another school or club.</p>
        {!preview && <Link className="btn-blue" to={`/register?school=${child.intramuralId}`}><UserPlus className="h-4 w-4" /> Register</Link>}
      </div>
    </div>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={`h-2 w-5 rounded-sm ${n <= Math.round(value) ? "bg-brand" : "bg-line"}`} aria-hidden />
      ))}
    </span>
  );
}

export function StatusChip({ status, at }: { status: string | null; at?: string | null }) {
  const map: Record<string, string> = { present: "bg-good/15 text-good", late: "bg-warn/15 text-warn", absent: "bg-bad/10 text-bad", excused: "bg-page text-slate" };
  if (!status) return <span className="chip bg-page text-slate">Not marked</span>;
  return (
    <span className={`chip ${map[status]}`}>
      {status[0].toUpperCase() + status.slice(1)}
      {at && (status === "present" || status === "late") ? ` ${new Date(at).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase()}` : ""}
    </span>
  );
}

/** Fees & payment history for one child. */
export function FeesPage() {
  const { id } = useParams();
  const kids = useChildren();
  if (kids.isLoading) return <Spinner />;
  const children = kids.data?.children ?? [];
  if (!id) {
    if (children.length === 1) return <Navigate to={`/child/${children[0].id}/fees`} replace />;
    return (
      <>
        <PageTitle banner title="Fees" sub="Choose a child." />
        {children.length === 0 ? <Empty>Fees appear once your children are linked to your account.</Empty> : (
          <ul className="grid gap-3">
            {children.map((c) => (
              <li key={c.id}><Link to={`/child/${c.id}/fees`} className="sheet flex items-center justify-between font-bold text-navy">
                {c.firstName} {c.lastName}<span className={c.balance > 0 ? "text-navy" : "text-good"}>{money(c.balance, c.currency)}</span>
              </Link></li>
            ))}
          </ul>
        )}
      </>
    );
  }
  const child = children.find((c) => c.id === Number(id));
  if (!child) return <Navigate to="/fees" replace />;
  return <Statement child={child} />;
}

function Statement({ child }: { child: Child }) {
  const qc = useQueryClient();
  const account = useQuery({ queryKey: ["account", child.id], queryFn: () => cached<any>(`/players/${child.id}/account`) });
  if (account.isLoading) return <Spinner />;
  if (account.error) return <ErrorNote error={account.error} />;
  const a = account.data;
  return (
    <>
      <div className="rise">
      <PageTitle banner title={`${child.firstName}'s fees`} sub={child.intramuralName} />
      <div className="sheet">
        <p className="text-sm font-semibold text-slate">Balance</p>
        <p className={`display mt-1 text-[3rem] ${a.balance > 0 ? "extrude text-navy" : "extrude-good text-good"}`}>{money(a.balance, a.currency)}</p>
        <p className="text-sm text-slate">Charged {money(a.charged, a.currency)} · Paid {money(a.paid, a.currency)}</p>
        {a.balance > 0 && (
          <Link to={`/register?school=${child.intramuralId}`} className="btn btn-mpesa mt-5 h-12 w-full text-base">
            <Wallet className="h-5 w-5" /> Pay through the registration form
          </Link>
        )}
      </div>

      <SectionTitle>Upcoming balances</SectionTitle>
      {a.upcoming.length ? (
        <ul className="grid gap-3">
          {a.upcoming.map((f: any) => {
            const due = f.amount - f.paid;
            const overdue = f.dueDate && f.dueDate < new Date().toISOString().slice(0, 10);
            return (
              <li key={f.id} className="sheet flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-navy">{f.title}</p>
                  <p className={`text-sm ${overdue ? "font-semibold text-bad" : "text-slate"}`}>
                    {f.kind[0].toUpperCase() + f.kind.slice(1)}{f.dueDate ? ` · ${overdue ? "Overdue since" : "Due"} ${shortDate(f.dueDate)}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold">{money(due, a.currency)}</p>
                  <Link className="text-sm font-semibold text-brand" to={`/register?school=${child.intramuralId}`}>Pay</Link>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>Nothing to pay right now.</Empty>
      )}

      <SectionTitle>Transaction history</SectionTitle>
      {a.payments.length ? (
        <ul className="sheet divide-y divide-line py-1">
          {a.payments.map((p: any) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <p className="text-[15px] font-semibold">{p.method === "mpesa" ? "M-PESA" : p.method === "cash" ? "Cash" : "Bank"}{p.feeTitle ? ` · ${p.feeTitle}` : ""}</p>
                <p className="text-xs text-slate">{dateTime12(p.createdAt)}{p.receipt ? ` · ${p.receipt}` : ""}</p>
              </div>
              <div className="text-right">
                <p className="font-bold">{money(p.amount, p.currency)}</p>
                <span className={`chip ${p.status === "completed" ? "bg-good/15 text-good" : p.status === "pending" ? "bg-warn/15 text-warn" : "bg-bad/10 text-bad"}`}>
                  {p.status === "completed" ? "Paid" : p.status[0].toUpperCase() + p.status.slice(1)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No payments yet.</Empty>
      )}

      <SectionTitle>All charges</SectionTitle>
      <ul className="sheet divide-y divide-line py-1">
        {a.fees.map((f: any) => (
          <li key={f.id} className="flex items-center justify-between gap-3 py-2.5 text-[15px]">
            <span>{f.title}</span><span>{money(f.amount, f.currency)}</span>
          </li>
        ))}
        {a.fees.length === 0 && <li className="py-3 text-slate">No charges yet.</li>}
      </ul>

      <p className="mt-4 text-sm text-slate">Payments go through {child.intramuralName}'s registration form (M-PESA). They show here once the coordinator records them.</p>
      </div>
    </>
  );
}
