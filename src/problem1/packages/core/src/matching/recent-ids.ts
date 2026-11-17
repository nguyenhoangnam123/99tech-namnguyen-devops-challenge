// Bounded memory of recent command ids, evicting the oldest first.
// Deterministic, so replaying the same log rebuilds the same set.
export class RecentIds {
  private readonly seen = new Set<string>();
  private readonly ring: (string | undefined)[];
  private next = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError('capacity must be positive');
    this.ring = new Array<string | undefined>(capacity);
  }

  /** Returns false when the id was already remembered. */
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    const evicted = this.ring[this.next];
    if (evicted !== undefined) this.seen.delete(evicted);
    this.ring[this.next] = id;
    this.next = (this.next + 1) % this.ring.length;
    this.seen.add(id);
    return true;
  }
}
