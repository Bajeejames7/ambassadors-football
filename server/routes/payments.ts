import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { HttpError, audit, can, me, requirePermission, requirePlayer } from "../auth.js";
import { one, query, transaction } from "../db.js";
import { isDate, mpesaPhone } from "../util.js";
import { metadataValue, onMockCallback, stkPush, stkQuery, type StkCallback } from "../lib/mpesa.js";
import { notify, parentsOf } from "../lib/notify.js";

/** Public: Safaricom calls this. Mounted before sign-in is required. */
export const mpesaCallbackRoutes = Router();
/** Signed-in: statements, fees, starting a payment, checking its status. */
export const paymentRoutes = Router();

// ---- applying a result (callback, mock, or STK query) -----------------------------------------

/**
 * Applies a Daraja result to the matching pending payment. Safe to receive
 * more than once (Daraja retries; a query and a callback can both arrive):
 * only a payment still 'pending' changes.
 */
export async function applyStkResult(cb: StkCallback): Promise<"applied" | "ignored"> {
  const result = await transaction(async (c) => {
    const pay = (
      await c.query(`SELECT id, player_id, payer_id, amount, status FROM payments WHERE checkout_request_id = $1 FOR UPDATE`, [cb.CheckoutRequestID])
    ).rows[0];
    if (!pay || pay.status !== "pending") return null;
    if (Number(cb.ResultCode) === 0) {
      const amount = Number(metadataValue(cb, "Amount"));
      const receipt = String(metadataValue(cb, "MpesaReceiptNumber") ?? "");
      // Never mark paid for less than was asked.
      if (!receipt || !(amount >= Number(pay.amount))) {
        await c.query(`UPDATE payments SET status = 'failed', result_code = $2, result_desc = $3, raw_callback = $4 WHERE id = $1`, [
          pay.id, cb.ResultCode, `Amount or receipt mismatch (${amount})`, JSON.stringify(cb),
        ]);
        return { ...pay, status: "failed" };
      }
      await c.query(
        `UPDATE payments SET status = 'completed', mpesa_receipt = $2, result_code = 0, result_desc = $3, raw_callback = $4, completed_at = now() WHERE id = $1`,
        [pay.id, receipt, cb.ResultDesc, JSON.stringify(cb)],
      );
      return { ...pay, status: "completed", receipt };
    }
    // 1032 = the parent cancelled; anything else = failed (wrong PIN, insufficient funds, timeout 1037…)
    const status = Number(cb.ResultCode) === 1032 ? "cancelled" : "failed";
    await c.query(`UPDATE payments SET status = $2, result_code = $3, result_desc = $4, raw_callback = $5 WHERE id = $1`, [
      pay.id, status, cb.ResultCode, cb.ResultDesc, JSON.stringify(cb),
    ]);
    return { ...pay, status };
  });
  if (!result) return "ignored";
  const player = await one(`SELECT first_name AS "firstName" FROM players WHERE id = $1`, [result.player_id]);
  const people = [...new Set([...(await parentsOf(result.player_id)), ...(result.payer_id ? [result.payer_id] : [])])];
  await notify(people, {
    kind: "payment",
    title:
      result.status === "completed"
        ? `Payment received: KES ${Number(result.amount).toLocaleString()} for ${player?.firstName}`
        : `M-PESA payment ${result.status === "cancelled" ? "cancelled" : "did not go through"}`,
    body: result.status === "completed" ? `M-PESA receipt ${result.receipt}` : cb.ResultDesc,
    link: `/child/${result.player_id}/fees`,
  });
  return "applied";
}

onMockCallback(async (cb) => {
  await applyStkResult(cb);
});

function secretMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.mpesa.callbackSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Daraja callback. Daraja does not sign callbacks, so: the URL carries a
 * secret only Daraja was given, the CheckoutRequestID must match a payment we
 * started, and the amount must match. Always answers 200 so Daraja stops retrying.
 */
mpesaCallbackRoutes.post("/mpesa/callback/:secret", async (req, res) => {
  if (!secretMatches(String(req.params.secret))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const cb = req.body?.Body?.stkCallback as StkCallback | undefined;
  if (cb?.CheckoutRequestID) {
    try {
      await applyStkResult(cb);
    } catch (err) {
      console.error("[mpesa callback]", err);
    }
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ---- statements & fees ----------------------------------------------------------------------

async function statement(playerId: number) {
  const [fees, payments, totals, info] = await Promise.all([
    query(
      `SELECT f.id, f.kind, f.title, f.amount, f.currency, f.due_date AS "dueDate", f.created_at AS "createdAt",
              coalesce((SELECT sum(amount) FROM payments y WHERE y.fee_item_id = f.id AND y.status = 'completed'), 0) AS paid
         FROM fee_items f WHERE f.player_id = $1 ORDER BY coalesce(f.due_date, f.created_at::date) DESC`,
      [playerId],
    ),
    query(
      `SELECT y.id, y.method, y.amount, y.currency, y.status, y.mpesa_receipt AS receipt, y.result_desc AS "resultDesc",
              y.created_at AS "createdAt", y.completed_at AS "completedAt", f.title AS "feeTitle"
         FROM payments y LEFT JOIN fee_items f ON f.id = y.fee_item_id WHERE y.player_id = $1 ORDER BY y.created_at DESC LIMIT 50`,
      [playerId],
    ),
    one(
      `SELECT coalesce((SELECT sum(amount) FROM fee_items WHERE player_id = $1), 0) AS charged,
              coalesce((SELECT sum(amount) FROM payments WHERE player_id = $1 AND status = 'completed'), 0) AS paid`,
      [playerId],
    ),
    one(
      `SELECT c.currency, c.mpesa FROM players p JOIN intramurals i ON i.id = p.intramural_id JOIN countries c ON c.id = i.country_id WHERE p.id = $1`,
      [playerId],
    ),
  ]);
  // Payments not tied to a charge (a parent paying the whole balance) settle the earliest-due charges first.
  let unallocated = Number(totals.paid) - fees.reduce((s, f) => s + Number(f.paid), 0);
  for (const f of [...fees].sort((a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")))) {
    const take = Math.max(0, Math.min(unallocated, Number(f.amount) - Number(f.paid)));
    f.paid = Number(f.paid) + take;
    unallocated -= take;
  }
  const upcoming = fees.filter((f) => Number(f.paid) < Number(f.amount)).sort((a, b) => String(a.dueDate ?? "9").localeCompare(String(b.dueDate ?? "9")));
  return {
    currency: info.currency,
    mpesaEnabled: info.mpesa,
    charged: totals.charged,
    paid: totals.paid,
    balance: totals.charged - totals.paid,
    fees,
    upcoming,
    payments,
  };
}

paymentRoutes.get("/players/:id/account", async (req, res) => {
  const user = me(req);
  const p = await requirePlayer(user, Number(req.params.id));
  if (user.role !== "parent" && !can(user, "payments.manage", p.ref)) throw new HttpError(403, "You need the payments permission to see fees");
  res.json(await statement(p.id));
});

const feeInput = z.object({
  kind: z.enum(["subscription", "tournament", "kit", "other"]),
  title: z.string().trim().min(2).max(120),
  amount: z.number().positive().max(10_000_000),
  dueDate: z.string().refine(isDate).nullable().optional(),
});

paymentRoutes.post("/players/:id/fees", async (req, res) => {
  const user = me(req);
  const p = await requirePlayer(user, Number(req.params.id));
  await requirePermission(user, "payments.manage", p.intramuralId);
  const f = feeInput.parse(req.body);
  const currency = (await one(`SELECT c.currency FROM intramurals i JOIN countries c ON c.id = i.country_id WHERE i.id = $1`, [p.intramuralId])).currency;
  const row = await one(
    `INSERT INTO fee_items (player_id, kind, title, amount, currency, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.id, f.kind, f.title, f.amount, currency, f.dueDate ?? null, user.id],
  );
  await notify(await parentsOf(p.id), {
    kind: "payment",
    title: `New charge: ${f.title} (${currency} ${f.amount.toLocaleString()})`,
    body: f.dueDate ? `Due ${f.dueDate}` : "",
    link: `/child/${p.id}/fees`,
  });
  res.status(201).json(row);
});

/** Bulk-charge every active player in an intramural (e.g. term subscription). */
paymentRoutes.post("/intramurals/:id/fees", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "payments.manage", id);
  const f = feeInput.extend({ category: z.string().max(40).optional() }).parse(req.body);
  const rows = await query(
    `INSERT INTO fee_items (player_id, kind, title, amount, currency, due_date, created_by)
     SELECT p.id, $2, $3, $4, c.currency, $5, $6 FROM players p JOIN intramurals i ON i.id = p.intramural_id JOIN countries c ON c.id = i.country_id
      WHERE p.intramural_id = $1 AND p.active AND ($7::text IS NULL OR p.category = $7) RETURNING player_id`,
    [id, f.kind, f.title, f.amount, f.dueDate ?? null, user.id, f.category ?? null],
  );
  for (const r of rows) {
    await notify(await parentsOf(r.player_id), { kind: "payment", title: `New charge: ${f.title}`, body: f.dueDate ? `Due ${f.dueDate}` : "", link: `/child/${r.player_id}/fees` });
  }
  await audit(user.id, "bulk_fees", { intramuralId: id, count: rows.length, title: f.title, amount: f.amount });
  res.status(201).json({ charged: rows.length });
});

paymentRoutes.post("/players/:id/payments/manual", async (req, res) => {
  const user = me(req);
  const p = await requirePlayer(user, Number(req.params.id));
  await requirePermission(user, "payments.manage", p.intramuralId);
  const input = z.object({ method: z.enum(["cash", "bank"]), amount: z.number().positive(), feeItemId: z.number().int().nullable().optional() }).parse(req.body);
  const row = await one(
    `INSERT INTO payments (player_id, fee_item_id, method, amount, currency, status, recorded_by, completed_at)
     SELECT $1, $2, $3, $4, c.currency, 'completed', $5, now() FROM players p JOIN intramurals i ON i.id = p.intramural_id
       JOIN countries c ON c.id = i.country_id WHERE p.id = $1 RETURNING id`,
    [p.id, input.feeItemId ?? null, input.method, input.amount, user.id],
  );
  await audit(user.id, "manual_payment", { playerId: p.id, ...input });
  res.status(201).json(row);
});

// ---- M-PESA STK push ----------------------------------------------------------------------------

const stkInput = z.object({
  playerId: z.number().int(),
  phone: z.string().min(9).max(20),
  amount: z.number().int("M-PESA amounts are whole shillings").min(1).max(250_000),
  feeItemId: z.number().int().nullable().optional(),
});

paymentRoutes.post("/payments/mpesa", async (req, res) => {
  const user = me(req);
  const input = stkInput.parse(req.body);
  const p = await requirePlayer(user, input.playerId);
  if (user.role !== "parent" && !can(user, "payments.manage", p.ref)) throw new HttpError(403, "Only the child's parent or a payments admin can start a payment");
  const country = await one(`SELECT c.mpesa, c.currency FROM intramurals i JOIN countries c ON c.id = i.country_id WHERE i.id = $1`, [p.intramuralId]);
  if (!country.mpesa) throw new HttpError(400, "M-PESA is not available in this country");
  const phone = mpesaPhone(input.phone);
  if (!phone) throw new HttpError(400, "Enter a Safaricom number like 0712 345 678");
  if (input.feeItemId) {
    const fee = await one(`SELECT id FROM fee_items WHERE id = $1 AND player_id = $2`, [input.feeItemId, p.id]);
    if (!fee) throw new HttpError(400, "That charge is not on this child's account");
  }
  // One prompt at a time: a double tap must not send two PIN prompts.
  const recent = await one(
    `SELECT id FROM payments WHERE player_id = $1 AND status = 'pending' AND method = 'mpesa' AND created_at > now() - interval '60 seconds'`,
    [p.id],
  );
  if (recent) throw new HttpError(409, "A payment prompt was just sent. Check your phone, or wait a minute and try again.", { paymentId: recent.id });

  const payment = await one(
    `INSERT INTO payments (player_id, fee_item_id, payer_id, method, amount, currency, phone, status)
     VALUES ($1,$2,$3,'mpesa',$4,$5,$6,'pending') RETURNING id`,
    [p.id, input.feeItemId ?? null, user.id, input.amount, country.currency, phone],
  );
  try {
    const push = await stkPush({ phone, amount: input.amount, accountReference: `AF${p.id}`, description: "Ambassadors" });
    await query(`UPDATE payments SET merchant_request_id = $2, checkout_request_id = $3 WHERE id = $1`, [payment.id, push.merchantRequestId, push.checkoutRequestId]);
    res.status(201).json({ paymentId: payment.id, status: "pending", message: "Check your phone and enter your M-PESA PIN." });
  } catch (err) {
    await query(`UPDATE payments SET status = 'failed', result_desc = $2 WHERE id = $1`, [payment.id, (err as Error).message]);
    console.error("[mpesa stk]", err);
    throw new HttpError(502, "M-PESA did not accept the request. Try again in a moment.");
  }
});

/** Poll the status. If the callback is late, ask Daraja directly. */
paymentRoutes.get("/payments/:id", async (req, res) => {
  const user = me(req);
  const pay = await one(
    `SELECT id, player_id AS "playerId", amount, currency, status, mpesa_receipt AS receipt, result_desc AS "resultDesc",
            checkout_request_id AS "checkoutRequestId", created_at AS "createdAt"
       FROM payments WHERE id = $1`,
    [Number(req.params.id)],
  );
  if (!pay) throw new HttpError(404, "Not found");
  const p = await requirePlayer(user, pay.playerId);
  if (user.role !== "parent" && !can(user, "payments.manage", p.ref)) throw new HttpError(403, "Not allowed");
  if (pay.status === "pending" && pay.checkoutRequestId && Date.now() - new Date(pay.createdAt).getTime() > 25_000) {
    try {
      const q = await stkQuery(pay.checkoutRequestId);
      if (q.resultCode !== null) {
        // Query results carry no receipt: treat success as completed with a placeholder until the callback fills it.
        await applyStkResult({
          MerchantRequestID: "",
          CheckoutRequestID: pay.checkoutRequestId,
          ResultCode: q.resultCode,
          ResultDesc: q.resultDesc,
          CallbackMetadata: q.resultCode === 0 ? { Item: [{ Name: "Amount", Value: pay.amount }, { Name: "MpesaReceiptNumber", Value: `QRY-${pay.id}` }] } : undefined,
        });
      }
    } catch (err) {
      console.error("[mpesa query]", err);
    }
    const fresh = await one(`SELECT status, mpesa_receipt AS receipt, result_desc AS "resultDesc" FROM payments WHERE id = $1`, [pay.id]);
    Object.assign(pay, fresh);
  }
  const { checkoutRequestId: _c, ...out } = pay;
  res.json(out);
});

/** Payments overview for an intramural (who owes what). */
paymentRoutes.get("/intramurals/:id/payments", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "payments.manage", id);
  const [balances, recent] = await Promise.all([
    query(
      `SELECT p.id AS "playerId", p.first_name || ' ' || p.last_name AS name, p.category,
              coalesce((SELECT sum(amount) FROM fee_items f WHERE f.player_id = p.id), 0) AS charged,
              coalesce((SELECT sum(amount) FROM payments y WHERE y.player_id = p.id AND y.status = 'completed'), 0) AS paid
         FROM players p WHERE p.intramural_id = $1 AND p.active ORDER BY p.first_name`,
      [id],
    ),
    query(
      `SELECT y.id, y.method, y.amount, y.status, y.mpesa_receipt AS receipt, y.created_at AS "createdAt",
              p.first_name || ' ' || p.last_name AS "playerName"
         FROM payments y JOIN players p ON p.id = y.player_id WHERE p.intramural_id = $1 ORDER BY y.created_at DESC LIMIT 50`,
      [id],
    ),
  ]);
  res.json({ balances: balances.map((b) => ({ ...b, balance: b.charged - b.paid })), recent });
});
