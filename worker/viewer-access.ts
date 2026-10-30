/** Fences token lookups that were already in flight when this room revoked its viewers. */
export class ViewerAccess {
  private generation = 0;

  async check(lookup: () => Promise<unknown>): Promise<boolean> {
    const generation = this.generation;
    const shared = await lookup();
    return Boolean(shared) && generation === this.generation;
  }

  revoke() { this.generation++; }
}
