import { one, query } from "../db.js";

/**
 * Payment details the Super Admin sets for each school or club. The term fee
 * becomes one charge per child (fee_items.term_key = term label), so the
 * existing statement, balance and M-PESA flows all use it.
 */

export interface PaymentConfig {
  intramuralId: number;
  termLabel: string;
  feeAmount: number | null;
  method: "paybill" | "till";
  paybill: string;
  till: string;
  accountRefFormat: string;
  deadline: string | null;
  instructions: string;
  updatedAt?: string;
}

export const CONFIG_FIELDS = `
  intramural_id AS "intramuralId", term_label AS "termLabel", fee_amount AS "feeAmount", method, paybill, till,
  account_ref_format AS "accountRefFormat", to_char(deadline, 'YYYY-MM-DD') AS deadline, instructions, updated_at AS "updatedAt"`;

export async function paymentConfig(intramuralId: number): Promise<PaymentConfig | null> {
  return (await one<PaymentConfig>(`SELECT ${CONFIG_FIELDS} FROM payment_configs WHERE intramural_id = $1`, [intramuralId])) ?? null;
}

/** Make sure every active child in these schools carries this term's fee, at the current amount. */
export async function ensureTermFees(intramuralIds: number[]): Promise<void> {
  if (!intramuralIds.length) return;
  await query(
    `INSERT INTO fee_items (player_id, kind, title, amount, currency, due_date, term_key)
     SELECT p.id, 'subscription', pc.term_label, pc.fee_amount, c.currency, pc.deadline, pc.term_label
       FROM payment_configs pc
       JOIN players p ON p.intramural_id = pc.intramural_id AND p.active
       JOIN intramurals i ON i.id = pc.intramural_id JOIN countries c ON c.id = i.country_id
      WHERE pc.intramural_id = ANY($1::int[]) AND pc.fee_amount IS NOT NULL AND pc.term_label <> ''
     ON CONFLICT (player_id, term_key) WHERE term_key IS NOT NULL
     DO UPDATE SET amount = EXCLUDED.amount, due_date = EXCLUDED.due_date, title = EXCLUDED.title`,
    [intramuralIds],
  );
}

/** M-PESA account reference from the Super Admin's format: {CODE}, {CHILD}, {ID}. Daraja allows 12 characters. */
export function accountReference(format: string, p: { id: number; firstName: string; shortCode: string }): string {
  const ref = (format || "{CODE}-{CHILD}")
    .replaceAll("{CODE}", p.shortCode)
    .replaceAll("{CHILD}", p.firstName)
    .replaceAll("{ID}", String(p.id))
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
  return ref.slice(0, 12) || `AF${p.id}`;
}

/** What a parent sees on the payment card for one child. */
export async function paymentCard(playerId: number) {
  const p = await one(
    `SELECT p.id, p.first_name AS "firstName", p.intramural_id AS "intramuralId", i.short_code AS "shortCode", c.currency, c.mpesa
       FROM players p JOIN intramurals i ON i.id = p.intramural_id JOIN countries c ON c.id = i.country_id WHERE p.id = $1`,
    [playerId],
  );
  const config = await paymentConfig(p.intramuralId);
  const totals = await one(
    `SELECT coalesce((SELECT sum(amount) FROM fee_items WHERE player_id = $1), 0) AS charged,
            coalesce((SELECT sum(amount) FROM payments WHERE player_id = $1 AND status = 'completed'), 0) AS paid,
            (SELECT count(*) FROM payments WHERE player_id = $1 AND status = 'pending' AND created_at > now() - interval '10 minutes') AS pending`,
    [playerId],
  );
  const termFee = config?.termLabel
    ? await one(
        `SELECT f.id, f.amount FROM fee_items f WHERE f.player_id = $1 AND f.term_key = $2`,
        [playerId, config.termLabel],
      )
    : null;
  const balance = Math.max(0, Number(totals.charged) - Number(totals.paid));
  const status = Number(totals.charged) === 0 ? "none" : balance <= 0 ? "paid" : Number(totals.pending) > 0 ? "pending" : Number(totals.paid) > 0 ? "partial" : "unpaid";
  return {
    currency: p.currency,
    mpesaEnabled: p.mpesa,
    termLabel: config?.termLabel ?? "",
    termFee: termFee ? Number(termFee.amount) : null,
    deadline: config?.deadline ?? null,
    method: config?.method ?? "paybill",
    paybill: config?.paybill ?? "",
    till: config?.till ?? "",
    accountReference: accountReference(config?.accountRefFormat ?? "", p),
    instructions: config?.instructions ?? "",
    charged: Number(totals.charged),
    paid: Number(totals.paid),
    balance,
    status,
  };
}
