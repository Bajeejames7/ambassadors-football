import { query, type Queryable, getPool } from "../db.js";

export interface NotificationInput {
  kind: "injury" | "payment" | "schedule" | "approval" | "award" | "privileges" | "general";
  title: string;
  body?: string;
  link?: string;
  urgent?: boolean;
}

export async function notify(userIds: number[], n: NotificationInput, client: Queryable = getPool()): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await query(
    `INSERT INTO notifications (user_id, kind, title, body, link, urgent)
     SELECT unnest($1::int[]), $2, $3, $4, $5, $6`,
    [ids, n.kind, n.title, n.body ?? "", n.link ?? "", n.urgent ?? false],
    client,
  );
}

/** Verified parents of a player. */
export async function parentsOf(playerId: number, client: Queryable = getPool()): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT parent_id AS id FROM parent_children WHERE player_id = $1 AND verified_at IS NOT NULL`,
    [playerId],
    client,
  );
  return rows.map((r) => r.id);
}

/** Verified parents with a child in an intramural. */
export async function parentsInIntramural(intramuralId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT DISTINCT pc.parent_id AS id FROM parent_children pc JOIN players p ON p.id = pc.player_id
      WHERE p.intramural_id = $1 AND pc.verified_at IS NOT NULL`,
    [intramuralId],
  );
  return rows.map((r) => r.id);
}

/** People who can approve parents for an intramural: its admins with the permission, and super admins. */
export async function parentApprovers(intramuralId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT u.id FROM users u WHERE u.role = 'super_admin'
     UNION
     SELECT ui.user_id FROM user_intramurals ui
       JOIN user_permissions up ON up.user_id = ui.user_id AND up.permission = 'parents.approve'
            AND (up.intramural_id IS NULL OR up.intramural_id = ui.intramural_id)
            AND (up.expires_at IS NULL OR up.expires_at > now())
      WHERE ui.intramural_id = $1`,
    [intramuralId],
  );
  return rows.map((r) => r.id);
}
