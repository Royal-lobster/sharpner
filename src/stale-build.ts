import { toast as notify } from "sonner";
import { BUILD } from "../shared/build";

const KEY = "sharpner:reloaded-for-build";

const editing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable);
};

/**
 * Called with the build the room's Worker runs. A tab on an older bundle would draw previews and specimens with code
 * the server no longer uses, so it reloads once per server build. While someone is typing, it asks instead.
 * Returns whether it reloaded.
 */
export function reloadIfStale(server: string | undefined, client = BUILD, reload = () => location.reload()): boolean {
  if (!server || server === "dev" || client === "dev" || server === client) return false;
  try {
    if (sessionStorage.getItem(KEY) === server) return false;
    sessionStorage.setItem(KEY, server);
  } catch { return false; }
  if (!editing()) { reload(); return true; }
  notify.message("Sharpner was updated. Reload to see current previews.", {
    duration: Infinity, dismissible: true, action: { label: "Reload", onClick: reload },
  });
  return false;
}
