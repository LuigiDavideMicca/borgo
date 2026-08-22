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
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {
    this.readyState = FakeWS.CLOSING;
  }
  /** the server went away, or the close handshake finished; a browser reports 1006 */
  drop(code = 1006, reason = "") {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({ code, reason });
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

  // WHAT THE REDIAL DELIBERATELY DOES NOT TRY TO BE CLEVER ABOUT.
  //
  // A handshake the server refuses and a server that is not there arrive here
  // as the same event: onclose, with nothing opened, and no status to read
  // (measured on a live front server with a bun client - close code 1002 and an
  // empty-handed reason; 1006 in a browser). The refusals a CALL can cause are settled
  // before the dial instead, above; what is left is a close this code cannot
  // classify, and the safe reading of an unclassifiable close is "the server
  // will be back". A channel that guessed "permanent" and stopped would be a
  // page that never reconnects after a deploy.
  test("a handshake that never opened keeps being retried, so a server that comes back is picked up", () => {
    const dial = withFakeTimers();
    try {
      const seen: Array<[string, unknown]> = [];
      const channel = subscribe("chat", (event: string, data: unknown) => seen.push([event, data]));
      // four refusals in a row, none of which ever reached open()
      for (let i = 0; i < 4; i++) {
        FakeWS.instances.at(-1)!.drop();
        expect(dial.pending.length).toBe(i + 1);
        dial.pending.at(-1)!.fn();
      }
      expect(FakeWS.instances.length).toBe(5);
      // and the server comes back: the redial that was still coming connects
      FakeWS.instances.at(-1)!.open();
      const healthy = FakeWS.instances.at(-1)!;
      healthy.onmessage?.({ data: JSON.stringify({ topic: "chat", event: "msg", data: 1 }) });
      expect(healthy.readyState).toBe(FakeWS.OPEN);
      expect(seen).toEqual([["msg", 1]]);
      channel.close();
    } finally {
      dial.restore();
    }
  });

  // THE ONE CLOSE THAT IS FINAL, AND ONLY THAT ONE. The relay answers an origin
  // it does not accept by upgrading and closing with 4403 and a reason - the
  // only refusal whose code reaches the client (a 400 or a 403 arrives as 1006
  // with nothing). Direction, written before the test: a permanent refusal
  // generates no further traffic; a non-permanent close never stops retrying.
  // The test above is the guard for the second half and must stay as it is.
  test("a 4403 close is final: no redial, the reason reaches the caller", () => {
    const dial = withFakeTimers();
    try {
      const refusals: string[] = [];
      const channel = subscribe("chat", () => {}, { onRefused: (reason) => refusals.push(reason) });
      expect(FakeWS.instances.length).toBe(1);
      const reason = 'origin "http://other.test" is not this server (app.test): /ws accepts the page\'s own origin only';
      FakeWS.instances[0].drop(4403, reason);
      // nothing scheduled, and a timer that somehow fired would still not dial
      expect(dial.pending.length).toBe(0);
      for (const timer of dial.pending) timer.fn();
      expect(FakeWS.instances.length).toBe(1);
      expect(refusals).toEqual([reason]);
      // the channel is over: a publish after the verdict is dropped, not queued
      channel.publish("msg", 1);
      expect(FakeWS.instances[0].sent).toEqual([]);
      channel.close();
    } finally {
      dial.restore();
    }
  });

  test("without a handler the verdict is still said, once, on the console", () => {
    const dial = withFakeTimers();
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => said.push(args.join(" "));
    try {
      subscribe("chat", () => {});
      FakeWS.instances[0].drop(4403, "origin refused");
      expect(said).toEqual(['subscribe("chat"): origin refused']);
      expect(dial.pending.length).toBe(0);
    } finally {
      console.error = realError;
      dial.restore();
    }
  });

  test("a close one code away from the verdict is not final: 4402, 4404 and 1006 all redial", () => {
    const dial = withFakeTimers();
    try {
      for (const code of [4402, 4404, 1006, 1002]) {
        FakeWS.instances.length = 0;
        dial.pending.length = 0;
        const channel = subscribe("chat", () => {});
        FakeWS.instances[0].drop(code, "whatever");
        expect(dial.pending.length).toBe(1);
        dial.pending[0].fn();
        expect(FakeWS.instances.length).toBe(2);
        channel.close();
      }
    } finally {
      dial.restore();
    }
  });

  test("the client's final code and the relay's are the same number", async () => {
    const dir = import.meta.dir;
    const client = await Bun.file(`${dir}/../src/index.ts`).text();
    const server = await Bun.file(`${dir}/../src/server.ts`).text();
    const clientCode = /const CLOSE_ORIGIN_REFUSED = (\d+);/.exec(client)?.[1];
    const serverCode = /export const WS_CLOSE_ORIGIN_REFUSED = (\d+);/.exec(server)?.[1];
    expect(clientCode).toBeDefined();
    expect(clientCode).toBe(serverCode!);
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

  // THE RELAY'S REFUSAL NEVER REACHES THE PERSON WHO CAUSED IT.
  //
  // /ws?topics=a,b packs topics into one query parameter, so the server splits
  // on the comma and trims each part. A topic carrying a comma became two
  // subscriptions; a padded one became a subscription under a name the
  // onmessage filter (msg.topic === topic) never matches. Both open, both count,
  // neither delivers. The server refuses the comma by name now - into its own
  // log, where nobody developing a page is looking, while the browser is told
  // only that the connection closed. The name is known at the call, so it is
  // said at the call, before any socket is dialled.
  describe("a topic the wire cannot carry is refused here, by name", () => {
    const refused: Array<[label: string, topic: string, says: string]> = [
      ["a single comma", "chat,news", '","'],
      ["a comma between what the caller meant as two topics", "room:1,room:2", '","'],
      ["a trailing comma", "chat,", '","'],
      ["commas and nothing else", ",,,", '","'],
      ["empty", "", "is empty"],
      ["whitespace only", "   ", "is empty"],
      ["a leading space the relay would strip", " chat", "padded with whitespace"],
      ["a trailing newline the relay would strip", "chat\n", "padded with whitespace"],
      ["one character over the relay's length cap", "x".repeat(129), "is 129 characters"],
      ["far over it", "x".repeat(5_000), "is 5000 characters"],
    ];

    for (const [label, topic, says] of refused) {
      test(`${label}: throws, names the topic, and dials nothing`, () => {
        // the topic itself is in the message: a caller staring at "connection
        // closed" had no way to know which of a page's channels it was
        expect(() => subscribe(topic, () => {})).toThrow(`subscribe: topic ${JSON.stringify(topic)}`);
        expect(() => subscribe(topic, () => {})).toThrow(says);
        expect(FakeWS.instances.length).toBe(0);
      });
    }

    test("the guard is the whole reason: a comma used to reach the wire", () => {
      // what the old code sent, and what the server did with it: one parameter
      // whose percent-encoded comma decodes back to a separator
      expect(encodeURIComponent("chat,news")).toBe("chat%2Cnews");
      expect(decodeURIComponent("chat%2Cnews").split(",")).toEqual(["chat", "news"]);
    });

    // what is NOT refused here, and what the caller gets instead
    test("a space or a control character inside a name is carried intact", () => {
      const channel = subscribe("my topic", () => {});
      expect(FakeWS.instances[0].url).toBe("ws://app.test/ws?topics=my%20topic");
      channel.close();
      const lines = subscribe("a\nb", () => {});
      expect(FakeWS.instances[1].url).toBe("ws://app.test/ws?topics=a%0Ab");
      // the relay trims the ends only, so an interior one survives the round
      // trip and the filter matches
      expect(decodeURIComponent("a%0Ab").trim()).toBe("a\nb");
      lines.close();
    });

    // AN OVER-LONG NAME USED TO BE DIALLED FOREVER.
    //
    // The relay answers 400 to it, and a refused handshake reaches the client
    // as a closed connection with no status attached (measured against a live
    // front server with a bun client: close code 1002 "Expected 101 status
    // code", nothing else; a browser gets 1006 with an empty reason by spec -
    // the same shape a server that is simply down produces). onclose cannot
    // tell those apart, so it did
    // what it does for a server that is down: redialled, backing off to thirty
    // seconds, for as long as the tab stayed open. A refusal that will be
    // identical every time, retried forever, for a cause nobody could read.
    //
    // It is settled before the first dial now, at the call, where the topic's
    // length IS knowable. The cap is duplicated in index.ts to do it - and
    // pinned to server.ts's by the coupling test below rather than trusted.
    test("an over-long name never reaches the wire, and says why", () => {
      const long = "x".repeat(129);
      expect(() => subscribe(long, () => {})).toThrow("is 129 characters");
      expect(() => subscribe(long, () => {})).toThrow("redialled forever");
      expect(FakeWS.instances.length).toBe(0);
    });

    test("exactly at the cap is the relay's business as usual: it dials", () => {
      // the boundary belongs to the server, and 128 is accepted there (measured
      // on a live /ws: 128 upgrades, 129 is a 400). A guard that took the
      // boundary with it would refuse a topic that works
      const exact = "x".repeat(128);
      const channel = subscribe(exact, () => {});
      expect(FakeWS.instances[0].url).toBe(`ws://app.test/ws?topics=${exact}`);
      channel.close();
    });

    test("the client's cap and the relay's are the same number", async () => {
      // index.ts is browser code and cannot import the server to ask, so it
      // carries a copy. This is what keeps the copy honest: the two sources are
      // read and compared, and a change to either one alone fails here rather
      // than in a page that stops connecting.
      const dir = import.meta.dir;
      const client = await Bun.file(`${dir}/../src/index.ts`).text();
      const server = await Bun.file(`${dir}/../src/server.ts`).text();
      const clientCap = /const MAX_TOPIC_LENGTH = (\d+);/.exec(client)?.[1];
      const serverCap = /export const MAX_WS_TOPIC_LENGTH = (\d+);/.exec(server)?.[1];
      expect(clientCap).toBeDefined();
      expect(serverCap).toBeDefined();
      expect(clientCap).toBe(serverCap!);
    });

    test("one call is one topic, so the 32-topic cap is unreachable from here", () => {
      // the only way a single socket ever carried more than one topic was the
      // comma - which is refused above. Thirty-three subscriptions are
      // thirty-three sockets of one topic each, and the cap is per socket
      const channels = Array.from({ length: 33 }, (_, i) => subscribe(`t${i}`, () => {}));
      expect(FakeWS.instances.length).toBe(33);
      expect(new Set(FakeWS.instances.map((ws) => ws.url)).size).toBe(33);
      for (const channel of channels) channel.close();
    });
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
