-- A mention notification names the message that tagged its recipient, so deleting that reply, or its whole comment,
-- removes the notification and its excerpt too.
ALTER TABLE notifications ADD COLUMN message_id TEXT;
CREATE INDEX notifications_file_thread ON notifications(file_id, thread_id);
