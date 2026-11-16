import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";

const subscribe = (fn: () => void) => {
  addEventListener("popstate", fn);
  return () => removeEventListener("popstate", fn);
};

export function navigate(to: string, { replace = false } = {}) {
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export const useLocation = () => useSyncExternalStore(subscribe, () => location.pathname + location.search);

export function Link({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}

// ---- in-app sign-in -------------------------------------------------------------
// Members sign in on these pages with Clerk's components. Agent OAuth still uses Clerk's hosted pages.

export type AccountPage = "sign-in" | "sign-up";

/** The account page a path shows, or null for any other path. */
export function accountPage(loc: string): AccountPage | null {
  const page = new URL(loc, "https://app.invalid").pathname.match(/^\/(sign-in|sign-up)\/?$/)?.[1];
  return (page as AccountPage | undefined) ?? null;
}

/** The sign-in page that returns to `loc`, a same-origin path, after the member signs in. */
export function signInPath(loc: string) {
  const back = loc.startsWith("/") && !loc.startsWith("//") && !accountPage(loc) ? loc : "/";
  return back === "/" ? "/sign-in" : `/sign-in?redirect_url=${encodeURIComponent(back)}`;
}

/**
 * The same-origin path an account page returns to after sign-in.
 * Null when `redirect_url` is absent, malformed or on another origin: Clerk then checks it against its own allowlist.
 */
export function accountReturn(loc: string, origin: string): string | null {
  const raw = new URL(loc, origin).searchParams.get("redirect_url");
  if (!raw) return null;
  let target: URL;
  try { target = new URL(raw, origin); } catch { return null; }
  if (target.origin !== origin || accountPage(target.pathname)) return null;
  return target.pathname + target.search + target.hash;
}
