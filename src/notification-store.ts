import { useSyncExternalStore } from "react";
import type { MentionNotification } from "../shared/types";
import { api } from "./api";

/** How often a visible tab checks for new mentions. Hidden tabs check again when they return. */
const POLL_MS = 60_000;

export type NotificationState = { notifications: MentionNotification[]; unread: number; loaded: boolean };

let state: NotificationState = { notifications: [], unread: 0, loaded: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

const set = (next: NotificationState) => { state = next; for (const listener of listeners) listener(); };

/** Fetch the inbox now. Failures keep what is shown; the next poll tries again. */
export function refreshNotifications() {
  inflight ??= api<{ notifications: MentionNotification[]; unread: number }>("/notifications")
    .then((r) => set({ ...r, loaded: true }))
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}

const onVisible = () => { if (!document.hidden) void refreshNotifications(); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshNotifications();
    timer = setInterval(onVisible, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}

/** The signed-in member's mention inbox, polled while any view shows it. */
export const useNotifications = () => useSyncExternalStore(subscribe, () => state);

/** Mark read here at once, then on the server: the listed ids, a thread's notifications, or everything. */
export async function markNotificationsRead(target: { ids?: string[]; threadId?: string }) {
  const hit = (n: MentionNotification) => n.readAt === null && (target.ids ? target.ids.includes(n.id) : target.threadId ? n.threadId === target.threadId : true);
  if (!state.notifications.some(hit) && (target.ids || target.threadId)) return;
  const now = Date.now();
  const notifications = state.notifications.map((n) => hit(n) ? { ...n, readAt: now } : n);
  set({ ...state, notifications, unread: target.ids || target.threadId ? Math.max(0, state.unread - state.notifications.filter(hit).length) : 0 });
  try { await api("/notifications/read", { method: "POST", json: target }); }
  catch { void refreshNotifications(); }
}
