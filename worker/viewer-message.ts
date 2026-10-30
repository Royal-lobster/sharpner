import type { ServerMsg } from "../shared/types";

/** A public link shares the design, while workspace identities and presence stay private. */
export function viewerMessage(message: ServerMsg): ServerMsg | null {
  switch (message.type) {
    case "peer":
    case "peer.leave":
    case "activity":
      return null;
    case "sync":
      return message.by ? { ...message, by: null } : message;
    case "init":
      return message.peers.length ? { ...message, peers: [] } : message;
    default:
      return message;
  }
}
