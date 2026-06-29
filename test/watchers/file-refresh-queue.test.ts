import { describe, expect, test } from "bun:test";
import {
  FileRefreshQueue,
  type RefreshTimer,
  type RefreshTimerScheduler,
} from "../../src/watchers/file-refresh-queue.ts";

describe("FileRefreshQueue", () => {
  test("enqueues a stable file without waiting for another file debounce", () => {
    const scheduler = new ManualRefreshScheduler();
    const refreshed: string[] = [];
    const queue = new FileRefreshQueue<string>({
      debounceMilliseconds: 150,
      keyFor: (file) => file,
      maxWaitMilliseconds: 1_000,
      onError: failOnRefreshError,
      onRefresh: async (file) => {
        refreshed.push(file);
      },
      scheduler,
    });

    queue.add("A");
    scheduler.advanceBy(100);
    queue.add("B");

    scheduler.advanceBy(50);

    expect(refreshed).toEqual(["A"]);
  });

  test("runs one file refresh at a time", async () => {
    const scheduler = new ManualRefreshScheduler();
    const allowFirstRefreshToFinish = createDeferred();
    const secondRefreshStarted = createDeferred();
    const events: string[] = [];
    const queue = new FileRefreshQueue<string>({
      debounceMilliseconds: 150,
      keyFor: (file) => file,
      maxWaitMilliseconds: 1_000,
      onError: failOnRefreshError,
      onRefresh: async (file) => {
        events.push(`start:${file}`);
        if (file === "A") {
          await allowFirstRefreshToFinish.promise;
        }
        if (file === "B") {
          secondRefreshStarted.resolve();
        }
      },
      scheduler,
    });

    queue.add("A");
    scheduler.advanceBy(150);
    queue.add("B");
    scheduler.advanceBy(150);

    expect(events).toEqual(["start:A"]);

    allowFirstRefreshToFinish.resolve();
    await secondRefreshStarted.promise;

    expect(events).toEqual(["start:A", "start:B"]);
  });

  test("uses max wait when one file keeps changing before debounce elapses", () => {
    const scheduler = new ManualRefreshScheduler();
    const refreshed: string[] = [];
    const queue = new FileRefreshQueue<string>({
      debounceMilliseconds: 100,
      keyFor: (file) => file,
      maxWaitMilliseconds: 250,
      onError: failOnRefreshError,
      onRefresh: async (file) => {
        refreshed.push(file);
      },
      scheduler,
    });

    queue.add("A");
    scheduler.advanceBy(90);
    queue.add("A");
    scheduler.advanceBy(90);
    queue.add("A");
    scheduler.advanceBy(70);

    expect(refreshed).toEqual(["A"]);
  });

  test("queues a file again when it changes while that file is refreshing", async () => {
    const scheduler = new ManualRefreshScheduler();
    const allowFirstRefreshToFinish = createDeferred();
    const secondRefreshStarted = createDeferred();
    const events: string[] = [];
    const queue = new FileRefreshQueue<string>({
      debounceMilliseconds: 150,
      keyFor: (file) => file,
      maxWaitMilliseconds: 1_000,
      onError: failOnRefreshError,
      onRefresh: async (file) => {
        events.push(`start:${file}`);
        if (events.length === 1) {
          await allowFirstRefreshToFinish.promise;
          return;
        }
        secondRefreshStarted.resolve();
      },
      scheduler,
    });

    queue.add("A");
    scheduler.advanceBy(150);
    queue.add("A");
    scheduler.advanceBy(150);

    expect(events).toEqual(["start:A"]);

    allowFirstRefreshToFinish.resolve();
    await secondRefreshStarted.promise;

    expect(events).toEqual(["start:A", "start:A"]);
  });

  test("reports a failed refresh and continues with queued files", async () => {
    const scheduler = new ManualRefreshScheduler();
    const secondRefreshStarted = createDeferred();
    const errors: string[] = [];
    const events: string[] = [];
    const queue = new FileRefreshQueue<string>({
      debounceMilliseconds: 150,
      keyFor: (file) => file,
      maxWaitMilliseconds: 1_000,
      onError: (error, file) => {
        if (error instanceof Error) {
          errors.push(`${file}:${error.message}`);
          return;
        }
        throw error;
      },
      onRefresh: async (file) => {
        events.push(`start:${file}`);
        if (file === "A") {
          throw new Error("failed");
        }
        secondRefreshStarted.resolve();
      },
      scheduler,
    });

    queue.add("A");
    scheduler.advanceBy(150);
    queue.add("B");
    scheduler.advanceBy(150);
    await secondRefreshStarted.promise;

    expect(events).toEqual(["start:A", "start:B"]);
    expect(errors).toEqual(["A:failed"]);
  });
});

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Deferred promise resolver was not initialized.");
  }
  return { promise, resolve: resolvePromise };
}

function failOnRefreshError(error: unknown): void {
  if (error instanceof Error) {
    throw error;
  }
  throw new Error("Refresh failed with a non-Error rejection.");
}

interface ManualTimer {
  readonly callback: () => void;
  readonly dueMilliseconds: number;
  readonly id: number;
}

class ManualRefreshScheduler implements RefreshTimerScheduler {
  #nowMilliseconds = 0;
  #nextTimerId = 0;
  readonly #timers = new Map<number, ManualTimer>();

  setTimeout(callback: () => void, delayMilliseconds: number): RefreshTimer {
    const id = this.#nextTimerId;
    this.#nextTimerId += 1;
    this.#timers.set(id, {
      callback,
      dueMilliseconds: this.#nowMilliseconds + delayMilliseconds,
      id,
    });
    return {
      cancel: () => {
        this.#timers.delete(id);
      },
    };
  }

  advanceBy(milliseconds: number): void {
    const targetMilliseconds = this.#nowMilliseconds + milliseconds;
    while (true) {
      const nextTimer = this.#nextDueTimer(targetMilliseconds);
      if (nextTimer === undefined) {
        break;
      }
      this.#nowMilliseconds = nextTimer.dueMilliseconds;
      this.#timers.delete(nextTimer.id);
      nextTimer.callback();
    }
    this.#nowMilliseconds = targetMilliseconds;
  }

  #nextDueTimer(targetMilliseconds: number): ManualTimer | undefined {
    let nextTimer: ManualTimer | undefined;
    for (const timer of this.#timers.values()) {
      if (timer.dueMilliseconds > targetMilliseconds) {
        continue;
      }
      if (
        nextTimer === undefined ||
        timer.dueMilliseconds < nextTimer.dueMilliseconds ||
        (timer.dueMilliseconds === nextTimer.dueMilliseconds && timer.id < nextTimer.id)
      ) {
        nextTimer = timer;
      }
    }
    return nextTimer;
  }
}
