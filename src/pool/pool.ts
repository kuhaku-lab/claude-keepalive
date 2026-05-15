import { EventEmitter } from 'node:events';
import { KeepaliveError } from '../api/errors.js';
import type { EvictionReason } from '../api/types.js';
import type { Clock, Sleeper } from '../core/clock.js';
import type { Session, SessionFactory } from '../session/index.js';

export interface PoolOptions {
  size: number;
  maxRequestsPerSession: number;
  maxSessionAgeMs: number;
  maxIdleMs: number;
  acquireTimeoutMs: number;
  spawnTimeoutMs: number;
}

export const defaultPoolOptions: PoolOptions = {
  size: 1,
  // 50 caps context-history drift on a single warm session. The system-prompt
  // contract tells the agent to treat each turn as independent, but claude's
  // attention window still includes prior turns until we evict. 50 × per-turn
  // tokens stays well under the 200K context window. See TODO #1.
  maxRequestsPerSession: 50,
  maxSessionAgeMs: 60 * 60 * 1000,
  maxIdleMs: 10 * 60 * 1000,
  acquireTimeoutMs: 30_000,
  spawnTimeoutMs: 30_000,
};

interface SessionEntry {
  session: Session;
  idleSince: number | null;
  busy: boolean;
}

interface Waiter {
  resolve: (session: Session) => void;
  reject: (err: Error) => void;
  requestId: string;
  expiresAt: number;
  signal?: AbortSignal | undefined;
  cleanupSignal?: () => void;
}

export interface PoolEvents {
  'session.spawned': (info: { sessionId: string }) => void;
  'session.evicted': (info: { sessionId: string; reason: EvictionReason }) => void;
}

export class Pool {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly waiters: Waiter[] = [];
  private readonly emitter = new EventEmitter();
  private closed = false;

  constructor(
    private readonly opts: PoolOptions,
    private readonly deps: {
      factory: SessionFactory;
      clock: Clock;
      sleeper: Sleeper;
    },
  ) {}

  on<E extends keyof PoolEvents>(event: E, listener: PoolEvents[E]): void {
    this.emitter.on(event, listener);
  }

  off<E extends keyof PoolEvents>(event: E, listener: PoolEvents[E]): void {
    this.emitter.off(event, listener);
  }

  async acquire(opts: { requestId: string; signal?: AbortSignal }): Promise<Session> {
    if (this.closed) {
      throw new KeepaliveError('POOL_EXHAUSTED', 'pool is closed', opts.requestId);
    }

    // 1. LRU idle pick
    const idle = this.pickLruIdle();
    if (idle) {
      idle.busy = true;
      idle.idleSince = null;
      return idle.session;
    }

    // 2. Under-size — spawn new
    if (this.entries.size < this.opts.size) {
      const session = await this.spawnTracked();
      const entry = this.entries.get(session.id);
      if (entry) {
        entry.busy = true;
        entry.idleSince = null;
      }
      return session;
    }

    // 3. Force recycle if any session is over its budget right now
    const recyclable = this.pickRecyclable();
    if (recyclable) {
      this.evict(recyclable.session.id, recyclable.reason);
      const session = await this.spawnTracked();
      const entry = this.entries.get(session.id);
      if (entry) {
        entry.busy = true;
        entry.idleSince = null;
      }
      return session;
    }

    // 4. Queue and wait
    return this.enqueue(opts);
  }

  release(session: Session, opts: { dirty: boolean }): void {
    const entry = this.entries.get(session.id);
    if (!entry) return;

    if (opts.dirty) {
      this.evict(session.id, 'dirty');
      this.drainWaiters();
      return;
    }

    // Recycle if over budget at release time
    const reason = this.recycleReason(entry);
    if (reason) {
      this.evict(session.id, reason);
      this.drainWaiters();
      return;
    }

    entry.busy = false;
    entry.idleSince = this.deps.clock.now();
    this.drainWaiters();
  }

  /** Force-evict any session whose idle time has exceeded maxIdleMs. */
  reapIdle(): void {
    const now = this.deps.clock.now();
    for (const entry of [...this.entries.values()]) {
      if (!entry.busy && entry.idleSince !== null && now - entry.idleSince > this.opts.maxIdleMs) {
        this.evict(entry.session.id, 'max_idle');
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const w of this.waiters.splice(0)) {
      w.cleanupSignal?.();
      w.reject(new KeepaliveError('POOL_EXHAUSTED', 'pool closed', w.requestId));
    }

    const ids = [...this.entries.keys()];
    for (const id of ids) {
      this.evict(id, 'closed');
    }
  }

  private pickLruIdle(): SessionEntry | undefined {
    let best: SessionEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.busy || entry.idleSince === null) continue;
      if (this.recycleReason(entry)) continue;
      if (!best || entry.idleSince < (best.idleSince ?? Infinity)) best = entry;
    }
    return best;
  }

  private pickRecyclable(): { session: Session; reason: EvictionReason } | undefined {
    for (const entry of this.entries.values()) {
      if (entry.busy) continue;
      const reason = this.recycleReason(entry);
      if (reason) return { session: entry.session, reason };
    }
    return undefined;
  }

  private recycleReason(entry: SessionEntry): EvictionReason | undefined {
    const now = this.deps.clock.now();
    if (entry.session.requestsServed >= this.opts.maxRequestsPerSession) return 'max_requests';
    if (now - entry.session.spawnedAt >= this.opts.maxSessionAgeMs) return 'max_age';
    if (entry.idleSince !== null && now - entry.idleSince >= this.opts.maxIdleMs) return 'max_idle';
    return undefined;
  }

  private async spawnTracked(): Promise<Session> {
    const session = await this.deps.factory.spawn();
    this.entries.set(session.id, {
      session,
      idleSince: this.deps.clock.now(),
      busy: false,
    });
    session.on('crash', () => {
      if (this.entries.has(session.id)) {
        this.evict(session.id, 'crashed');
        this.drainWaiters();
      }
    });
    this.emitter.emit('session.spawned', { sessionId: session.id });
    return session;
  }

  private evict(id: string, reason: EvictionReason): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    void entry.session.destroy().catch(() => {
      /* best effort */
    });
    this.emitter.emit('session.evicted', { sessionId: id, reason });
  }

  private enqueue(opts: { requestId: string; signal?: AbortSignal }): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
      const expiresAt = this.deps.clock.now() + this.opts.acquireTimeoutMs;
      const waiter: Waiter = {
        resolve,
        reject,
        requestId: opts.requestId,
        expiresAt,
        signal: opts.signal,
      };

      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        waiter.cleanupSignal?.();
        reject(
          new KeepaliveError(
            'POOL_EXHAUSTED',
            `no session available within ${this.opts.acquireTimeoutMs}ms`,
            opts.requestId,
          ),
        );
      }, this.opts.acquireTimeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.removeWaiter(waiter);
        reject(new KeepaliveError('ABORTED', 'acquire aborted', opts.requestId));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer);
          reject(new KeepaliveError('ABORTED', 'acquire aborted', opts.requestId));
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanupSignal = () => opts.signal?.removeEventListener('abort', onAbort);
      }

      waiter.cleanupSignal = (() => {
        const existing = waiter.cleanupSignal;
        return () => {
          clearTimeout(timer);
          existing?.();
        };
      })();

      this.waiters.push(waiter);
    });
  }

  private removeWaiter(w: Waiter): void {
    const idx = this.waiters.indexOf(w);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0) {
      const idle = this.pickLruIdle();
      const canSpawn = this.entries.size < this.opts.size;
      if (!idle && !canSpawn) return;

      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.cleanupSignal?.();

      if (idle) {
        idle.busy = true;
        idle.idleSince = null;
        waiter.resolve(idle.session);
        continue;
      }
      // Spawn for waiter
      this.spawnTracked()
        .then((session) => {
          const entry = this.entries.get(session.id);
          if (entry) {
            entry.busy = true;
            entry.idleSince = null;
          }
          waiter.resolve(session);
        })
        .catch((err: unknown) => {
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        });
    }
  }
}
