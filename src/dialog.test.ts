import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ toast: notify }));

class Element { isConnected = true; }
const trigger = new Element();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  trigger.isConnected = true;
  vi.stubGlobal("HTMLElement", Element);
  vi.stubGlobal("document", { activeElement: trigger });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("on-demand dialogs", () => {
  it("retains each action's opener and options while the shared renderer downloads", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const askText = vi.fn(async (..._args: unknown[]) => "New name");
    const askConfirm = vi.fn(async (..._args: unknown[]) => true);
    vi.doMock("./dialog-runtime", async () => {
      await ready;
      return { askText, askConfirm, DialogHost: () => null };
    });
    const dialogs = await import("./dialog");
    const textOptions = { title: "Rename file", label: "File name", initial: "Original" };
    const text = dialogs.askText(textOptions);
    const nextTrigger = new Element();
    Object.defineProperty(document, "activeElement", { value: nextTrigger, configurable: true });
    const confirmOptions = { title: "Delete file?", danger: true };
    const confirmation = dialogs.askConfirm(confirmOptions);
    expect(askText).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
    release();
    expect(await text).toBe("New name");
    expect(await confirmation).toBe(true);
    expect(askText.mock.calls[0]?.[0]).toBe(textOptions);
    expect(askText.mock.calls[0]?.[1] === trigger).toBe(true);
    expect(askConfirm.mock.calls[0]?.[0]).toBe(confirmOptions);
    expect(askConfirm.mock.calls[0]?.[1] === nextTrigger).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("cancels text and destructive actions with feedback when the renderer cannot download", async () => {
    vi.doMock("./dialog-runtime", () => { throw new Error("Chunk download failed"); });
    const dialogs = await import("./dialog");
    await expect(dialogs.askText({ title: "Rename file", label: "File name" })).resolves.toBeNull();
    await expect(dialogs.askConfirm({ title: "Delete file?", danger: true })).resolves.toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith("This dialog could not load. Reload the page and try again.", { tone: "error" });
  });

  it("cancels pending dialogs when navigation removes their initiating control", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const askText = vi.fn(async () => "Old workspace name");
    const askConfirm = vi.fn(async () => true);
    vi.doMock("./dialog-runtime", async () => {
      await ready;
      return { askText, askConfirm, DialogHost: () => null };
    });
    const dialogs = await import("./dialog");
    const text = dialogs.askText({ title: "Rename file", label: "File name" });
    const confirmation = dialogs.askConfirm({ title: "Delete file?", danger: true });
    trigger.isConnected = false;
    release();
    await expect(text).resolves.toBeNull();
    await expect(confirmation).resolves.toBe(false);
    expect(askText).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
