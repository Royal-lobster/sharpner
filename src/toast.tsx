import { toast as notify } from "sonner";
import { Toaster as ShadcnToaster } from "@/components/ui/sonner";

type Tone = "default" | "success" | "error";

/**
 * Sticky messages stay until the returned function is called. A final string updates the same
 * message to success; an empty value dismisses it. Sonner owns rendering, timing, and announcements.
 */
export function toast(text: string, opts: { tone?: Tone; sticky?: boolean } = {}) {
  const active = notify.getToasts();
  for (const old of active.slice(0, Math.max(0, active.length - 2))) notify.dismiss(old.id);
  const options = { duration: opts.sticky ? Infinity : 2600, dismissible: !opts.sticky };
  const id = opts.tone === "success" ? notify.success(text, options)
    : opts.tone === "error" ? notify.error(text, options)
    : opts.sticky ? notify.loading(text, options)
    : notify.message(text, options);
  return (final?: string | null) => {
    // A late completion must not resurrect a message already removed from the stack.
    if (final && notify.getToasts().some((item) => item.id === id)) {
      notify.success(final, { id, duration: 1800, dismissible: true });
    } else notify.dismiss(id);
  };
}

export function Toaster() {
  const bottom = "calc(var(--toast-offset, 20px) + var(--safe-bottom))";
  return (
    <ShadcnToaster theme="dark" position="bottom-center" visibleToasts={3} expand duration={2600}
      className="toaster group sharpner-toaster" containerAriaLabel="Notifications"
      offset={{ bottom }} mobileOffset={{ bottom, left: 16, right: 16 }}
      toastOptions={{ classNames: { toast: "cn-toast canvas-toast" } }} />
  );
}
