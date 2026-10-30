-- View-only link sharing. The token is a random capability: anyone holding it can watch the file
-- (never edit it). Regenerating or clearing it revokes every earlier link.
ALTER TABLE files ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX files_share_token ON files(share_token);
