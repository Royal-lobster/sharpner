import { useSyncExternalStore } from "react";

type ConnectionHint = { saveData?: boolean; effectiveType?: string; downlink?: number };
type Connection = ConnectionHint & EventTarget;

/** Connection information is optional; the fallback still uses a small, bounded background queue. */
export function previewPrefetchAllowed(connection?: ConnectionHint) {
  return !connection?.saveData &&
    !["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "") &&
    (connection?.downlink === undefined || connection.downlink >= 1.5);
}

const connection = () => (navigator as Navigator & { connection?: Connection }).connection;
const snapshot = () => previewPrefetchAllowed(connection());
const subscribe = (changed: () => void) => {
  const current = connection();
  current?.addEventListener("change", changed);
  return () => current?.removeEventListener("change", changed);
};

export function usePreviewPrefetch() {
  return useSyncExternalStore(subscribe, snapshot);
}
