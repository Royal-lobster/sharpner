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
