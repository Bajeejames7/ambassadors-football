import { Router } from "express";
import { z } from "zod";
import { COACH_GRANTABLE, HttpError, audit, can, intramuralRef, me, requirePermission, requireSee, requireStaff } from "../auth.js";
import { one, query, transaction } from "../db.js";
import { normalizeEmail } from "../util.js";
import { notify } from "../lib/notify.js";

/**
 * People for one intramural, as an Admin/Coordinator sees them: the coaches
 * assigned there, their field privileges, and parents waiting for approval.
 */
export const peopleRoutes = Router();

peopleRoutes.get("/intramurals/:id/people", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const id = Number(req.params.id);
  await requireSee(user, id);
  const staff = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.role,
            coalesce((SELECT json_agg(json_build_object('permission', permission, 'intramuralId', intramural_id, 'expiresAt', expires_at))
                        FROM user_permissions up WHERE up.user_id = u.id AND (up.intramural_id IS NULL OR up.intramural_id = $1)
                         AND (up.expires_at IS NULL OR up.expires_at > now())), '[]') AS grants
       FROM user_intramurals ui JOIN users u ON u.id = ui.user_id
      WHERE ui.intramural_id = $1 AND u.status = 'active'
      ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`,
    [id],
  );
  // Contact details only for people who manage coaches.
  const ref = await intramuralRef(id);
  const showContacts = can(user, "roles.assign", ref);
  res.json(staff.map((s) => (showContacts ? s : { ...s, email: undefined, phone: undefined })));
});

/** Coaches in this intramural's country not yet assigned here (to add them). */
peopleRoutes.get("/intramurals/:id/available-coaches", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  const ref = await requirePermission(user, "roles.assign", id);
  res.json(
    await query(
      `SELECT u.id, u.name, u.email FROM users u
        WHERE u.role IN ('coach','admin') AND u.status = 'active' AND u.country_id = $2
          AND NOT EXISTS (SELECT 1 FROM user_intramurals ui WHERE ui.user_id = u.id AND ui.intramural_id = $1)
        ORDER BY u.name`,
      [id, ref.countryId],
    ),
  );
});

peopleRoutes.post("/intramurals/:id/coaches", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  const ref = await requirePermission(user, "roles.assign", id);
  const input = z.object({ userId: z.number().int().optional(), email: z.string().optional() }).parse(req.body);
  const target = input.userId
    ? await one(`SELECT id, role, country_id AS "countryId", name FROM users WHERE id = $1`, [input.userId])
    : await one(`SELECT id, role, country_id AS "countryId", name FROM users WHERE lower(email) = $1`, [normalizeEmail(input.email ?? "")]);
  if (!target) throw new HttpError(404, "No coach account with that email. Ask them to sign up first.");
  if (target.role === "parent") throw new HttpError(400, "That is a parent account");
  // Country isolation: admins can only bring in coaches from the same country.
  if (!user.isSuperAdmin && target.countryId !== ref.countryId) throw new HttpError(403, "That coach is registered in another country. Ask a Super Admin.");
  await query(`INSERT INTO user_intramurals (user_id, intramural_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [target.id, id]);
  const name = (await one(`SELECT name FROM intramurals WHERE id = $1`, [id])).name;
  await notify([target.id], { kind: "privileges", title: `You were added to ${name}`, link: `/i/${id}` });
  await audit(user.id, "coach_assigned", { userId: target.id, intramuralId: id });
  res.json({ ok: true });
});

peopleRoutes.delete("/intramurals/:id/coaches/:userId", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "roles.assign", id);
  const targetId = Number(req.params.userId);
  const target = await one(`SELECT role FROM users WHERE id = $1`, [targetId]);
  if (!target) throw new HttpError(404, "That person does not exist");
  if (!user.isSuperAdmin && target.role !== "coach") throw new HttpError(403, "Only a Super Admin can remove an admin");
  await transaction(async (c) => {
    await c.query(`DELETE FROM user_intramurals WHERE user_id = $1 AND intramural_id = $2`, [targetId, id]);
    await c.query(`DELETE FROM user_permissions WHERE user_id = $1 AND intramural_id = $2`, [targetId, id]);
  });
  await audit(user.id, "coach_removed", { userId: targetId, intramuralId: id });
  res.json({ ok: true });
});

const privilegesInput = z.object({
  privileges: z
    .array(
      z.object({
        permission: z.enum(COACH_GRANTABLE),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
      }),
    )
    .max(COACH_GRANTABLE.length),
});

/**
 * Field privileges for one coach in one intramural (e.g. take attendance until
 * Friday). An admin can only grant what they hold themselves, and never Setup
 * or delete controls (those are not grantable at all).
 */
peopleRoutes.put("/intramurals/:id/coaches/:userId/privileges", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  const ref = await requirePermission(user, "privileges.grant", id);
  const targetId = Number(req.params.userId);
  const { privileges } = privilegesInput.parse(req.body);
  const target = await one(
    `SELECT u.role FROM users u JOIN user_intramurals ui ON ui.user_id = u.id AND ui.intramural_id = $2 WHERE u.id = $1`,
    [targetId, id],
  );
  if (!target) throw new HttpError(404, "That coach is not assigned to this intramural");
  if (target.role !== "coach") throw new HttpError(400, "Field privileges are for coaches. Admin permissions are set in Creator Control.");
  for (const p of privileges) {
    if (!can(user, p.permission, ref)) throw new HttpError(403, `You cannot grant "${p.permission}" because you do not hold it`);
  }
  await transaction(async (c) => {
    await c.query(`DELETE FROM user_permissions WHERE user_id = $1 AND intramural_id = $2 AND permission = ANY($3)`, [
      targetId, id, [...COACH_GRANTABLE],
    ]);
    for (const p of privileges) {
      await c.query(
        `INSERT INTO user_permissions (user_id, permission, intramural_id, granted_by, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [targetId, p.permission, id, user.id, p.expiresAt ?? null],
      );
    }
  });
  await notify([targetId], {
    kind: "privileges",
    title: privileges.length ? "Your field privileges changed" : "Your field privileges were removed",
    body: privileges.map((p) => p.permission.replace(".", " ")).join(", "),
  });
  await audit(user.id, "privileges_set", { userId: targetId, intramuralId: id, privileges });
  res.json({ ok: true });
});

// ---- parent approvals ------------------------------------------------------------------------

/** Parents with unverified links to children in this intramural. */
peopleRoutes.get("/intramurals/:id/parent-requests", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "parents.approve", id);
  res.json(
    await query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at AS "createdAt",
              json_agg(json_build_object('playerId', p.id, 'name', p.first_name || ' ' || p.last_name,
                       'guardianEmail', p.guardian_email, 'guardianPhone', p.guardian_phone,
                       'verified', pc.verified_at IS NOT NULL) ORDER BY p.first_name) AS children
         FROM users u JOIN parent_children pc ON pc.parent_id = u.id JOIN players p ON p.id = pc.player_id
        WHERE u.role = 'parent' AND p.intramural_id = $1
        GROUP BY u.id
        HAVING bool_or(pc.verified_at IS NULL) OR u.status = 'pending'
        ORDER BY u.created_at`,
      [id],
    ),
  );
});

/** Pending parents in the same country with no suggested children (to link by hand). */
peopleRoutes.get("/intramurals/:id/unlinked-parents", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  const ref = await requirePermission(user, "parents.approve", id);
  res.json(
    await query(
      `SELECT u.id, u.name, u.email, u.phone, u.created_at AS "createdAt" FROM users u
        WHERE u.role = 'parent' AND u.status = 'pending' AND u.country_id = $1
          AND NOT EXISTS (SELECT 1 FROM parent_children pc WHERE pc.parent_id = u.id)
        ORDER BY u.created_at`,
      [ref.countryId],
    ),
  );
});

const linkInput = z.object({ parentId: z.number().int(), playerIds: z.array(z.number().int()).min(1).max(20) });

/** Confirm (or create) parent↔child links and activate the parent account. */
peopleRoutes.post("/parent-links/approve", async (req, res) => {
  const user = me(req);
  const input = linkInput.parse(req.body);
  const players = await query<{ id: number; intramuralId: number; firstName: string }>(
    `SELECT id, intramural_id AS "intramuralId", first_name AS "firstName" FROM players WHERE id = ANY($1)`,
    [input.playerIds],
  );
  if (players.length !== input.playerIds.length) throw new HttpError(404, "One of those players does not exist");
  for (const p of players) await requirePermission(user, "parents.approve", p.intramuralId);
  const parent = await one(`SELECT id, role, country_id AS "countryId" FROM users WHERE id = $1`, [input.parentId]);
  if (!parent || parent.role !== "parent") throw new HttpError(404, "That parent account does not exist");
  for (const p of players) {
    const ref = await intramuralRef(p.intramuralId);
    if (!user.isSuperAdmin && ref.countryId !== parent.countryId) throw new HttpError(403, "That parent is registered in another country");
  }
  await transaction(async (c) => {
    for (const p of players) {
      await c.query(
        `INSERT INTO parent_children (parent_id, player_id, verified_by, verified_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (parent_id, player_id) DO UPDATE SET verified_by = $3, verified_at = now()`,
        [input.parentId, p.id, user.id],
      );
    }
    await c.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending'`, [input.parentId]);
  });
  await notify([input.parentId], {
    kind: "approval",
    title: "Your parent account is ready",
    body: `You can now follow ${players.map((p) => p.firstName).join(" and ")}'s progress.`,
    link: "/",
  });
  await audit(user.id, "parent_approved", input);
  res.json({ ok: true });
});

/** Remove a parent↔child link (wrong match). */
peopleRoutes.post("/parent-links/remove", async (req, res) => {
  const user = me(req);
  const input = z.object({ parentId: z.number().int(), playerId: z.number().int() }).parse(req.body);
  const p = await one(`SELECT intramural_id AS "intramuralId" FROM players WHERE id = $1`, [input.playerId]);
  if (!p) throw new HttpError(404, "That player does not exist");
  await requirePermission(user, "parents.approve", p.intramuralId);
  await query(`DELETE FROM parent_children WHERE parent_id = $1 AND player_id = $2`, [input.parentId, input.playerId]);
  await audit(user.id, "parent_link_removed", input);
  res.json({ ok: true });
});
