-- Agent experience feedback: friction agents hit in Sharpner's own tools. Each row is one report. A report that
-- names an earlier issue (same_as) counts toward it instead of opening a duplicate, so the biggest flaws rank first.
-- Reports belong to the file's workspace (visible to its members), or only to their reporter without a file.
CREATE TABLE agent_friction (
  id TEXT PRIMARY KEY,
  same_as TEXT REFERENCES agent_friction(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  agent TEXT,
  tool TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('minor', 'major', 'blocker')),
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_friction_issue ON agent_friction(same_as);
CREATE INDEX agent_friction_workspace ON agent_friction(workspace_id, created_at);
CREATE INDEX agent_friction_user ON agent_friction(user_id, created_at);
