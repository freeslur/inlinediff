import { describe, expect, test } from "bun:test";
import { KeptHunkStore } from "../../src/views/kept-hunk-store.ts";

describe("KeptHunkStore", () => {
  test("toggles and lists kept hunk ids for one file", () => {
    const store = new KeptHunkStore();
    let events = 0;
    store.onDidChange(() => {
      events += 1;
    });

    expect(store.isKept("C:/project", "src/app.ts", "hunk-a")).toBe(false);

    expect(store.toggle("C:/project", "src/app.ts", "hunk-a")).toBe(true);
    expect(store.isKept("C:/project", "src/app.ts", "hunk-a")).toBe(true);
    expect(store.keptIdsFor("C:/project", "src/app.ts")).toEqual(new Set(["hunk-a"]));

    expect(store.toggle("C:/project", "src/app.ts", "hunk-a")).toBe(false);
    expect(store.isKept("C:/project", "src/app.ts", "hunk-a")).toBe(false);
    expect(store.keptIdsFor("C:/project", "src/app.ts")).toEqual(new Set());
    expect(events).toBe(2);
  });

  test("retains only live hunk ids for one file", () => {
    const store = new KeptHunkStore();
    store.setKept("C:/project", "src/app.ts", "live", true);
    store.setKept("C:/project", "src/app.ts", "stale", true);
    store.setKept("C:/project", "src/other.ts", "stale", true);

    store.retainHunks("C:/project", "src/app.ts", new Set(["live"]));

    expect(store.keptIdsFor("C:/project", "src/app.ts")).toEqual(new Set(["live"]));
    expect(store.keptIdsFor("C:/project", "src/other.ts")).toEqual(new Set(["stale"]));
  });
});
