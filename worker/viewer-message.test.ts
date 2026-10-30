import { describe, expect, it } from "vitest";
import type { Actor, Peer, ServerMsg } from "../shared/types";
import { viewerMessage } from "./viewer-message";

const actor: Actor = { id: "member-private-id", name: "Private member name", avatar: "https://example.test/member-photo" };
const peer: Peer = { ...actor, cid: "private-connection", pageId: "page", selection: ["node"], cursor: { x: 10, y: 20 } };

describe("public viewer messages", () => {
  it("keeps edits live without revealing the member who made them or changing the member message", () => {
    const edit: ServerMsg = { type: "sync", nodeDels: ["deleted-node"], by: actor };
    expect(viewerMessage(edit)).toEqual({ type: "sync", nodeDels: ["deleted-node"], by: null });
    expect(edit.by).toBe(actor);
  });

  it("omits member cursors, selections, connection IDs and agent read activity", () => {
    expect(viewerMessage({ type: "peer", peer })).toBeNull();
    expect(viewerMessage({ type: "peer.leave", cid: peer.cid })).toBeNull();
    expect(viewerMessage({ type: "activity", by: { ...actor, agent: true }, ids: ["node"] })).toBeNull();
    const initial: ServerMsg = { type: "init", nodes: [], pages: [], cid: "viewer-connection", peers: [peer], library: null };
    expect(viewerMessage(initial)).toEqual({ ...initial, peers: [] });
    expect(initial.peers).toEqual([peer]);
  });

  it("preserves source revisions and inherited design content needed to render the file", () => {
    const source: ServerMsg = { type: "source", items: [{ id: "node", rev: 3, source: "<main>Updated design</main>" }] };
    const library: ServerMsg = { type: "library", library: { fileId: "library", name: "Design system", design: { tokens: "@theme { --color-primary: lime; }", components: [] } } };
    expect(viewerMessage(source)).toBe(source);
    expect(viewerMessage(library)).toBe(library);
    const thumbnail: ServerMsg = { type: "sync", nodes: [], by: null };
    expect(viewerMessage(thumbnail)).toBe(thumbnail);
  });
});
