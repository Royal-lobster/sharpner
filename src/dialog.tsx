import { useSyncExternalStore } from "react";
import { toast } from "./toast";

type Runtime = typeof import("./dialog-runtime");
let runtime: Runtime | null = null;
let pending: Promise<Runtime> | null = null;
const listeners = new Set<() => void>();

function load() {
  return pending ??= import("./dialog-runtime").then((module) => {
    runtime = module;
    listeners.forEach((listener) => listener());
    return module;
  }).catch((error: unknown) => {
    pending = null;
    throw error;
  });
}

const opener = () => document.activeElement instanceof HTMLElement ? document.activeElement : null;
const unavailable = () => toast("This dialog could not load. Reload the page and try again.", { tone: "error" });

/** Dialog rendering downloads on the first action; a failed download safely cancels the action. */
export async function askText(options: Parameters<Runtime["askText"]>[0]) {
  const trigger = opener();
  let module: Runtime;
  try { module = await load(); }
  catch { unavailable(); return null; }
  if (trigger && !trigger.isConnected) return null;
  return module.askText(options, trigger);
}

export async function askConfirm(options: Parameters<Runtime["askConfirm"]>[0]) {
  const trigger = opener();
  let module: Runtime;
  try { module = await load(); }
  catch { unavailable(); return false; }
  if (trigger && !trigger.isConnected) return false;
  return module.askConfirm(options, trigger);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function DialogHost() {
  const loaded = useSyncExternalStore(subscribe, () => runtime);
  return loaded ? <loaded.DialogHost /> : null;
}
