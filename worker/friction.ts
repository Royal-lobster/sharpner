// The agent-experience complaint box: agents report friction in Sharpner's tools, and repeat reports of the same
// issue add weight to it, so the biggest flaws rank first. Stored in D1 (see migrations/0004_agent_friction.sql).

export const SEVERITIES = ["minor", "major", "blocker"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Ranking weight per report: one blocker outweighs a few minor annoyances. */
export const SEVERITY_WEIGHT: Record<Severity, number> = { minor: 1, major: 3, blocker: 5 };

export type FrictionInput = {
  userId: string; workspaceId: string | null; fileId: string | null;
  summary: string; details?: string; severity: Severity; tool?: string; agent?: string; sameAs?: string;
};
export type FrictionReport = {
  id: string; issueId: string; severity: Severity; summary: string; details: string;
  tool: string | null; agent: string | null; fileId: string | null; createdAt: number;
};
export type FrictionIssue = {
  id: string; summary: string; details: string; tool: string | null; severity: Severity;
  reports: number; weight: number; firstReportedAt: number; lastReportedAt: number;
};

/** Reports the caller may see: their own, and any from workspaces they belong to. */
const VISIBLE = `WITH visible AS (
  SELECT * FROM agent_friction WHERE user_id = ?1 OR workspace_id IN (SELECT workspace_id FROM members WHERE user_id = ?1))`;
const WEIGHT = Object.entries(SEVERITY_WEIGHT).map(([s, w]) => `WHEN '${s}' THEN ${w}`).join(" ");

export class FrictionError extends Error {}

/** Stores a report. With `sameAs`, it counts toward that issue (or the issue it already belongs to). */
export async function reportFriction(env: Env, input: FrictionInput): Promise<{ id: string; issueId: string }> {
  let issueId: string | null = null;
  if (input.sameAs) {
    const target = await env.DB.prepare(`${VISIBLE} SELECT id, same_as AS sameAs FROM visible WHERE id = ?2`)
      .bind(input.userId, input.sameAs).first<{ id: string; sameAs: string | null }>();
    if (!target) throw new FrictionError(`Friction report ${input.sameAs} not found`);
    issueId = target.sameAs ?? target.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_friction (id, same_as, user_id, workspace_id, file_id, agent, tool, severity, summary, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, issueId, input.userId, input.workspaceId, input.fileId, input.agent?.trim() || null, input.tool?.trim() || null,
    input.severity, input.summary.trim(), input.details?.trim() ?? "", Date.now()).run();
  return { id, issueId: issueId ?? id };
}

/** Issues the caller can see, heaviest first: the sum of each visible report's severity weight. */
export async function listFriction(env: Env, userId: string, limit: number, offset: number) {
  const { results } = await env.DB.prepare(`${VISIBLE}
    SELECT i.id, i.summary, i.details, i.tool, COUNT(r.id) AS reports,
      SUM(CASE r.severity ${WEIGHT} END) AS weight, MAX(CASE r.severity ${WEIGHT} END) AS worst,
      MIN(r.created_at) AS firstReportedAt, MAX(r.created_at) AS lastReportedAt, COUNT(*) OVER () AS total
    FROM visible i JOIN visible r ON r.id = i.id OR r.same_as = i.id
    WHERE i.same_as IS NULL
    GROUP BY i.id ORDER BY weight DESC, lastReportedAt DESC, i.id LIMIT ?2 OFFSET ?3`,
  ).bind(userId, limit, offset).all<Omit<FrictionIssue, "severity"> & { worst: number; total: number }>();
  const total = results[0]?.total ?? 0;
  const issues: FrictionIssue[] = results.map(({ worst, total: _total, ...issue }) => ({
    ...issue, severity: SEVERITIES.find((s) => SEVERITY_WEIGHT[s] === worst) ?? "minor",
  }));
  return { total, nextOffset: offset + limit < total ? offset + limit : null, issues };
}

/** Every visible report of one issue, newest first. */
export async function frictionReports(env: Env, userId: string, issueId: string): Promise<FrictionReport[]> {
  const { results } = await env.DB.prepare(`${VISIBLE}
    SELECT id, coalesce(same_as, id) AS issueId, severity, summary, details, tool, agent, file_id AS fileId, created_at AS createdAt
    FROM visible WHERE id = ?2 OR same_as = ?2 ORDER BY created_at DESC, id`,
  ).bind(userId, issueId).all<FrictionReport>();
  if (!results.length) throw new FrictionError(`Friction issue ${issueId} not found`);
  return results;
}
