import { describe, expect, it } from "vitest";
import { ViewerAccess } from "./viewer-access";

describe("viewer revocation during token lookup", () => {
  it("rejects an upgrade authorized before revocation but delivered after viewers were closed", async () => {
    const access = new ViewerAccess();
    let finish!: (row: unknown) => void;
    const staleLookup = new Promise((resolve) => { finish = resolve; });
    const pendingUpgrade = access.check(() => staleLookup);
    access.revoke();
    finish({ shared: true });
    await expect(pendingUpgrade).resolves.toBe(false);
  });

  it("allows a new valid link after revocation, but rejects a deleted token", async () => {
    const access = new ViewerAccess();
    await expect(access.check(async () => ({ shared: true }))).resolves.toBe(true);
    access.revoke();
    await expect(access.check(async () => null)).resolves.toBe(false);
    await expect(access.check(async () => ({ shared: true }))).resolves.toBe(true);
  });

  it("fails closed when the token lookup is unavailable", async () => {
    const access = new ViewerAccess();
    await expect(access.check(async () => { throw new Error("D1 unavailable"); })).rejects.toThrow("D1 unavailable");
  });
});
