// Shared D1 queries and access checks used by both the REST API and the MCP server.

export type FileRow = { id: string; workspace_id: string; name: string; library_id: string | null; created_at: number; updated_at: number };
export type WorkspaceRow = { id: string; name: string; role: "owner" | "member"; clerkOrganizationId: string };

export const room = (env: Env, fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

export const workspacesFor = (env: Env, userId: string) =>
  env.DB.prepare(
    `SELECT w.id, w.name, m.role, w.clerk_organization_id AS clerkOrganizationId
     FROM workspaces w JOIN members m ON m.workspace_id = w.id JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND w.clerk_organization_id IS NOT NULL AND u.clerk_user_id IS NOT NULL ORDER BY w.created_at`,
  ).bind(userId).all<WorkspaceRow>().then((r) => r.results);

export const workspaceFor = (env: Env, userId: string, workspaceId: string) =>
  env.DB.prepare(`SELECT w.id, w.name, m.role, w.clerk_organization_id AS clerkOrganizationId
    FROM workspaces w JOIN members m ON m.workspace_id = w.id JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND w.id = ? AND w.clerk_organization_id IS NOT NULL AND u.clerk_user_id IS NOT NULL`)
    .bind(userId, workspaceId).first<WorkspaceRow>();

const FILE_COLS = `f.id, f.workspace_id, f.name, f.library_id, f.created_at, f.updated_at`;

/** Returns the file only if the user is a member of its workspace. */
export const fileFor = (env: Env, userId: string, fileId: string) =>
  env.DB.prepare(`SELECT ${FILE_COLS} FROM files f JOIN workspaces w ON w.id = f.workspace_id
    JOIN members m ON m.workspace_id = f.workspace_id AND m.user_id = ? JOIN users u ON u.id = m.user_id
    WHERE f.id = ? AND w.clerk_organization_id IS NOT NULL AND u.clerk_user_id IS NOT NULL`)
    .bind(userId, fileId).first<FileRow>();

export const filesFor = (env: Env, userId: string) =>
  env.DB.prepare(`SELECT ${FILE_COLS} FROM files f JOIN workspaces w ON w.id = f.workspace_id
    JOIN members m ON m.workspace_id = f.workspace_id AND m.user_id = ? JOIN users u ON u.id = m.user_id
    WHERE w.clerk_organization_id IS NOT NULL AND u.clerk_user_id IS NOT NULL ORDER BY f.updated_at DESC`)
    .bind(userId).all<FileRow>().then((r) => r.results);

/** A file shared by link, with its workspace's name for the viewer's header. */
export const sharedFile = (env: Env, token: string) =>
  env.DB.prepare(`SELECT f.id, f.name, w.name AS workspace FROM files f JOIN workspaces w ON w.id = f.workspace_id
    WHERE f.share_token = ? AND w.clerk_organization_id IS NOT NULL`)
    .bind(token).first<{ id: string; name: string; workspace: string }>();

/** 256 random bits, base64url: unguessable, and short enough to paste. */
export const newShareToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function createFile(env: Env, userId: string, workspaceId: string, name: string, libraryId: string | null = null) {
  const now = Date.now();
  const file: FileRow = { id: crypto.randomUUID(), workspace_id: workspaceId, name: name.trim().slice(0, 120) || "Untitled", library_id: libraryId, created_at: now, updated_at: now };
  // Reject an invalid library before creating anything, so retries cannot leave empty files behind.
  await checkLibrary(env, file, libraryId);
  await env.DB.prepare(`INSERT INTO files (id, workspace_id, name, library_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(file.id, workspaceId, file.name, libraryId, userId, now, now).run();
  if (libraryId) await room(env, file.id).setLibrary(file.id, libraryId);
  return file;
}

/** Makes `file` use another file of the same workspace as its library (or none). */
export async function setLibrary(env: Env, file: FileRow, libraryId: string | null) {
  await checkLibrary(env, file, libraryId);
  await env.DB.prepare(`UPDATE files SET library_id = ? WHERE id = ?`).bind(libraryId, file.id).run();
  await room(env, file.id).setLibrary(file.id, libraryId);
}

async function checkLibrary(env: Env, file: FileRow, libraryId: string | null) {
  if (libraryId) {
    if (libraryId === file.id) throw new Error("A file can't be its own library");
    const lib = await env.DB.prepare(`SELECT workspace_id FROM files WHERE id = ?`).bind(libraryId).first<{ workspace_id: string }>();
    if (lib?.workspace_id !== file.workspace_id) throw new Error("The library must be a file in the same workspace");
  }
}

export const MAX_UPLOAD = 25 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" };

/** Stores an upload under the file's prefix in R2 and returns its public path. */
export async function putFile(env: Env, fileId: string, body: ReadableStream | ArrayBuffer | Uint8Array, contentType: string) {
  const key = `${fileId}/u/${crypto.randomUUID()}.${EXT[contentType] ?? "bin"}`;
  await env.FILES.put(key, body, { httpMetadata: { contentType } });
  return `/a/${key}`;
}
