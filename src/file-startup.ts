import type { FileInfo, User, Workspace } from "./api";
import { Room } from "./room";
import { isSessionPrincipal, samePrincipal, type SessionPrincipal } from "../shared/session-principal";

export type FileMeta = {
  user: User; file: FileInfo; workspace: Workspace; files: { id: string; name: string }[]; shareToken: string | null;
  principal?: SessionPrincipal | null; sessionExpiresAt?: number;
};
type OpenedFile = { room: Room; meta: FileMeta };

async function readMetadata(response: Response): Promise<FileMeta> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error("Startup metadata too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as FileMeta;
  } finally { await reader.cancel(); }
}

let pending: FileStartup | null = null;

/** At most one direct-file attempt, owned by the route until the editor claims it. */
export function prepareFileStartup(fileId: string): () => void {
  pending?.dispose();
  pending = null;
  if (!document.cookie.split(";").some((part) => /^\s*__session=.+/.test(part))) return () => {};
  pending = new FileStartup(fileId);
  const lease = pending.lease;
  return () => {
    // A claimed room belongs to Editor, including its async completion and cleanup.
    // Retain only the ticket, so the parent cannot keep an adopted snapshot alive after sign-out.
    if (pending?.lease === lease) { const startup = pending; pending = null; startup.dispose(); }
  };
}

export function cancelFileStartup() {
  pending?.dispose();
  pending = null;
}

export function claimFileStartup(fileId: string, identity: SessionPrincipal): FileStartup | null {
  const startup = pending;
  pending = null;
  if (!startup || startup.fileId !== fileId) { startup?.dispose(); return null; }
  startup.claim(identity);
  return startup;
}

/** No React state or raw-message queue: Room retains its usual snapshot within a startup byte budget. */
class FileStartup {
  readonly lease = Symbol("file-startup");
  readonly ready: Promise<OpenedFile | null>;
  private resolve!: (opened: OpenedFile | null) => void;
  private controller = new AbortController();
  private room: Room;
  private meta: FileMeta | null = null;
  private identity: SessionPrincipal | null = null;
  private disposed = false;
  private adopted = false;
  private unsubscribe: () => void;
  private deadline: ReturnType<typeof setTimeout>;
  private expiresAt = Date.now() + 5_000;

  constructor(readonly fileId: string) {
    this.ready = new Promise((resolve) => { this.resolve = resolve; });
    this.room = new Room(fileId, null, { pendingIdentity: true });
    this.unsubscribe = this.room.subscribe(() => this.check());
    // Finite lifetime even if Clerk never loads or either server request stalls.
    this.deadline = setTimeout(() => this.dispose(), 5_000);
    // api() deliberately cancels across token-getter replacement. This request uses only ambient
    // cookies, remains abortable, and can only be consumed after three-way identity verification.
    void fetch(`/api/files/${fileId}`, { credentials: "same-origin", cache: "no-store", signal: this.controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Startup unavailable");
        // Also bound speculative HTTP data before parsing (the response is ordinary small metadata).
        const data = await readMetadata(response);
        if (this.disposed) return;
        if (data.file?.id !== fileId || !data.user?.id || !data.workspace?.clerkOrganizationId
          || data.file.workspace_id !== data.workspace.id || !Array.isArray(data.files) || !isSessionPrincipal(data.principal)
          || typeof data.sessionExpiresAt !== "number" || !Number.isFinite(data.sessionExpiresAt)
          || data.sessionExpiresAt <= Date.now()) throw new Error("Unsupported startup identity");
        this.meta = data;
        this.check();
      }).catch(() => this.dispose());
  }

  claim(identity: SessionPrincipal) {
    this.identity = identity;
    this.check();
  }

  private check() {
    if (this.disposed || this.adopted) return;
    const { room, meta, identity } = this;
    if (["denied", "gone", "offline"].includes(room.status)) { this.dispose(); return; }
    if (room.status === "open" && (!isSessionPrincipal(room.principal) || room.sessionExpiresAt === null
      || !Number.isFinite(room.sessionExpiresAt) || room.sessionExpiresAt <= Date.now())) {
      this.dispose(); return;
    }
    if (identity && room.status === "open" && !samePrincipal(identity, room.principal)) { this.dispose(); return; }
    if (meta && ((identity && !samePrincipal(identity, meta.principal)) || meta.sessionExpiresAt! <= Date.now()
      || (room.status === "open" && !samePrincipal(room.principal, meta.principal)))) { this.dispose(); return; }
    const expiresAt = Math.min(this.expiresAt, meta?.sessionExpiresAt ?? Infinity, room.sessionExpiresAt ?? Infinity);
    if (expiresAt < this.expiresAt) {
      this.expiresAt = expiresAt;
      clearTimeout(this.deadline);
      this.deadline = setTimeout(() => this.dispose(), Math.max(0, expiresAt - Date.now()));
    }
    if (!meta || !identity || room.status !== "open") return;
    if (!room.adopt(identity)) { this.dispose(); return; }
    this.adopted = true;
    this.unsubscribe();
    clearTimeout(this.deadline);
    this.meta = null;
    this.resolve({ room, meta });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    clearTimeout(this.deadline);
    this.unsubscribe();
    this.room.close();
    this.meta = null;
    this.resolve(null);
  }
}
