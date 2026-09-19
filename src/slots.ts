/**
 * A fixed number of browser-context slots, the real memory limit, shared fairly between runs.
 *
 * Waiters are grouped by key (the run id). When a slot frees up it goes to the next key in
 * rotation, not the longest queue, so a 100-session run cannot starve a 4-session run submitted
 * after it. Each slot has a stable index, which --watch uses to pick a screen tile.
 */
export interface Slot {
  readonly index: number;
  release(): void;
}

export class FairSlots {
  readonly capacity: number;
  readonly #free: number[];
  /** Waiting acquirers per key, in arrival order. Map iteration order is the rotation order. */
  readonly #waiting = new Map<string, ((slot: Slot) => void)[]>();

  constructor(capacity: number) {
    if (!(capacity >= 1)) throw new Error("capacity must be >= 1");
    this.capacity = capacity;
    this.#free = Array.from({ length: capacity }, (_, i) => i);
  }

  get inUse(): number {
    return this.capacity - this.#free.length;
  }

  acquire(key: string): Promise<Slot> {
    const index = this.#free.shift();
    if (index !== undefined) return Promise.resolve(this.#slot(index));
    return new Promise((resolve) => {
      const queue = this.#waiting.get(key) ?? [];
      queue.push(resolve);
      this.#waiting.set(key, queue);
    });
  }

  #slot(index: number): Slot {
    let released = false;
    return {
      index,
      release: () => {
        if (released) return;
        released = true;
        this.#grant(index);
      },
    };
  }

  #grant(index: number): void {
    const next = this.#waiting.entries().next();
    if (next.done) {
      this.#free.push(index);
      this.#free.sort((a, b) => a - b);
      return;
    }
    const [key, queue] = next.value;
    const resolve = queue.shift()!;
    // Rotate: this key moves to the back, so the next free slot goes to a different run.
    this.#waiting.delete(key);
    if (queue.length) this.#waiting.set(key, queue);
    resolve(this.#slot(index));
  }
}
