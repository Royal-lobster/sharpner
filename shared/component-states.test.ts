import { describe, expect, it } from "vitest";
import { classVariants, forceStateScript, inferredStates, stateVariantCss, variantState } from "./component-states";
import { propAxes } from "./catalog-specimens";
import { thumbnailCss } from "../worker/thumbnail-css";

const checkbox = `<label class="group flex items-center gap-2"><button role="checkbox" aria-checked="false" class="peer size-4 rounded border hover:border-primary focus-visible:ring-2 aria-checked:bg-primary aria-invalid:border-destructive disabled:opacity-50"><svg class="opacity-0 group-has-[[aria-checked=true]]:opacity-100"></svg></button><span class="peer-disabled:opacity-50">{{label|Notify me}}</span></label>`;

describe("component states", () => {
  it("splits a class's variants at colons outside brackets", () => {
    expect(classVariants("group-data-[state=checked]:opacity-100")).toEqual(["group-data-[state=checked]"]);
    expect(classVariants("dark:hover:bg-[color:var(--x)]")).toEqual(["dark", "hover"]);
    expect(classVariants("bg-primary")).toEqual([]);
  });

  it("names the state a variant tests, through group-, peer- and /name", () => {
    expect(variantState("hover")).toBe("hover");
    expect(variantState("group-hover/item")).toBe("hover");
    expect(variantState("focus-visible")).toBe("focus");
    expect(variantState("active")).toBe("pressed");
    expect(variantState("data-[state=checked]")).toBe("checked");
    expect(variantState("group-data-[state=checked]")).toBe("checked");
    expect(variantState("peer-checked")).toBe("checked");
    expect(variantState("aria-selected")).toBe("checked");
    expect(variantState("data-[state=on]")).toBe("checked");
    expect(variantState("aria-invalid")).toBe("invalid");
    expect(variantState("data-disabled")).toBe("disabled");
    expect(variantState("not-disabled")).toBeNull();
    expect(variantState("dark")).toBeNull();
    expect(variantState("data-[state=open]")).toBeNull();
  });

  it("gives a checkbox a row per state it styles, with the checked looks combined", () => {
    expect(inferredStates(checkbox)).toEqual(["", "hover", "focus", "checked", "checked hover", "checked focus", "invalid", "disabled", "checked disabled"]);
  });

  it("names the on-state as the component does", () => {
    expect(inferredStates(`<button class="data-[state=active]:bg-card">Tab</button>`)).toEqual(["", "selected"]);
    expect(inferredStates(`<button class="aria-pressed:bg-accent hover:bg-muted">B</button>`)).toEqual(["", "hover", "on", "on hover"]);
  });

  it("leaves a state a listed prop already shows to that prop", () => {
    const toggle = `<button data-state="{{checked|off|off,on}}" class="data-[state=on]:bg-primary hover:bg-muted disabled:opacity-50"></button>`;
    expect(inferredStates(toggle, propAxes(toggle))).toEqual(["", "hover", "disabled"]);
    const button = `<button data-state="{{state|rest|rest,hover,pressed}}" class="hover:bg-muted active:bg-card"></button>`;
    expect(inferredStates(button, propAxes(button))).toBeNull();
  });

  it("has no rows for a component that styles no state", () => {
    expect(inferredStates(`<div class="dark:bg-black rounded data-[state=open]:block">x</div>`)).toBeNull();
  });

  it("matches pseudo-class variants inside a forced state, keeping Tailwind's specificity", async () => {
    const css = await thumbnailCss(stateVariantCss, ["hover:bg-red-500", "group-hover:underline", "checked:bg-black", "enabled:cursor-pointer"]);
    expect(css).toContain(".hover\\:bg-red-500:is(:hover, :where([data-sp-state~=hover]) *)");
    expect(css).toContain(".group-hover\\:underline:is(:where(.group):is(:hover, :where([data-sp-state~=hover]) *) *)");
    expect(css).toContain(".checked\\:bg-black:is(:checked, :where([data-sp-state~=checked], [data-sp-state~=selected], [data-sp-state~=on]) *)");
    expect(css).toContain(".enabled\\:cursor-pointer:enabled:not(:where([data-sp-state~=disabled]) *)");
  });
  it("checks a forced radio outside its group, so repeated rows don't uncheck each other", () => {
    // A minimal element: enough of the DOM for SP_STATE to walk, match and set attributes.
    const el = (tag: string, attrs: Record<string, string>, kids: any[] = []): any => {
      const node: any = {
        tag, type: attrs.type, attrs: { ...attrs }, kids, parentElement: null, previousElementSibling: null,
        classList: Object.assign((attrs.class ?? "").split(/\s+/).filter(Boolean), { contains(this: string[], c: string) { return this.includes(c); } }),
        matches: (sel: string) => sel.split(",").some((s) => s === `${tag}[type=${node.attrs.type}]`),
        setAttribute: (k: string, v: string) => { node.attrs[k] = v; },
        removeAttribute: (k: string) => { delete node.attrs[k]; },
        hasAttribute: (k: string) => k in node.attrs,
        querySelectorAll: () => kids.flatMap((k: any) => [k, ...k.querySelectorAll()]),
      };
      for (const k of kids) k.parentElement = node;
      return node;
    };
    const SP_STATE = new Function(`${forceStateScript}\nreturn SP_STATE;`)();
    const radio = el("input", { type: "radio", name: "odds" });
    const box = el("input", { type: "checkbox", name: "terms" });
    SP_STATE(el("label", {}, [radio, box]), ["checked"]);
    expect(radio.attrs).toEqual({ type: "radio", checked: "" });
    expect(box.attrs).toEqual({ type: "checkbox", name: "terms", checked: "" });
    const rest = el("input", { type: "radio", name: "odds" });
    SP_STATE(el("label", {}, [rest]), ["hover"]);
    expect(rest.attrs).toEqual({ type: "radio", name: "odds" });
  });
});
