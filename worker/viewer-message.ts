import type { ServerMsg } from "../shared/types";

/** A public link shares the design, while workspace identities and presence stay private. */
export function viewerMessage(message: ServerMsg): ServerMsg | null {
  switch (message.type) {
    case "peer":
    case "peer.leave":
    case "activity":
    case "comments":
      return null;
    case "sync":
      return message.by ? { ...message, by: null } : message;
    case "init": {
      const { principal: _principal, sessionExpiresAt: _expiry, ...publicInit } = message;
      return { ...publicInit, peers: [], ...(message.comments ? { comments: [] } : {}) };
    }
    default:
      return message;
  }
}
