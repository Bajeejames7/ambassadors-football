import { config } from "../config.js";
import { one, query } from "../db.js";
import { HttpError } from "../auth.js";

/**
 * Per-intramural Airtable link. Each intramural has its own base (and usually
 * its own registration form). The token stays on the server; phones never see it.
 */

export interface AirtableConfig {
  intramuralId: number;
  formUrl: string;
  baseId: string;
  tableName: string;
  viewName: string;
  apiToken: string;
  pushWalkIns: boolean;
  fieldMap: Record<string, string>;
}

export interface AirtablePlayer {
  recordId: string;
  firstName: string;
  lastName: string;
  category: string;
  guardianName: string;
  guardianEmail: string;
  guardianPhone: string;
  dateOfBirth: string | null;
}

export async function loadConfig(intramuralId: number): Promise<AirtableConfig> {
  const row = await one<AirtableConfig>(
    `SELECT intramural_id AS "intramuralId", form_url AS "formUrl", base_id AS "baseId", table_name AS "tableName",
            view_name AS "viewName", api_token AS "apiToken", push_walk_ins AS "pushWalkIns", field_map AS "fieldMap"
       FROM airtable_configs WHERE intramural_id = $1`,
    [intramuralId],
  );
  if (!row) throw new HttpError(400, "Airtable is not set up for this intramural");
  return row;
}

function token(cfg: AirtableConfig): string {
  const t = cfg.apiToken || config.airtableApiKey;
  if (!cfg.baseId || !cfg.tableName || !t) {
    throw new HttpError(400, "Airtable search needs a base ID, table name and access token. An admin can add them in Setup → Airtable.");
  }
  return t;
}

/** Airtable formula string literal. */
function lit(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function field(cfg: AirtableConfig, key: string): string {
  return cfg.fieldMap[key] ?? "";
}

export function mapRecord(cfg: AirtableConfig, rec: { id: string; fields: Record<string, unknown> }): AirtablePlayer {
  const get = (key: string) => {
    const f = field(cfg, key);
    const v = f ? rec.fields[f] : undefined;
    return Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v);
  };
  let firstName = get("firstName");
  let lastName = get("lastName");
  if (!firstName) {
    const full = get("name").trim().split(/\s+/);
    firstName = full[0] ?? "";
    lastName = full.slice(1).join(" ");
  }
  const dob = get("dateOfBirth");
  return {
    recordId: rec.id,
    firstName,
    lastName,
    category: get("category"),
    guardianName: get("guardianName"),
    guardianEmail: get("guardianEmail"),
    guardianPhone: get("guardianPhone"),
    dateOfBirth: /^\d{4}-\d{2}-\d{2}/.test(dob) ? dob.slice(0, 10) : null,
  };
}

async function airtableFetch(cfg: AirtableConfig, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${cfg.baseId}/${encodeURIComponent(cfg.tableName)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token(cfg)}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new HttpError(502, `Airtable: ${body?.error?.message ?? body?.error?.type ?? res.status}`);
  return body;
}

/** Instant player search by name in the intramural's base. */
export async function searchPlayers(intramuralId: number, q: string): Promise<AirtablePlayer[]> {
  const cfg = await loadConfig(intramuralId);
  const nameFields = [field(cfg, "name"), field(cfg, "firstName"), field(cfg, "lastName")].filter(Boolean);
  if (!nameFields.length) throw new HttpError(400, "Tell the app which Airtable field holds the player's name (Setup → Airtable)");
  const haystack = nameFields.map((f) => `{${f}}`).join(` & " " & `);
  const params = new URLSearchParams({ maxRecords: "20", filterByFormula: `SEARCH(LOWER(${lit(q)}), LOWER(${haystack} & ""))` });
  if (cfg.viewName) params.set("view", cfg.viewName);
  const body = await airtableFetch(cfg, `?${params}`);
  return (body.records ?? []).map((r: { id: string; fields: Record<string, unknown> }) => mapRecord(cfg, r));
}

export async function getRecord(intramuralId: number, recordId: string): Promise<AirtablePlayer> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new HttpError(400, "That is not an Airtable record id");
  const cfg = await loadConfig(intramuralId);
  return mapRecord(cfg, await airtableFetch(cfg, `/${recordId}`));
}

/** Copies a walk-in player into Airtable. Returns the new record id. */
export async function pushPlayer(playerId: number): Promise<string> {
  const p = await one(`SELECT * FROM players WHERE id = $1`, [playerId]);
  if (!p) throw new Error("player gone");
  if (p.airtable_record_id) return p.airtable_record_id;
  const cfg = await loadConfig(p.intramural_id);
  const fields: Record<string, string> = {};
  const set = (key: string, value: string) => {
    const f = field(cfg, key);
    if (f && value) fields[f] = value;
  };
  if (field(cfg, "firstName")) {
    set("firstName", p.first_name);
    set("lastName", p.last_name);
  } else set("name", `${p.first_name} ${p.last_name}`.trim());
  set("category", p.category);
  set("guardianName", p.guardian_name);
  set("guardianEmail", p.guardian_email);
  set("guardianPhone", p.guardian_phone);
  set("dateOfBirth", p.date_of_birth ?? "");
  const body = await airtableFetch(cfg, "", { method: "POST", body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  const id = body.records?.[0]?.id as string;
  await query(`UPDATE players SET airtable_record_id = $2 WHERE id = $1`, [playerId, id]);
  return id;
}

/** Works through walk-ins waiting to reach Airtable. Retries with back-off. */
export async function processAirtableOutbox(): Promise<number> {
  const due = await query(`SELECT id, player_id, attempts FROM airtable_outbox WHERE done_at IS NULL AND next_try <= now() AND attempts < 10 ORDER BY id LIMIT 20`);
  let done = 0;
  for (const item of due) {
    try {
      await pushPlayer(item.player_id);
      await query(`UPDATE airtable_outbox SET done_at = now(), attempts = attempts + 1 WHERE id = $1`, [item.id]);
      done += 1;
    } catch (err) {
      const wait = Math.min(2 ** item.attempts, 360); // minutes
      await query(
        `UPDATE airtable_outbox SET attempts = attempts + 1, last_error = $2, next_try = now() + ($3 || ' minutes')::interval WHERE id = $1`,
        [item.id, (err as Error).message.slice(0, 500), String(wait)],
      );
    }
  }
  return done;
}
