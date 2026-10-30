import { useSyncExternalStore } from "react";

/** Whether a media query matches, kept in sync with the viewport. */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const media = matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
  );
}

/** Wide enough for centred dialogs and anchored popovers; narrower screens get bottom sheets. */
export const useDesktop = () => useMediaQuery("(min-width: 640px)");
