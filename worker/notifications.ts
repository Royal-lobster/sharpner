// Mention notifications: a member tagged in a comment learns who tagged them, where, and what the comment says.
// The inbox lives in D1 so it spans files; email is optional and only sent when Resend is configured.
import type { Actor, CommentMessage, MentionableMember, MentionNotification } from "../shared/types";

export const EXCERPT_LENGTH = 280;
const PAGE_SIZE = 30;

type Recipient = Actor & { email: string | null };

/**
 * Linked members of a workspace, for the comment composer's suggestions. A login is a username, or the member's email
 * when they have none; emails are withheld (null), so teammates never see each other's addresses.
 */
export const workspaceMembers = (env: Env, workspaceId: string) =>
  env.DB.prepare(`SELECT u.id, u.name, CASE WHEN instr(u.login, '@') > 0 THEN NULL ELSE u.login END AS login, u.avatar_url AS avatar
    FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND u.clerk_user_id IS NOT NULL ORDER BY u.name COLLATE NOCASE`)
    .bind(workspaceId).all<MentionableMember>().then((r) => r.results);

/** The requested ids that belong to current members of the workspace. Anyone else is dropped, never notified. */
export async function resolveMentions(env: Env, workspaceId: string, ids: readonly string[] | undefined): Promise<Recipient[]> {
  if (!ids?.length) return [];
  return env.DB.prepare(`SELECT u.id, u.name, u.avatar_url AS avatar, u.email FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND u.clerk_user_id IS NOT NULL AND u.id IN (SELECT value FROM json_each(?))`)
    .bind(workspaceId, JSON.stringify([...new Set(ids)])).all<Recipient>().then((r) => r.results);
}

export const mentionActors = (recipients: readonly Recipient[]): Actor[] => recipients.map(({ id, name, avatar }) => ({ id, name, avatar }));

export type MentionEvent = {
  workspaceId: string; file: { id: string; name: string }; thread: { id: string; number: number; pageId: string };
  location: string; message: CommentMessage; origin: string;
};

/** Who a message should notify: everyone it tags except a member tagging themselves. Their own agent's tag still counts. */
export const mentionRecipients = (recipients: readonly Recipient[], author: Actor) =>
  recipients.filter((r) => author.agent || r.id !== author.id);

/** Stores one notification per tagged member. Returns the recipients so the caller can email them after responding. */
export async function recordMentions(env: Env, event: MentionEvent, recipients: readonly Recipient[]) {
  const targets = mentionRecipients(recipients, event.message.author);
  if (!targets.length) return [];
  const excerpt = event.message.body.slice(0, EXCERPT_LENGTH);
  const actor = JSON.stringify(event.message.author);
  await env.DB.batch(targets.map((r) => env.DB.prepare(`INSERT INTO notifications
    (id, user_id, workspace_id, file_id, thread_id, thread_number, page_id, location, excerpt, actor, created_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(crypto.randomUUID(), r.id, event.workspaceId, event.file.id,
    event.thread.id, event.thread.number, event.thread.pageId, event.location, excerpt, actor, event.message.createdAt)));
  return targets;
}

type NotificationRow = Omit<MentionNotification, "actor"> & { actor: string };

/** The member's newest notifications from workspaces they still belong to, and how many are unread. */
export async function listNotifications(env: Env, userId: string) {
  const visible = `FROM notifications n JOIN files f ON f.id = n.file_id
    JOIN members m ON m.workspace_id = n.workspace_id AND m.user_id = n.user_id WHERE n.user_id = ?`;
  const [rows, unread] = await env.DB.batch([
    env.DB.prepare(`SELECT n.id, n.file_id AS fileId, f.name AS fileName, n.thread_id AS threadId, n.thread_number AS threadNumber,
      n.page_id AS pageId, n.location, n.excerpt, n.actor, n.created_at AS createdAt, n.read_at AS readAt
      ${visible} ORDER BY n.created_at DESC LIMIT ${PAGE_SIZE}`).bind(userId),
    env.DB.prepare(`SELECT count(*) AS n ${visible} AND n.read_at IS NULL`).bind(userId),
  ]);
  const notifications = (rows!.results as NotificationRow[]).map((row) => ({ ...row, actor: JSON.parse(row.actor) as Actor }));
  return { notifications, unread: (unread!.results[0] as { n: number }).n };
}

/** Marks the member's own notifications read: the listed ids, every one for a thread, or all of them. */
export async function markNotificationsRead(env: Env, userId: string, target: { ids?: string[]; threadId?: string }) {
  const now = Date.now();
  if (target.ids) {
    await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
      .bind(now, userId, JSON.stringify(target.ids)).run();
  } else if (target.threadId) {
    await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND thread_id = ?`)
      .bind(now, userId, target.threadId).run();
  } else {
    await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).bind(now, userId).run();
  }
}

/** The link that opens the file on the thread's page with the thread open. */
export const threadLink = (origin: string, fileId: string, pageId: string, threadId: string) =>
  `${origin}/f/${encodeURIComponent(fileId)}?page=${encodeURIComponent(pageId)}&comment=${encodeURIComponent(threadId)}`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function mentionEmail(event: MentionEvent) {
  // An agent's name already reads "Alice's agent".
  const who = event.message.author.name;
  const link = threadLink(event.origin, event.file.id, event.thread.pageId, event.thread.id);
  const subject = `${who} mentioned you in ${event.file.name}`;
  const where = `comment #${event.thread.number} on ${event.location} in ${event.file.name}`;
  const text = `${who} mentioned you in ${where}:\n\n${event.message.body}\n\nOpen the comment: ${link}\n`;
  const html = `<p>${escapeHtml(who)} mentioned you in ${escapeHtml(where)}:</p>
<blockquote style="margin:16px 0;padding:8px 16px;border-left:3px solid #ccc;white-space:pre-wrap">${escapeHtml(event.message.body)}</blockquote>
<p><a href="${escapeHtml(link)}">Open the comment</a></p>`;
  return { subject, text, html };
}

/**
 * Notifies the members a just-posted message tags: an inbox entry for each, then email. The comment is already saved,
 * so failures are logged rather than surfaced; a retry would post the comment twice.
 */
export async function deliverMentions(env: Env, event: Omit<MentionEvent, "location">, recipients: readonly Recipient[], locate: () => Promise<string>) {
  if (!mentionRecipients(recipients, event.message.author).length) return;
  try {
    const full = { ...event, location: await locate() };
    const targets = await recordMentions(env, full, recipients);
    await emailMentions(env, full, targets);
  } catch (error) {
    console.error("Mention notification failed", error instanceof Error ? error.message : String(error));
  }
}

/** Emails each tagged member through Resend. Without RESEND_API_KEY and EMAIL_FROM, the in-app inbox is the only channel. */
export async function emailMentions(env: Env, event: MentionEvent, recipients: readonly Recipient[]) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  const { subject, text, html } = mentionEmail(event);
  const results = await Promise.allSettled(recipients.filter((r) => r.email).map(async (r) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [r.email], subject, text, html }),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  }));
  // The notification is already stored; a failed email is logged, not retried.
  for (const result of results) if (result.status === "rejected") console.warn("Mention email failed", String(result.reason));
}
