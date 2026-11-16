import { describe, expect, it } from "vitest";
import { accountPage, accountReturn, signInPath } from "./router";

const origin = "https://sharpner.example";

describe("in-app sign-in routes", () => {
  it.each([
    ["/sign-in", "sign-in"], ["/sign-in/", "sign-in"], ["/sign-in?redirect_url=%2F", "sign-in"],
    ["/sign-up", "sign-up"], ["/sign-up/?redirect_url=%2Ff%2Fa", "sign-up"],
    ["/", null], ["/f/sign-in", null], ["/sign-in/extra", null], ["/sign-inx", null], ["/s/sign-in", null],
  ])("recognizes %s as %s", (loc, page) => {
    expect(accountPage(loc)).toBe(page);
  });

  it("returns a signed-out visitor to the file, page and selection they opened", () => {
    const opened = "/f/file_a?page=p1&nodes=n1,n2";
    const path = signInPath(opened);
    expect(path).toBe(`/sign-in?redirect_url=${encodeURIComponent(opened)}`);
    expect(accountReturn(path, origin)).toBe(opened);
  });

  it("sends a visitor from home, or from an account page, to plain sign-in", () => {
    expect(signInPath("/")).toBe("/sign-in");
    expect(signInPath("/sign-in?redirect_url=%2Ff%2Fa")).toBe("/sign-in");
    expect(signInPath("//evil.example/f/a")).toBe("/sign-in");
  });

  it("keeps the destination when the member switches between sign-in and sign-up", () => {
    expect(accountReturn("/sign-up?redirect_url=%2Ff%2Fa%3Fpage%3Dp1", origin)).toBe("/f/a?page=p1");
  });

  it.each([
    ["no destination", "/sign-in"],
    ["another origin", `/sign-in?redirect_url=${encodeURIComponent("https://evil.example/f/a")}`],
    ["a protocol-relative URL", `/sign-in?redirect_url=${encodeURIComponent("//evil.example/f/a")}`],
    ["a script URL", `/sign-in?redirect_url=${encodeURIComponent("javascript:alert(1)")}`],
    ["an account page", `/sign-in?redirect_url=${encodeURIComponent("/sign-up?redirect_url=/f/a")}`],
  ])("does not force a return to %s", (_, loc) => {
    expect(accountReturn(loc, origin)).toBeNull();
  });
});
