import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// subscribe reads location and WebSocket at call time, so stubs are enough;
// location is merged, not replaced: other test files stub their own fields
(globalThis as { location?: unknown }).location = {
  ...((globalThis as { location?: object }).location ?? {}),
  protocol: "http:",
  host: "app.test",
};

// close() leaves CLOSING, not CLOSED: the handshake is asynchronous, and a
// guard that reads readyState instead of the channel's own flag misses that
// window and parks the message forever
class FakeWS {
  static instances: FakeWS[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {
    this.readyState = FakeWS.CLOSING;
  }
  /** the server went away, or the close handshake finished */
  drop() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
}

// captured with its delay: a stub that drops it asserts nothing about backoff
function withFakeTimers(id = 42) {
  const pending: Array<{ fn: () => void; delay: number }> = [];
  const cleared: unknown[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    pending.push({ fn, delay });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    cleared.push(handle);
  }) as unknown as typeof clearTimeout;
  return {
    pending,
    cleared,
    id,
    delays: () => pending.map((t) => t.delay),
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
(globalThis as { WebSocket: unknown }).WebSocket = FakeWS;

const { subscribe } = await import("../src/index");

afterAll(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

beforeEach(() => {
  FakeWS.instances.length = 0;
});

describe("subscribe", () => {
  test("dispatches only the subscribed topic and survives malformed frames", () => {
    const seen: Array<[string, unknown]> = [];
    const channel = subscribe("chat", (event: string, data: unknown) => seen.push([event, data]));
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe("ws://app.test/ws?topics=chat");
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ topic: "chat", event: "msg", data: 1 }) });
    ws.onmessage?.({ data: JSON.stringify({ topic: "other", event: "msg", data: 2 }) });
    ws.onmessage?.({ data: "not json{" });
    expect(seen).toEqual([["msg", 1]]);
    channel.close();
  });

  test("publish before open queues and flushes on open", () => {
    const channel = subscribe("chat", () => {});
    const ws = FakeWS.instances[0];
    channel.publish("typed", true);
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent).toEqual([JSON.stringify({ topic: "chat", event: "typed", data: true })]);
    channel.close();
  });

  test("a dropped connection reconnects with backoff", () => {
    const dial = withFakeTimers();
    try {
      const channel = subscribe("chat", () => {});
      for (let i = 0; i < 6; i++) {
        FakeWS.instances.at(-1)!.drop();
        expect(dial.pending.length).toBe(i + 1);
        dial.pending.at(-1)!.fn();
      }
      expect(FakeWS.instances.length).toBe(7);
      expect(dial.delays()).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
      channel.close();
    } finally {
      dial.restore();
    }
  });

  test("a successful open puts the backoff back on the floor", () => {
    const dial = withFakeTimers();
    try {
      const channel = subscribe("chat", () => {});
      // two opens, and the second from a deeper run of failures than the first.
      // one open cannot tell "reset on every success" from "reset on the first
      // ever"; one depth cannot tell a reset from a decrement that happens to
      // land on zero, and this one is 8 then 10 deep
      for (const round of [1, 2]) {
        for (let i = 0; i < 8; i++) {
          FakeWS.instances.at(-1)!.drop();
          dial.pending.at(-1)!.fn();
        }
        expect(dial.delays().at(-1)).toBe(30_000);
        FakeWS.instances.at(-1)!.open();
        // two drops, not one: only a zeroed counter restarts the doubling
        const afterOpen = dial.delays().length;
        for (let i = 0; i < 2; i++) {
          FakeWS.instances.at(-1)!.drop();
          dial.pending.at(-1)!.fn();
        }
        expect(`round ${round}: ${dial.delays().slice(afterOpen)}`).toBe(`round ${round}: 1000,2000`);
      }
      channel.close();
    } finally {
      dial.restore();
    }
  });

  test("close during the reconnect backoff cancels the redial for good", () => {
    const dial = withFakeTimers();
    try {
      const channel = subscribe("chat", () => {});
      FakeWS.instances[0].drop(); // server drops: a reconnect is now pending
      expect(dial.pending.length).toBe(1);
      channel.close();
      expect(dial.cleared).toContain(dial.id);
      // even if the timer had already fired, connect must refuse to dial
      for (const timer of dial.pending) timer.fn();
      expect(FakeWS.instances.length).toBe(1);
    } finally {
      dial.restore();
    }
  });

  test("publish after close is dropped, not queued forever", () => {
    const channel = subscribe("chat", () => {});
    const ws = FakeWS.instances[0];
    ws.open();
    channel.close();
    channel.publish("late", 1);
    expect(ws.sent).toEqual([]);
    // dropped and queued both leave `sent` empty, so drive the flush: a
    // parked message comes out here
    ws.open();
    expect(ws.sent).toEqual([]);
    expect(FakeWS.instances.length).toBe(1);
  });
});
