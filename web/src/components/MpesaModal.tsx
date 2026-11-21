import { useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, Smartphone, XCircle } from "lucide-react";
import { Modal, Notice } from "./ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { money } from "../lib/format";

type Stage = { kind: "form" } | { kind: "waiting"; paymentId: number } | { kind: "done"; receipt: string } | { kind: "failed"; reason: string };

/**
 * M-PESA checkout: enter a Safaricom number → the PIN prompt appears on that
 * phone → this sheet follows the payment until M-PESA confirms it.
 */
export function MpesaModal({ open, onClose, playerId, childName, amount: suggested, feeItemId, currency, onPaid }: {
  open: boolean;
  onClose: () => void;
  playerId: number;
  childName: string;
  amount: number;
  feeItemId?: number | null;
  currency: string;
  onPaid: () => void;
}) {
  const { me } = useAuth();
  const [phone, setPhone] = useState(me?.phone?.replace(/^\+254/, "0") ?? "");
  const [amount, setAmount] = useState(String(Math.ceil(suggested)));
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Parents pay exactly what the Super Admin set; only admins can type an amount.
  const fixed = me?.role === "parent";

  useEffect(() => {
    if (open) { setStage({ kind: "form" }); setError(""); setAmount(String(Math.ceil(suggested))); }
  }, [open, suggested]);

  // Follow the payment until it settles (M-PESA usually answers within 10–40 s).
  useEffect(() => {
    if (stage.kind !== "waiting") return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      if (stop) return;
      try {
        const p = await api<{ status: string; receipt: string | null; resultDesc: string }>(`/payments/${stage.paymentId}`);
        if (p.status === "completed") { setStage({ kind: "done", receipt: p.receipt ?? "" }); onPaid(); return; }
        if (p.status === "failed" || p.status === "cancelled") {
          setStage({ kind: "failed", reason: p.status === "cancelled" ? "The payment was cancelled on the phone." : p.resultDesc || "M-PESA did not complete the payment." });
          return;
        }
      } catch { /* keep trying */ }
      if (Date.now() - started > 120_000) {
        setStage({ kind: "failed", reason: "No answer from M-PESA yet. If you paid, it will show on the statement shortly." });
        return;
      }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 2500);
    return () => { stop = true; };
  }, [stage, onPaid]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await api<{ paymentId: number }>("/payments/mpesa", { method: "POST", body: { playerId, phone, ...(fixed ? {} : { amount: Number(amount) }), feeItemId: feeItemId ?? null } });
      setStage({ kind: "waiting", paymentId: r.paymentId });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.paymentId) setStage({ kind: "waiting", paymentId: err.body.paymentId });
      else setError(err instanceof Error ? err.message : "Could not start the payment");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Pay with M-PESA">
      {stage.kind === "form" && (
        <form onSubmit={submit} className="grid gap-4">
          <p className="text-[15px] text-slate">For {childName}. You will get a prompt on your phone to enter your M-PESA PIN.</p>
          <div>
            <label className="label" htmlFor="mp-phone">Safaricom number</label>
            <input id="mp-phone" className="field text-lg" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
          {fixed ? (
            <div className="rounded-xl bg-page p-3">
              <p className="text-sm font-semibold text-slate">Amount due</p>
              <p className="display text-[2rem] text-navy">{money(Number(amount || 0), currency)}</p>
              <p className="text-xs text-slate">Set by Ambassadors Football. It can't be changed here.</p>
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="mp-amount">Amount ({currency})</label>
              <input id="mp-amount" className="field text-lg" inputMode="numeric" pattern="[0-9]*" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} required />
            </div>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
          <button className="btn-primary h-12 bg-[#1f8a3b] text-base hover:bg-[#1a7733]" disabled={busy || !amount}>
            {busy ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Smartphone className="h-5 w-5" />} Send prompt for {money(Number(amount || 0), currency)}
          </button>
        </form>
      )}
      {stage.kind === "waiting" && (
        <div className="py-6 text-center" role="status">
          <Smartphone className="mx-auto h-12 w-12 animate-pulse text-[#1f8a3b]" aria-hidden />
          <p className="condensed mt-4 text-xl text-navy">Check your phone</p>
          <p className="mt-1 text-[15px] text-slate">Enter your M-PESA PIN to pay {money(Number(amount), currency)}. This updates by itself.</p>
        </div>
      )}
      {stage.kind === "done" && (
        <div className="py-6 text-center" role="status">
          <CheckCircle2 className="mx-auto h-12 w-12 text-good" aria-hidden />
          <p className="condensed mt-4 text-xl text-navy">Payment received</p>
          <p className="mt-1 text-[15px] text-slate">M-PESA receipt {stage.receipt}</p>
          <button className="btn-primary mt-5" onClick={onClose}>Done</button>
        </div>
      )}
      {stage.kind === "failed" && (
        <div className="py-6 text-center" role="alert">
          <XCircle className="mx-auto h-12 w-12 text-bad" aria-hidden />
          <p className="condensed mt-4 text-xl text-navy">Payment not completed</p>
          <p className="mt-1 text-[15px] text-slate">{stage.reason}</p>
          <button className="btn-ghost mt-5" onClick={() => setStage({ kind: "form" })}>Try again</button>
        </div>
      )}
    </Modal>
  );
}
