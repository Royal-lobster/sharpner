// verify-sharpner browser init script. verify.mjs passes it to agent-browser with --init-script.
//
// agent-browser's --allowed-domains mode replaces window.WebSocket and window.EventSource with plain
// wrapper functions that copy only `.prototype`. The wrappers lose the static constants, so
// `WebSocket.OPEN` is undefined. Sharpner's file room (src/room.ts) sends only while
// `ws.readyState === WebSocket.OPEN`, so without this script the member browser never sends
// presence, edits, or source requests, and every frame stays on "Rendering…".
//
// This script restores the standard constants. It works whether it runs before or after the wrapper.
(() => {
  const CONSTANTS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  const repair = (ctor, names) => {
    if (typeof ctor !== "function") return ctor;
    for (const name of names) {
      if (ctor[name] === undefined) {
        try { Object.defineProperty(ctor, name, { value: CONSTANTS[name], enumerable: true }); } catch { /* frozen */ }
      }
    }
    return ctor;
  };
  const guard = (global, names) => {
    let current = repair(globalThis[global], names);
    try {
      Object.defineProperty(globalThis, global, {
        configurable: true,
        enumerable: false,
        get: () => current,
        set: (value) => { current = repair(value, names); },
      });
    } catch { /* not configurable; the immediate repair above still applied */ }
  };
  guard("WebSocket", ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]);
  guard("EventSource", ["CONNECTING", "OPEN", "CLOSED"]);
})();
