import { descendantsOf, layoutHeight } from "../shared/layout";
import { api, HttpError } from "./api";
import {
  componentTag, mergeDesignSystems,
  type CanvasNode, type ClientMsg, type CommentAnchor, type CommentDetail, type CommentThread, type DesignSystem, type LibraryInfo, type Op, type Page, type Peer, type Presence, type ServerMsg,
} from "../shared/types";

type Status = "connecting" | "open" | "offline" | "gone" | "denied";

/** How long after an agent's last touch a node still counts as being worked on. Agents edit in bursts. */
const AGENT_QUIET_MS = 6000;
const MAX_CACHED_FRAMES = 128;
const MAX_CACHED_SOURCE_BYTES = 8 * 1024 * 1024;
const SOURCE_BATCH_SIZE = 8;
const MAX_INFLIGHT_SOURCES = 16;
const isDesignNode = (node: CanvasNode) => node.kind === "component" || node.kind === "tokens";
const hasSource = (node: CanvasNode) => node.kind === "frame" || isDesignNode(node);

/**
 * Client-side mirror of a FileRoom. Holds page/node metadata for the whole file, loads node sources on
 * demand, applies local edits optimistically, and notifies React via `subscribe`.
 */
export class Room {
  pages: Page[] = [];
  nodes = new Map<string, CanvasNode>();
  peers = new Map<string, Peer>();
  comments = new Map<string, CommentThread>();
  library: LibraryInfo | null = null;
  status: Status = "connecting";
  /** Node sources (HTML/CSS), tagged with the revision they belong to. */
  sources = new Map<string, { rev: number; source: string }>();
  /** Content heights reported by live iframes for auto-height nodes. */
  heights = new Map<string, number>();
  /** Nodes an agent is working on (id -> who, and until when we consider it active). */
  agentActivity = new Map<string, { name: string; until: number }>();
  /** Nodes an agent just finished with (id -> when), for the brief "settle" flash. */
  agentDone = new Map<string, number>();
  /** Nodes that appeared after load (id -> when), so they can materialize instead of popping in. */
  appeared = new Map<string, number>();
  /** Nodes being dragged locally; server echoes for them are ignored until the drag ends. */
  dragging = new Set<string>();
  version = 0;
  /** Geometry, page membership and measured heights; cursor traffic does not invalidate layout. */
  dataRevision = 0;
  /** Cached source contents; separate from geometry and presence. */
  sourceRevision = 0;
  /** Comment summaries change navigation bounds independently of node geometry and cursor traffic. */
  commentsRevision = 0;

  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private wanted = new Set<string>();
  private inflight = new Map<string, number>();
  private visibleSources = new Set<string>();
  private designNodes = new Map<string, CanvasNode>();
  private frameSources = new Map<string, number>();
  private frameSourceBytes = 0;
  private flushQueued = false;
  private pageCache = new Map<string, CanvasNode[]>();
  private retry = 0;
  private presence: Presence = { pageId: null, selection: [], cursor: null };
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private reconnectCheck: AbortController | null = null;
  private renewal: AbortController | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private designCache: { revision: number; design: DesignSystem } | null = null;
  private designRevision = 0;
  /** Deleted threads cannot be resurrected by an older HTTP response arriving after realtime deletion. */
  private deletedComments = new Set<string>();

  /** `shareToken` opens the file read-only through a view link, without a session. */
  constructor(private fileId: string, private shareToken: string | null = null) {
    this.connect();
  }

  // ---- store plumbing ------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private changedData() {
    this.dataRevision++;
    this.pageCache.clear();
  }

  /** All delayed work belongs to this room and stops when its editor closes. */
  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  // ---- connection ----------------------------------------------------------

  private connect() {
    if (this.closed) return;
    const path = this.shareToken ? `/api/shared/${this.shareToken}/ws` : `/api/files/${this.fileId}/ws`;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
    const ws = (this.ws = new WebSocket(url));
    this.status = "connecting";
    ws.onopen = () => {
      this.retry = 0;
      this.sendRaw({ type: "presence", presence: this.presence });
    };
    ws.onmessage = (e) => {
      if (!this.closed && this.ws === ws) this.receive(JSON.parse(e.data) as ServerMsg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.cancelRenewal();
      this.inflight.clear();
      this.wanted.clear();
      this.peers.clear();
      this.status = e.code === 4404 ? "gone" : e.code === 4403 ? "denied" : e.code === 4001 ? "connecting" : "offline";
      this.emit();
      if (!this.closed && this.status !== "gone" && this.status !== "denied") this.retryConnection(ws);
    };
  }

  private cancelRenewal() {
    this.renewal?.abort();
    this.renewal = null;
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.timers.delete(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private scheduleRenewal(cid: string, expiresAt: number, retry = false) {
    this.cancelRenewal();
    const ws = this.ws;
    if (this.shareToken || !ws || !Number.isFinite(expiresAt)) return;
    this.renewalTimer = this.later(() => {
      this.renewalTimer = null;
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      const controller = this.renewal = new AbortController();
      void api<{ expiresAt: number }>(`/files/${this.fileId}/session`, {
        method: "POST", json: { cid }, freshToken: true, signal: controller.signal,
      }).then((lease) => {
        if (!this.closed && this.ws === ws && !controller.signal.aborted) this.scheduleRenewal(cid, lease.expiresAt);
      }).catch((error: unknown) => {
        if (this.closed || this.ws !== ws || controller.signal.aborted) return;
        if (error instanceof HttpError && [401, 403, 404].includes(error.status)) {
          this.status = "denied";
          this.emit();
          ws.close(4403, "Session access changed");
        } else if (error instanceof HttpError && error.status === 409) {
          ws.close(4001, "Session renewal required");
        } else {
          this.scheduleRenewal(cid, expiresAt, true);
        }
      }).finally(() => {
        if (this.renewal === controller) this.renewal = null;
      });
    }, retry ? 3000 : Math.max(1000, expiresAt - Date.now() - 15_000));
  }

  /** A rejected upgrade hides its HTTP status; check access before opening another socket. */
  private retryConnection(ws: WebSocket) {
    this.later(() => {
      const controller = new AbortController();
      this.reconnectCheck = controller;
      void api(this.shareToken ? `/shared/${this.shareToken}` : `/files/${this.fileId}`, { signal: controller.signal }).then(() => {
        if (!this.closed && this.ws === ws) this.connect();
      }).catch((error: unknown) => {
        if (this.closed || this.ws !== ws || controller.signal.aborted) return;
        if (error instanceof HttpError && [401, 403, 404].includes(error.status)) {
          this.status = "denied";
          this.emit();
        } else if (!(error instanceof DOMException && error.name === "AbortError")) {
          this.retryConnection(ws);
        }
      }).finally(() => {
        if (this.reconnectCheck === controller) this.reconnectCheck = null;
      });
    }, Math.min(10_000, 500 * 2 ** this.retry++));
  }

  close() {
    this.closed = true;
    this.reconnectCheck?.abort();
    this.cancelRenewal();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
    }
  }

  private sendRaw(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private receive(msg: ServerMsg) {
    switch (msg.type) {
      case "init": {
        if (msg.sessionExpiresAt !== undefined) this.scheduleRenewal(msg.cid, msg.sessionExpiresAt);
        const previousNodes = this.nodes;
        this.status = "open";
        this.pages = msg.pages;
        this.nodes = new Map(msg.nodes.map((n) => [n.id, n]));
        this.peers = new Map(msg.peers.map((p) => [p.cid, p]));
        const comments = new Map((msg.comments ?? []).map((t) => [t.id, t]));
        for (const id of this.comments.keys()) if (!comments.has(id)) this.deletedComments.add(id);
        this.comments = comments;
        this.commentsRevision++;
        this.library = msg.library;
        this.designNodes = new Map(msg.nodes.filter(isDesignNode).map((node) => [node.id, node]));
        this.designRevision++;
        this.changedData();
        this.inflight.clear();
        this.wanted.clear();
        for (const [id, cached] of this.sources) {
          const node = this.nodes.get(id);
          if (!node || !hasSource(node) || node.rev !== cached.rev) this.forgetSource(id);
        }
        for (const id of this.heights.keys()) {
          if (!this.nodes.has(id) || previousNodes.get(id)?.rev !== this.nodes.get(id)?.rev) this.heights.delete(id);
        }
        for (const id of this.visibleSources) if (!this.nodes.has(id)) this.visibleSources.delete(id);
        this.reconcileSources();
        break;
      }
      case "sync": {
        if (msg.pages) for (const p of msg.pages) this.upsertPage(p);
        if (msg.pageDels) for (const pageId of msg.pageDels) this.forgetPage(pageId);
        if (msg.nodeDels) for (const id of msg.nodeDels) this.forgetNode(id);
        for (const n of msg.nodes ?? []) {
          if (this.dragging.has(n.id)) continue;
          if (!this.nodes.has(n.id)) {
            this.appeared.set(n.id, performance.now());
            this.later(() => { this.appeared.delete(n.id); this.emit(); }, 1500);
          }
          const previous = this.nodes.get(n.id);
          if (previous && previous.rev !== n.rev) {
            this.forgetSource(n.id);
            this.heights.delete(n.id);
          }
          this.nodes.set(n.id, n);
          this.updateDesignNode(n);
          if (msg.by?.agent) this.markAgent(n.id, msg.by.name);
        }
        if (msg.pages?.length || msg.pageDels?.length || msg.nodes?.length || msg.nodeDels?.length) this.changedData();
        this.reconcileSources();
        break;
      }
      case "source":
        for (const item of msg.items) {
          this.inflight.delete(item.id);
          const node = this.nodes.get(item.id);
          // A queued response can arrive after a newer edit or deletion.
          if (!node || !hasSource(node) || node.rev !== item.rev) continue;
          this.forgetSource(item.id);
          this.sources.set(item.id, { rev: item.rev, source: item.source });
          this.sourceRevision++;
          if (isDesignNode(node)) this.designRevision++;
          else {
            const bytes = item.source.length * 2;
            this.frameSources.set(item.id, bytes);
            this.frameSourceBytes += bytes;
          }
        }
        this.trimSources();
        this.reconcileSources();
        break;
      case "activity":
        for (const id of msg.ids) this.markAgent(id, msg.by.name);
        break;
      case "library":
        this.library = msg.library;
        this.designRevision++;
        break;
      case "peer":
        this.peers.set(msg.peer.cid, msg.peer);
        break;
      case "peer.leave":
        this.peers.delete(msg.cid);
        break;
      case "comments":
        for (const thread of msg.threads) this.upsertComment(thread);
        for (const id of msg.deleted ?? []) {
          if (this.comments.delete(id)) this.commentsRevision++;
          this.deletedComments.add(id);
        }
        break;
    }
    this.emit();
  }

  /** An agent touched a node: keep it "working" until it has been quiet for a few seconds, then settle. */
  private markAgent(id: string, name: string) {
    const until = Date.now() + AGENT_QUIET_MS;
    this.agentActivity.set(id, { name, until });
    this.agentDone.delete(id);
    this.later(() => {
      const cur = this.agentActivity.get(id);
      if (!cur || cur.until > Date.now()) return;
      this.agentActivity.delete(id);
      this.agentDone.set(id, performance.now());
      this.emit();
      this.later(() => {
        this.agentDone.delete(id);
        this.emit();
      }, 900);
    }, AGENT_QUIET_MS + 50);
  }

  // ---- sources & design system --------------------------------------------

  /** Replaces the live viewport's source interest. Design definitions remain pinned independently. */
  needSources(ids: string[]) {
    this.visibleSources = new Set(ids.filter((id) => {
      const node = this.nodes.get(id);
      return node && hasSource(node);
    }));
    for (const id of this.visibleSources) {
      const bytes = this.frameSources.get(id);
      if (bytes !== undefined) {
        this.frameSources.delete(id);
        this.frameSources.set(id, bytes);
      }
    }
    this.trimSources();
    this.reconcileSources();
  }

  private reconcileSources() {
    const needed = new Set([...this.designNodes.keys(), ...this.visibleSources]);
    for (const id of this.wanted) {
      const node = this.nodes.get(id);
      if (!needed.has(id) || !node || this.sources.get(id)?.rev === node.rev) this.wanted.delete(id);
    }
    for (const id of needed) {
      const node = this.nodes.get(id);
      if (!node || !hasSource(node) || this.inflight.has(id) || this.sources.get(id)?.rev === node.rev) continue;
      this.wanted.add(id);
    }
    if (this.wanted.size && !this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => { this.flushQueued = false; this.flush(); });
    }
  }

  private flush() {
    if (this.closed || this.status !== "open" || this.ws?.readyState !== WebSocket.OPEN) return;
    const available = Math.max(0, MAX_INFLIGHT_SOURCES - this.inflight.size);
    const ids = [...this.wanted].filter((id) => {
      const node = this.nodes.get(id);
      return node && hasSource(node) && !this.inflight.has(id) && this.sources.get(id)?.rev !== node.rev;
    }).slice(0, available);
    for (let i = 0; i < ids.length; i += SOURCE_BATCH_SIZE) {
      const batch = ids.slice(i, i + SOURCE_BATCH_SIZE);
      for (const id of batch) {
        this.wanted.delete(id);
        this.inflight.set(id, this.nodes.get(id)!.rev);
      }
      this.sendRaw({ type: "source", ids: batch });
    }
  }

  private forgetSource(id: string) {
    const bytes = this.frameSources.get(id);
    if (bytes !== undefined) {
      this.frameSourceBytes -= bytes;
      this.frameSources.delete(id);
    }
    if (this.sources.delete(id)) this.sourceRevision++;
  }

  private trimSources() {
    // Visible sources and design definitions must remain usable even if they exceed the cache budget.
    // The limits apply to the reusable screen cache, evicting only the least recently needed entries.
    for (const [id] of this.frameSources) {
      if (this.frameSources.size <= MAX_CACHED_FRAMES && this.frameSourceBytes <= MAX_CACHED_SOURCE_BYTES) break;
      if (!this.visibleSources.has(id)) this.forgetSource(id);
    }
  }

  private updateDesignNode(node: CanvasNode) {
    const previous = this.designNodes.get(node.id);
    if (isDesignNode(node)) {
      this.designNodes.set(node.id, node);
      if (!previous || previous.name !== node.name || previous.rev !== node.rev) this.designRevision++;
    } else if (this.designNodes.delete(node.id)) this.designRevision++;
  }

  private forgetNode(id: string) {
    this.nodes.delete(id);
    this.forgetSource(id);
    this.heights.delete(id);
    this.visibleSources.delete(id);
    this.wanted.delete(id);
    this.inflight.delete(id);
    this.dragging.delete(id);
    this.agentActivity.delete(id);
    this.agentDone.delete(id);
    this.appeared.delete(id);
    if (this.designNodes.delete(id)) this.designRevision++;
  }

  private forgetPage(pageId: string) {
    this.pages = this.pages.filter((page) => page.id !== pageId);
    for (const node of this.nodes.values()) if (node.pageId === pageId) this.forgetNode(node.id);
  }

  /** What live frames render with: the library's design system overridden by this file's (stable object until it changes). */
  design(): DesignSystem {
    if (this.designCache?.revision === this.designRevision) return this.designCache.design;
    const own = [...this.designNodes.values()];
    const src = (n: CanvasNode) => this.sources.get(n.id)?.source;
    const design = mergeDesignSystems(this.library?.design, {
      tokens: own.filter((n) => n.kind === "tokens").map(src).filter(Boolean).join("\n"),
      components: own.filter((n) => n.kind === "component" && src(n) !== undefined).map((n) => ({ tag: componentTag(n.name), html: src(n)! })),
    });
    this.designCache = { revision: this.designRevision, design };
    return design;
  }

  setHeight(id: string, h: number) {
    if (this.heights.get(id) === h) return;
    this.heights.set(id, h);
    this.changedData();
    this.emit();
  }

  // ---- edits (optimistic) --------------------------------------------------

  private upsertComment(thread: CommentThread) {
    if (this.deletedComments.has(thread.id)) return;
    if ((this.comments.get(thread.id)?.revision ?? 0) > thread.revision) return;
    const { messages: _messages, ...summary } = thread as CommentDetail;
    this.comments.set(thread.id, summary);
    this.commentsRevision++;
  }

  getComment(id: string, signal?: AbortSignal) {
    return api<CommentDetail>(`/files/${this.fileId}/comments/${id}`, { signal });
  }

  async createComment(anchor: CommentAnchor, body: string) {
    return this.writeComment("", "POST", { anchor, body });
  }

  async replyComment(id: string, body: string) {
    return this.writeComment(`/${id}/replies`, "POST", { body });
  }

  async resolveComment(id: string, resolved: boolean) {
    return this.writeComment(`/${id}`, "PATCH", { resolved });
  }

  private async writeComment(path: string, method: string, json: unknown) {
    if (this.shareToken || this.status !== "open" || this.closed) throw new Error("Reconnect to the file before posting comments");
    const thread = await api<CommentDetail>(`/files/${this.fileId}/comments${path}`, { method, json });
    if (!this.closed) { this.upsertComment(thread); this.emit(); }
    return thread;
  }

  send(ops: Op[]) {
    for (const op of ops) this.applyLocal(op);
    if (ops.length) this.changedData();
    this.reconcileSources();
    this.emit();
    this.sendRaw({ type: "ops", ops });
  }

  /** Moves nodes locally without sending (used while dragging). */
  moveLocal(positions: Map<string, { x: number; y: number }>) {
    for (const [id, p] of positions) {
      const n = this.nodes.get(id);
      if (n) this.nodes.set(id, { ...n, ...p });
    }
    if (positions.size) this.changedData();
    this.emit();
  }

  private applyLocal(op: Op) {
    switch (op.t) {
      case "page.put":
        this.upsertPage(op.page);
        break;
      case "page.del":
        this.forgetPage(op.id);
        break;
      case "node.put": {
        const cur = this.nodes.get(op.id);
        const { source: _source, ...meta } = op.node;
        if (cur) this.nodes.set(op.id, { ...cur, ...meta });
        else if (meta.pageId) {
          this.nodes.set(op.id, {
            id: op.id, pageId: meta.pageId, parentId: meta.parentId ?? null, kind: meta.kind ?? "frame", name: meta.name ?? "Frame",
            x: meta.x ?? 0, y: meta.y ?? 0, width: meta.width ?? 400, height: meta.height ?? null,
            layout: meta.layout ?? (meta.kind === "section" ? "auto" : "free"),
            order: meta.order ?? Math.max(0, ...[...this.nodes.values()].map((n) => n.order ?? 0)) + 1,
            measuredHeight: null, src: meta.src ?? null, thumbLo: meta.thumbLo ?? meta.src ?? null, thumbHi: meta.src ?? null, rev: 0,
          });
        }
        const node = this.nodes.get(op.id);
        if (node) this.updateDesignNode(node);
        break;
      }
      case "node.del":
        for (const id of [...op.ids, ...descendantsOf([...this.nodes.values()], op.ids)]) this.forgetNode(id);
        break;
    }
  }

  private upsertPage(p: Page) {
    const i = this.pages.findIndex((x) => x.id === p.id);
    // A put without a description keeps the current one, as on the server.
    if (i >= 0) this.pages[i] = { ...this.pages[i], ...p };
    else this.pages.push(p);
    this.pages = [...this.pages].sort((a, b) => a.sort - b.sort);
  }

  // ---- presence --------------------------------------------------------------

  setPresence(patch: Partial<Presence>) {
    this.presence = { ...this.presence, ...patch };
    if (this.presenceTimer) return;
    this.presenceTimer = this.later(() => {
      this.presenceTimer = null;
      this.sendRaw({ type: "presence", presence: this.presence });
    }, 40);
  }

  // ---- helpers ---------------------------------------------------------------

  pageNodes(pageId: string) {
    const cached = this.pageCache.get(pageId);
    if (cached) return cached;
    const out: CanvasNode[] = [];
    for (const n of this.nodes.values()) if (n.pageId === pageId) out.push(n);
    this.pageCache.set(pageId, out);
    return out;
  }

  heightOf(n: CanvasNode) {
    return layoutHeight(n, this.heights);
  }
}
