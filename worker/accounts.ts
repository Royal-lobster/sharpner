import type { ClerkClient, OrganizationMembership, WebhookEvent } from "@clerk/backend";

export type AccountUser = { id: string; login: string; name: string; avatar_url: string | null };
export type AccountWorkspace = {
  id: string;
  name: string;
  role: "owner" | "member";
  clerkOrganizationId: string;
};

export class AccountError extends Error {
  constructor(public readonly status: 403 | 503, message: string) {
    super(message);
    this.name = "AccountError";
  }
}

const isMissing = (error: unknown) => typeof error === "object" && error !== null && "status" in error && error.status === 404;

/** Close only the affected member's sockets, in bounded batches even for a large workspace. */
async function revokeSockets(env: Env, workspaceIds: string[], userId?: string, reconnect = false) {
  if (!workspaceIds.length) return;
  const files = await env.DB.prepare(`SELECT id FROM files WHERE workspace_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(workspaceIds)).all<{ id: string }>();
  try {
    for (let i = 0; i < files.results.length; i += 4) {
      const results = await Promise.allSettled(files.results.slice(i, i + 4).map(({ id }) =>
        env.FILE_ROOM.get(env.FILE_ROOM.idFromName(id)).revokeAccess(userId, reconnect)));
      if (results.some((result) => result.status === "rejected")) throw new Error("Socket revocation failed");
    }
  } catch {
    throw new AccountError(503, "Workspace connections could not be revoked; please retry");
  }
}

async function unlinkUser(env: Env, clerkUserId: string) {
  const local = await env.DB.prepare(`SELECT id FROM users WHERE clerk_user_id = ?`).bind(clerkUserId).first<{ id: string }>();
  if (!local) return;
  const memberships = await env.DB.prepare(`SELECT workspace_id FROM members WHERE user_id = ?`)
    .bind(local.id).all<{ workspace_id: string }>();
  // Keep the identifying projection until every affected room acknowledges revocation.
  // A retry can then rediscover all rooms even if one RPC is temporarily unavailable.
  await revokeSockets(env, memberships.results.map((m) => m.workspace_id), local.id);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM members WHERE user_id = ?`).bind(local.id),
    env.DB.prepare(`UPDATE users SET clerk_user_id = NULL WHERE id = ?`).bind(local.id),
  ]);
}

async function unlinkOrganization(env: Env, clerkOrganizationId: string) {
  const local = await env.DB.prepare(`SELECT id FROM workspaces WHERE clerk_organization_id = ?`)
    .bind(clerkOrganizationId).first<{ id: string }>();
  if (!local) return;
  await revokeSockets(env, [local.id]);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM members WHERE workspace_id = ?`).bind(local.id),
    env.DB.prepare(`UPDATE workspaces SET clerk_organization_id = NULL WHERE id = ?`).bind(local.id),
  ]);
}

/**
 * Reconcile a verified Clerk user from current Clerk data before authorizing a request.
 * The complete membership fetch must succeed before pruning, so a partial page or outage
 * cannot silently remove memberships. Local IDs survive subsequent profile/name changes.
 */
export async function syncAccount(env: Env, client: ClerkClient, clerkUserId: string): Promise<{ user: AccountUser; workspaces: AccountWorkspace[] }> {
  let clerkUser;
  const memberships: OrganizationMembership[] = [];
  try {
    // These independent reads share one network wait; all pages still finish before any projection write.
    const [user, firstPage] = await Promise.all([
      client.users.getUser(clerkUserId),
      client.users.getOrganizationMembershipList({ userId: clerkUserId, limit: 100, offset: 0 }),
    ]);
    clerkUser = user;
    let page = firstPage;
    for (let offset = 0;;) {
      memberships.push(...page.data);
      offset += page.data.length;
      if (offset >= page.totalCount) break;
      if (!page.data.length) throw new Error("Clerk returned an incomplete membership page");
      page = await client.users.getOrganizationMembershipList({ userId: clerkUserId, limit: 100, offset });
    }
  } catch (error) {
    if (isMissing(error)) {
      await unlinkUser(env, clerkUserId);
      throw new AccountError(403, "This Clerk account is no longer available");
    }
    throw new AccountError(503, "Clerk account information is temporarily unavailable");
  }
  if (clerkUser.id !== clerkUserId) throw new AccountError(503, "Clerk returned a different account");

  const allowed = memberships.filter((m) => m.role === "org:admin" || m.role === "org:member");
  const organizationIds = JSON.stringify(allowed.map((m) => m.organization.id));
  const primaryEmail = clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress;
  const login = clerkUser.username?.trim() || primaryEmail || clerkUser.id;
  const name = [clerkUser.firstName, clerkUser.lastName].map((part) => part?.trim()).filter(Boolean).join(" ") || clerkUser.username?.trim() || primaryEmail?.split("@")[0] || "Member";
  // D1 calls can cross regions. Read both parts of the revocation plan in one trip;
  // the scalar lookup retains previously linked local author IDs.
  const previous = await env.DB.batch([
    env.DB.prepare(`SELECT id FROM users WHERE clerk_user_id = ?`).bind(clerkUserId),
    env.DB.prepare(
      `SELECT workspace_id FROM members WHERE user_id = (SELECT id FROM users WHERE clerk_user_id = ?) AND workspace_id NOT IN (
         SELECT id FROM workspaces WHERE clerk_organization_id IN (SELECT value FROM json_each(?)))`,
    ).bind(clerkUserId, organizationIds),
  ]);
  const oldUser = previous[0]!.results[0] as { id: string } | undefined;
  const removed = previous[1]!.results as { workspace_id: string }[];
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO users (id, login, name, avatar_url, created_at, clerk_user_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(clerk_user_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
    ).bind(clerkUserId, login, name, clerkUser.imageUrl || null, now, clerkUserId),
  ];
  for (const membership of allowed) {
    const org = membership.organization;
    statements.push(
      env.DB.prepare(
        `INSERT INTO workspaces (id, name, created_at, clerk_organization_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(clerk_organization_id) DO UPDATE SET name = excluded.name`,
      ).bind(org.id, org.name, org.createdAt ?? now, org.id),
      env.DB.prepare(
        `INSERT INTO members (workspace_id, user_id, role, created_at)
         SELECT w.id, u.id, ?, ? FROM workspaces w, users u WHERE w.clerk_organization_id = ? AND u.clerk_user_id = ?
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      ).bind(membership.role === "org:admin" ? "owner" : "member", now, org.id, clerkUserId),
    );
  }
  statements.push(env.DB.prepare(
    `DELETE FROM members WHERE user_id = (SELECT id FROM users WHERE clerk_user_id = ?) AND workspace_id NOT IN (
       SELECT id FROM workspaces WHERE clerk_organization_id IN (SELECT value FROM json_each(?)))`,
  ).bind(clerkUserId, organizationIds));
  // Read the reconciled account in the same atomic batch as its writes, avoiding
  // two more network waits before a file request can authorize access.
  statements.push(
    env.DB.prepare(`SELECT id, login, name, avatar_url FROM users WHERE clerk_user_id = ?`).bind(clerkUserId),
    env.DB.prepare(
      `SELECT w.id, w.name, m.role, w.clerk_organization_id AS clerkOrganizationId
       FROM workspaces w JOIN members m ON m.workspace_id = w.id
       WHERE m.user_id = (SELECT id FROM users WHERE clerk_user_id = ?) AND w.clerk_organization_id IS NOT NULL ORDER BY w.created_at, w.id`,
    ).bind(clerkUserId),
  );
  if (oldUser) await revokeSockets(env, removed.map((m) => m.workspace_id), oldUser.id);
  const reconciled = await env.DB.batch(statements);
  const user = (reconciled.at(-2)!.results as AccountUser[])[0];
  if (!user) throw new AccountError(503, "The Clerk account could not be synchronized");
  // A custom role must not retain a previous local owner's access, including an open socket.
  if (allowed.length !== memberships.length) throw new AccountError(403, "Unsupported Clerk organization role");
  return { user, workspaces: reconciled.at(-1)!.results as AccountWorkspace[] };
}

/** Webhook payloads identify what to refresh; current Clerk state decides the resulting access. */
export async function handleAccountWebhook(env: Env, client: ClerkClient, event: WebhookEvent): Promise<void> {
  switch (event.type) {
    case "session.ended":
    case "session.removed":
    case "session.revoked": {
      const clerkUserId = event.data.user_id;
      if (!clerkUserId) throw new AccountError(503, "Clerk session event is missing its user ID");
      const local = await env.DB.prepare(`SELECT id FROM users WHERE clerk_user_id = ?`)
        .bind(clerkUserId).first<{ id: string }>();
      if (!local) return;
      const memberships = await env.DB.prepare(`SELECT workspace_id FROM members WHERE user_id = ?`)
        .bind(local.id).all<{ workspace_id: string }>();
      // Other valid sessions may reconnect; the account and its memberships still exist.
      await revokeSockets(env, memberships.results.map((m) => m.workspace_id), local.id, true);
      return;
    }
    case "user.created":
    case "user.updated":
    case "user.deleted":
    case "organizationMembership.created":
    case "organizationMembership.updated":
    case "organizationMembership.deleted": {
      const userId = event.type.startsWith("user.") ? event.data.id : "public_user_data" in event.data ? event.data.public_user_data?.user_id : undefined;
      if (!userId) throw new AccountError(503, "Clerk event is missing its user ID");
      try {
        await syncAccount(env, client, userId);
      } catch (error) {
        // Removed accounts and unsupported roles have already been revoked by reconciliation.
        if (!(error instanceof AccountError && error.status === 403)) throw error;
      }
      return;
    }
    case "organization.created":
    case "organization.updated":
    case "organization.deleted": {
      if (!event.data.id) throw new AccountError(503, "Clerk event is missing its organization ID");
      try {
        const org = await client.organizations.getOrganization({ organizationId: event.data.id });
        await env.DB.prepare(
          `INSERT INTO workspaces (id, name, created_at, clerk_organization_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(clerk_organization_id) DO UPDATE SET name = excluded.name`,
        ).bind(org.id, org.name, org.createdAt ?? Date.now(), org.id).run();
      } catch (error) {
        if (!isMissing(error)) throw error;
        await unlinkOrganization(env, event.data.id);
      }
      return;
    }
  }
}
