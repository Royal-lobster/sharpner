import { describe, expect, it } from "vitest";
import type { CanvasNode, Page } from "../shared/types";
import { canvasLocationUrl, readCanvasLocation, resolveCanvasLocation } from "./canvas-location";
import { canvasNavigation } from "./canvas-navigation";

const pages: Page[] = [{ id: "overview", name: "Overview", sort: 0 }, { id: "checkout", name: "Checkout", sort: 1 }];
const nodes = new Map<string, CanvasNode>([
  ["home", { id: "home", pageId: "overview" } as CanvasNode],
  ["payment", { id: "payment", pageId: "checkout" } as CanvasNode],
  ["receipt", { id: "receipt", pageId: "checkout" } as CanvasNode],
]);
const resolve = (search: string, savedPageId: string | null = "overview") => resolveCanvasLocation(readCanvasLocation(search), pages, nodes, savedPageId);

describe("canvas deep links", () => {
  it("opens the linked page and frame ahead of a recipient's remembered page", () => {
    expect(resolve("?page=checkout&node=payment")).toEqual({ pageId: "checkout", selection: ["payment"] });
    expect(resolve("?page=overview", "checkout")).toEqual({ pageId: "overview", selection: [] });
  });

  it("finds a frame's page when the link has only a node or its old page was removed", () => {
    expect(resolve("?node=payment")).toEqual({ pageId: "checkout", selection: ["payment"] });
    expect(resolve("?page=deleted&node=payment")).toEqual({ pageId: "checkout", selection: ["payment"] });
  });

  it("restores multiple selected nodes without duplicates or nodes from other pages", () => {
    expect(resolve("?page=checkout&node=payment&node=receipt&node=payment&node=home&node=missing&node=")).toEqual({
      pageId: "checkout", selection: ["payment", "receipt"],
    });
  });

  it("falls back to the first page for stale links, independent of local preferences", () => {
    expect(resolve("?page=deleted&node=missing", "checkout")).toEqual({ pageId: "overview", selection: [] });
    expect(resolve("?page=checkout&node=missing")).toEqual({ pageId: "checkout", selection: [] });
  });

  it("keeps the remembered page for ordinary file links", () => {
    expect(resolve("", "checkout")).toEqual({ pageId: "checkout", selection: [] });
    expect(resolve("", "deleted")).toEqual({ pageId: "overview", selection: [] });
  });

  it("retains a pending URL until the initial room snapshot arrives", () => {
    const requested = readCanvasLocation("?page=checkout&node=payment");
    expect(resolveCanvasLocation(requested, [], new Map(), "overview")).toEqual({ pageId: null, selection: [] });
    expect(resolveCanvasLocation(requested, pages, nodes, "overview")).toEqual({ pageId: "checkout", selection: ["payment"] });
  });

  it.each(["/f/design", `/s/${"A".repeat(43)}`])("round-trips selections in %s links with safe ID encoding", (path) => {
    const view = { pageId: "page / & #", selection: ["node + / & #", "second"] };
    const result = new URL(canvasLocationUrl(new URL(`https://sharpner.example${path}?review=1#details`), view), "https://sharpner.example");
    expect(result.pathname).toBe(path);
    expect(result.hash).toBe("#details");
    expect(result.searchParams.get("review")).toBe("1");
    expect(readCanvasLocation(result.search)).toEqual(view);
  });

  it("removes stale selections when switching pages or clearing selection", () => {
    const url = new URL("https://sharpner.example/f/design?page=checkout&node=payment&node=receipt&review=1");
    expect(canvasLocationUrl(url, { pageId: "overview", selection: [] })).toBe("/f/design?review=1&page=overview");
    expect(canvasLocationUrl(url, { pageId: "checkout", selection: [] })).toBe("/f/design?review=1&page=checkout");
    expect(url.searchParams.getAll("node")).toEqual(["payment", "receipt"]);
  });

  it("drops deleted or moved nodes from an explicit page's selection", () => {
    const moved = new Map(nodes);
    moved.delete("receipt");
    moved.set("payment", { ...nodes.get("payment")!, pageId: "overview" });
    expect(resolveCanvasLocation(readCanvasLocation("?page=checkout&node=payment&node=receipt"), pages, moved, "overview")).toEqual({ pageId: "checkout", selection: [] });
  });

  it.each([{ w: 1440, h: 900 }, { w: 390, h: 844 }])("fits a linked frame far away on a large canvas at $w×$h", (size) => {
    const target = { x: 48_000, y: 32_000, w: 390, h: 844 };
    const nav = canvasNavigation([{ x: 0, y: 0, w: 100, h: 100 }, target], size);
    const camera = nav.fit([target]);
    expect(camera.z).toBeGreaterThan(nav.overview.z * 10);
    expect(target.x * camera.z + camera.x).toBeGreaterThanOrEqual(0);
    expect(target.y * camera.z + camera.y).toBeGreaterThanOrEqual(0);
    expect((target.x + target.w) * camera.z + camera.x).toBeLessThanOrEqual(size.w);
    expect((target.y + target.h) * camera.z + camera.y).toBeLessThanOrEqual(size.h);
  });
});
