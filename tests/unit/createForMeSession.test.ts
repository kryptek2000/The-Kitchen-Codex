import { describe, it, expect } from "vitest";
import {
  createCreateForMeSession,
  runGuarded,
} from "../../src/application/createForMeSession.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("Create for Me session liveness (v0.7 2A correction 3)", () => {
  it("a generation success that resolves AFTER session invalidation is dropped", async () => {
    const session = createCreateForMeSession();
    const results: string[] = [];
    const errors: string[] = [];
    const gate = deferred<"ok">();
    const run = runGuarded(session, () => gate.promise, (v: "ok") => results.push(v), (e) => errors.push(String(e)));
    // Modal closes (session invalidated) while the request is in flight.
    session.advance();
    gate.resolve("ok");
    await run;
    expect(results).toEqual([]); // no GENERATION_SUCCESS dispatch
    expect(errors).toEqual([]);
  });

  it("a generation failure that rejects AFTER session invalidation is dropped", async () => {
    const session = createCreateForMeSession();
    const results: string[] = [];
    const errors: string[] = [];
    const gate = deferred<never>();
    const run = runGuarded(session, () => gate.promise, (v) => results.push(String(v)), (e) => errors.push(String(e)));
    session.advance();
    gate.reject(new Error("boom"));
    await run;
    expect(results).toEqual([]);
    expect(errors).toEqual([]); // no GENERATION_FAILURE dispatch (no stale error)
  });

  it("a save collision that rejects AFTER session invalidation is dropped", async () => {
    const session = createCreateForMeSession();
    const res: string[] = [];
    const errs: string[] = [];
    const gate = deferred<void>();
    const run = runGuarded(session, () => gate.promise, () => res.push("saved"), (e) => errs.push(String(e)));
    session.advance();
    gate.reject(new Error("collision"));
    await run;
    expect(res).toEqual([]);
    expect(errs).toEqual([]); // no SAVE_COLLISION resurrect
  });

  it("persistence may complete even though the dropped UI state stays clean", async () => {
    const session = createCreateForMeSession();
    const res: string[] = [];
    let wrote = false;
    const gate = deferred<void>();
    const run = runGuarded(session, () => gate.promise.then(() => { wrote = true; }), () => res.push("saved"), () => res.push("error"));
    session.advance();
    gate.resolve();
    await run;
    // The underlying operation DID finish (write may persist)...
    expect(wrote).toBe(true);
    // ...but the closed session's result is not dispatched into modal state.
    expect(res).toEqual([]);
  });

  it("a NEW session (reopen) can still dispatch its own later request (epoch not permanently suppressed)", async () => {
    const session = createCreateForMeSession();
    const res: string[] = [];
    const gate1 = deferred<"first">();
    const run1 = runGuarded(session, () => gate1.promise, (v: "first") => res.push(v), () => res.push("E1"));
    session.advance(); // close / reopen
    const gate2 = deferred<"second">();
    const run2 = runGuarded(session, () => gate2.promise, (v: "second") => res.push(v), () => res.push("E2"));
    gate1.resolve("first"); // stale session-1 result
    await run1;
    expect(res).toEqual([]);
    gate2.resolve("second"); // current session-2 result
    await run2;
    expect(res).toEqual(["second"]); // only the new session's result shows
  });

  it("advance clears the busy (save-in-flight) guard so a reopened modal can save", async () => {
    const session = createCreateForMeSession();
    session.setBusy(true);
    expect(session.isBusy()).toBe(true);
    session.advance(); // close/discard/reopen
    expect(session.isBusy()).toBe(false);
    session.setBusy(true);
    session.setBusy(false);
    expect(session.isBusy()).toBe(false);
  });

  it("a result in a STILL-CURRENT session is dispatched normally", async () => {
    const session = createCreateForMeSession();
    const res: string[] = [];
    const errs: string[] = [];
    const gate = deferred<"draft">();
    const run = runGuarded(session, () => gate.promise, (v: "draft") => res.push(v), (e) => errs.push(String(e)));
    gate.resolve("draft");
    await run;
    expect(res).toEqual(["draft"]);
    expect(errs).toEqual([]);
  });

  it("isCurrent reflects advance and begin captures the active epoch", () => {
    const session = createCreateForMeSession();
    const e1 = session.begin();
    expect(session.isCurrent(e1)).toBe(true);
    session.advance();
    expect(session.isCurrent(e1)).toBe(false);
    const e2 = session.begin();
    expect(session.isCurrent(e2)).toBe(true);
  });
});
