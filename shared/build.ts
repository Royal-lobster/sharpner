declare const __SHARPNER_BUILD__: string | undefined;

/**
 * The deploy this code was built from. The Worker sends its build with every room `init`, so a tab still running
 * an older bundle notices and reloads instead of drawing previews with code the server no longer uses.
 * Tests and `vite dev` have no build, and never ask a tab to reload.
 */
export const BUILD: string = typeof __SHARPNER_BUILD__ === "string" && __SHARPNER_BUILD__ ? __SHARPNER_BUILD__ : "dev";
