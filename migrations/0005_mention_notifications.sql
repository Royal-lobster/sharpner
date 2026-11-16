-- Members tagged in a comment get a notification saying who tagged them, where and why. Email delivery reads the
-- primary email Clerk reports for the member; notifications go away with the file or the recipient.
ALTER TABLE users ADD COLUMN email TEXT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  thread_number INTEGER NOT NULL,
  page_id TEXT NOT NULL,
  location TEXT NOT NULL,
  -- The tagging message, trimmed; the thread holds the full text.
  excerpt TEXT NOT NULL,
  -- JSON Actor of the member or agent who tagged the recipient.
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_thread ON notifications(user_id, thread_id);
