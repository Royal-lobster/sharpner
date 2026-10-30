import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frictionReports, listFriction, reportFriction } from "./friction";

/** D1's small async surface over real SQLite. */
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...this.values); return { success: true }; }
}

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });

/** Alice and Bob share Acme; Carol works alone in her own workspace. */
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0001_init.sql", "0002_clerk_accounts.sql", "0003_file_share_links.sql", "0004_agent_friction.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  db.exec(`
    INSERT INTO users (id, login, name, created_at) VALUES ('alice', 'alice', 'Alice', 0), ('bob', 'bob', 'Bob', 0), ('carol', 'carol', 'Carol', 0);
    INSERT INTO workspaces (id, name, created_at) VALUES ('acme', 'Acme', 0), ('solo', 'Solo', 0);
    INSERT INTO members VALUES ('acme', 'alice', 'owner', 0), ('acme', 'bob', 'member', 0), ('solo', 'carol', 'owner', 0);
    INSERT INTO files (id, workspace_id, name, created_by, created_at, updated_at) VALUES ('app', 'acme', 'App', 'alice', 0, 0);
  `);
  const env = { DB: { prepare: (sql: string) => new Statement(db, sql) } } as unknown as Env;
  let now = 1_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  const report = (userId: string, summary: string, patch: Partial<Parameters<typeof reportFriction>[1]> = {}) => {
    vi.setSystemTime(now += 10);
    const acme = userId !== "carol";
    return reportFriction(env, { userId, workspaceId: acme ? "acme" : "solo", fileId: acme ? "app" : null, summary, severity: "minor", ...patch });
  };
  return { db, env, report };
}

describe("agent friction reports", () => {
  it("ranks issues by the summed weight of their reports, counting repeats instead of duplicating them", async () => {
    const { env, report } = fixture();
    const overflow = await report("alice", "get_file overflows the context", { severity: "major", tool: "get_file", agent: "Claude Code" });
    const naming = await report("alice", "Section names are truncated", { severity: "minor" });
    const blocker = await report("bob", "Cannot move a section to another page", { severity: "blocker" });
    await report("bob", "Same overflow on a smaller file", { severity: "major", sameAs: overflow.id });
    // A report naming a repeat still joins the original issue.
    const repeat = await report("alice", "Still overflows", { severity: "minor", sameAs: overflow.id });
    expect(repeat.issueId).toBe(overflow.id);
    const third = await report("bob", "Again", { sameAs: repeat.id });
    expect(third.issueId).toBe(overflow.id);

    const { total, nextOffset, issues } = await listFriction(env, "alice", 20, 0);
    expect(total).toBe(3);
    expect(nextOffset).toBeNull();
    expect(issues.map((i) => [i.id, i.reports, i.weight, i.severity])).toEqual([
      [overflow.id, 4, 3 + 3 + 1 + 1, "major"],
      [blocker.id, 1, 5, "blocker"],
      [naming.id, 1, 1, "minor"],
    ]);
    expect(issues[0]).toMatchObject({ summary: "get_file overflows the context", tool: "get_file", firstReportedAt: 1_010, lastReportedAt: 1_060 });
    expect(await listFriction(env, "alice", 1, 1)).toMatchObject({ total: 3, nextOffset: 2, issues: [{ id: blocker.id }] });

    const reports = await frictionReports(env, "bob", overflow.id);
    expect(reports.map((r) => r.summary)).toEqual(["Again", "Still overflows", "Same overflow on a smaller file", "get_file overflows the context"]);
    expect(reports.at(-1)).toMatchObject({ issueId: overflow.id, agent: "Claude Code", fileId: "app", severity: "major" });
  });

  it("shares reports with the file's workspace only, keeps file-less reports private, and refuses unseen issues", async () => {
    const { env, report } = fixture();
    const acme = await report("alice", "Acme friction");
    const privateNote = await report("alice", "No file", { workspaceId: null, fileId: null });
    const solo = await report("carol", "Solo friction");
    expect((await listFriction(env, "bob", 20, 0)).issues.map((i) => i.id)).toEqual([acme.id]);
    expect((await listFriction(env, "alice", 20, 0)).issues.map((i) => i.id).sort()).toEqual([acme.id, privateNote.id].sort());
    expect((await listFriction(env, "carol", 20, 0)).issues.map((i) => i.id)).toEqual([solo.id]);
    await expect(report("carol", "Me too", { sameAs: acme.id })).rejects.toThrow("not found");
    await expect(frictionReports(env, "carol", acme.id)).rejects.toThrow("not found");
  });

  it("removes a workspace's reports with it and keeps reports when their file is deleted", async () => {
    const { db, env, report } = fixture();
    await report("alice", "Acme friction");
    db.exec("DELETE FROM files WHERE id = 'app'");
    expect((await listFriction(env, "alice", 20, 0)).issues).toHaveLength(1);
    db.exec("DELETE FROM workspaces WHERE id = 'acme'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_friction").get()).toEqual({ n: 0 });
  });
});
