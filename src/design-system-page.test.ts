import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { emptyBrand, mergeDesignSystems, type CanvasNode } from "../shared/types";
import { DesignSystemPage } from "./DesignSystemPage";
import type { Room } from "./room";

it("renders the original library values and local overrides as separate source-labeled rows", () => {
  const local = '@theme { --color-primary: purple; --font-sans: Archivo; }';
  const library = { fileId: "library", name: "Library", design: { tokens: '@theme { --color-primary: blue; --font-sans: Inter; }', components: [] }, catalog: { pageId: "lib-ds", brand: emptyBrand(), tokenSheets: 1, primitives: [] } };
  const room = { library, nodes: new Map([["tokens", { id: "tokens", kind: "tokens" } as CanvasNode]]), sources: new Map([["tokens", { source: local }]]), pages: [], brand: emptyBrand(), fileTheme: null, status: "open", dataRevision: 1, sourceRevision: 1,
    design: () => mergeDesignSystems(library.design, { tokens: local, components: [] }),
  } as unknown as Room;
  const html = renderToStaticMarkup(createElement(DesignSystemPage, { room, fileId: "product", fileName: "Product", pageId: "ds", readOnly: true }));
  const foundations = html.split('id="ds-foundations"')[1]!.split('id="ds-primitives"')[0]!;
  expect(foundations).toContain("blue");
  expect(foundations).toContain("purple");
  expect(foundations).toContain("Library · read only");
  expect(foundations).toContain("This file");
  expect(foundations).toContain("Inter");
  expect(foundations).toContain("Archivo");
});
