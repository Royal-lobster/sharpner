-- Clerk owns identity and organization membership. These nullable links keep historical
-- files and authors intact; unlinked legacy accounts are never claimed by matching names.
ALTER TABLE users ADD COLUMN clerk_user_id TEXT;
CREATE UNIQUE INDEX users_clerk_user ON users(clerk_user_id);

ALTER TABLE workspaces ADD COLUMN clerk_organization_id TEXT;
CREATE UNIQUE INDEX workspaces_clerk_organization ON workspaces(clerk_organization_id);
