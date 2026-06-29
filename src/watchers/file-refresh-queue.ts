export interface RefreshTimer {
  cancel(): void;
}

export interface RefreshTimerScheduler {
  setTimeout(callback: () => void, delayMilliseconds: number): RefreshTimer;
}

export interface FileRefreshQueueOptions<T> {
  readonly debounceMilliseconds: number;
  readonly keyFor: (value: T) => string;
  readonly maxWaitMilliseconds: number;
  readonly onError: (error: unknown, value: T) => void;
  readonly onRefresh: (value: T) => Promise<void>;
  readonly scheduler?: RefreshTimerScheduler;
}

interface PendingFile<T> {
  readonly debounceTimer: RefreshTimer;
  readonly firstTimer: RefreshTimer;
  readonly value: T;
}

type RefreshResult<T> =
  | {
      readonly error: unknown;
      readonly kind: "failed";
      readonly value: T;
    }
  | {
      readonly kind: "refreshed";
    };

export class FileRefreshQueue<T> {
  readonly #debounceMilliseconds: number;
  readonly #keyFor: (value: T) => string;
  readonly #maxWaitMilliseconds: number;
  readonly #onError: (error: unknown, value: T) => void;
  readonly #onRefresh: (value: T) => Promise<void>;
  readonly #pending = new Map<string, PendingFile<T>>();
  readonly #queued = new Map<string, T>();
  #running = false;
  readonly #scheduler: RefreshTimerScheduler;

  constructor(options: FileRefreshQueueOptions<T>) {
    this.#debounceMilliseconds = options.debounceMilliseconds;
    this.#keyFor = options.keyFor;
    this.#maxWaitMilliseconds = options.maxWaitMilliseconds;
    this.#onError = options.onError;
    this.#onRefresh = options.onRefresh;
    this.#scheduler = options.scheduler ?? defaultRefreshTimerScheduler;
  }

  add(value: T): void {
    const key = this.#keyFor(value);
    const previous = this.#pending.get(key);
    previous?.debounceTimer.cancel();

    const firstTimer =
      previous?.firstTimer ??
      this.#scheduler.setTimeout(() => this.#flushPending(key), this.#maxWaitMilliseconds);
    this.#pending.set(key, {
      debounceTimer: this.#scheduler.setTimeout(
        () => this.#flushPending(key),
        this.#debounceMilliseconds,
      ),
      firstTimer,
      value,
    });
  }

  dispose(): void {
    for (const pending of this.#pending.values()) {
      pending.debounceTimer.cancel();
      pending.firstTimer.cancel();
    }
    this.#pending.clear();
    this.#queued.clear();
  }

  #flushPending(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      return;
    }

    pending.debounceTimer.cancel();
    pending.firstTimer.cancel();
    this.#pending.delete(key);
    this.#queued.set(key, pending.value);
    void this.#run();
  }

  async #run(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;
    try {
      while (this.#queued.size > 0) {
        const next = this.#takeNextQueued();
        if (next === undefined) {
          return;
        }
        const result = await this.#refresh(next);
        switch (result.kind) {
          case "failed":
            this.#onError(result.error, result.value);
            break;
          case "refreshed":
            break;
          default:
            assertNever(result);
        }
      }
    } finally {
      this.#running = false;
      if (this.#queued.size > 0) {
        void this.#run();
      }
    }
  }

  #takeNextQueued(): T | undefined {
    const iterator = this.#queued.entries().next();
    if (iterator.done === true) {
      return undefined;
    }
    const [key, value] = iterator.value;
    this.#queued.delete(key);
    return value;
  }

  #refresh(value: T): Promise<RefreshResult<T>> {
    return this.#onRefresh(value).then<RefreshResult<T>, RefreshResult<T>>(
      () => ({ kind: "refreshed" }),
      (error: unknown) => ({ error, kind: "failed", value }),
    );
  }
}

const defaultRefreshTimerScheduler: RefreshTimerScheduler = {
  setTimeout(callback, delayMilliseconds) {
    const timer = setTimeout(callback, delayMilliseconds);
    return {
      cancel: () => clearTimeout(timer),
    };
  },
};

function assertNever(value: never): never {
  throw new Error(`Unexpected refresh result: ${String(value)}`);
}
