/**
 * Binance order-book sync.
 *
 * Implements the documented procedure so the visible book and the liquidity
 * events are consistent:
 *   1. Fetch a REST depth snapshot (lastUpdateId, sizes seeded).
 *   2. Buffer diff events received while the snapshot is in flight.
 *   3. Drop events with u <= lastUpdateId; the first applied event must satisfy
 *      U <= lastUpdateId + 1 <= u.
 *   4. Every subsequent event must continue the sequence (U <= prev_u + 1 <= u);
 *      a gap triggers an automatic resync.
 *
 * Emits only the levels that actually changed, with their previous size, so the
 * consumer gets exact executed / cancelled / replenished semantics.
 */

export type BookSide = 'BID' | 'ASK';

export interface DepthChange {
  price: number;
  side: BookSide;
  before: number;
  after: number;
}

export interface DepthEvent {
  /** First update id covered by this event. */
  U: number;
  /** Final update id covered by this event. */
  u: number;
  /** Previous final update id (futures only). */
  pu?: number;
  b: [string, string][];
  a: [string, string][];
  E: number;
}

interface Options {
  symbol: string;              // lower-case, e.g. "btcusdt"
  restUrl: string;             // e.g. "https://api.binance.com/api/v3/depth"
  limit?: number;              // snapshot depth (default 1000)
  onChanges: (changes: DepthChange[], seq: number, ts: number) => void;
  onStatus?: (status: 'syncing' | 'live' | 'resync') => void;
}

export class BookSync {
  private sizes = new Map<string, number>();
  private lastUpdateId = 0;
  private buffer: DepthEvent[] = [];
  private stopped = false;
  private syncing = false;

  constructor(private opts: Options) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    this.syncing = true;
    this.opts.onStatus?.('syncing');
    try {
      const url = `${this.opts.restUrl}?symbol=${this.opts.symbol.toUpperCase()}&limit=${this.opts.limit ?? 1000}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const snap = await res.json();

      this.sizes.clear();
      (snap.bids || []).forEach(([p, q]: [string, string]) => this.sizes.set(`BID:${p}`, parseFloat(q)));
      (snap.asks || []).forEach(([p, q]: [string, string]) => this.sizes.set(`ASK:${p}`, parseFloat(q)));
      this.lastUpdateId = Number(snap.lastUpdateId) || 0;

      // Replay anything that arrived while the snapshot was in flight.
      const buffered = this.buffer;
      this.buffer = [];
      this.syncing = false;
      for (const ev of buffered) this.apply(ev);
      this.opts.onStatus?.('live');
    } catch {
      this.syncing = false;
      // Retry shortly; diffs keep buffering meanwhile.
      if (!this.stopped) setTimeout(() => this.start(), 2000);
    }
  }

  push(ev: DepthEvent): void {
    if (this.stopped) return;
    if (this.syncing || this.lastUpdateId === 0) {
      this.buffer.push(ev);
      if (this.buffer.length > 4000) this.buffer.shift();
      return;
    }
    this.apply(ev);
  }

  stop(): void { this.stopped = true; this.buffer = []; }

  private apply(ev: DepthEvent): void {
    // 3a. Skip events already covered by the snapshot.
    if (ev.u <= this.lastUpdateId) return;

    // 3b. First event must straddle the snapshot id.
    const needFirst = this.lastUpdateId !== 0;
    const straddles = ev.U <= this.lastUpdateId + 1 && ev.u >= this.lastUpdateId + 1;
    const continues = ev.U <= this.lastUpdateId + 1; // subsequent events continue from prev u
    if (needFirst && !(straddles || continues)) {
      // 4. Gap detected → resync.
      this.opts.onStatus?.('resync');
      this.lastUpdateId = 0;
      void this.start();
      return;
    }
    // Futures exposes `pu`; use it when present as an extra continuity check.
    if (ev.pu !== undefined && ev.pu !== this.lastUpdateId && this.lastUpdateId !== 0) {
      this.opts.onStatus?.('resync');
      this.lastUpdateId = 0;
      void this.start();
      return;
    }

    const changes: DepthChange[] = [];
    const scan = (rows: [string, string][], side: BookSide) => {
      (rows || []).forEach(([p, q]) => {
        const price = parseFloat(p);
        const after = parseFloat(q);
        const key = `${side}:${p}`;
        const before = this.sizes.get(key) ?? 0;
        if (Math.abs(after - before) < 1e-9) return;
        this.sizes.set(key, after);
        changes.push({ price, side, before, after });
      });
    };
    scan(ev.b, 'BID');
    scan(ev.a, 'ASK');

    this.lastUpdateId = ev.u;
    if (changes.length) this.opts.onChanges(changes, ev.u, ev.E);
  }
}
