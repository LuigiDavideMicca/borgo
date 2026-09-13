// The render service's loopback port was a fixed 3600, whatever PORT said. Two
// borgo apps on one machine - the zero-downtime redeploy deploy.md describes,
// two projects side by side - met on it: each go front talked to the other's
// render service with the wrong boot key, and every page answered 403. On
// Windows the second bind did not even fail: a second process binds a port
// another one listens on without an error, and takes its traffic (measured,
// three render services on 3600 at once). The launchers now resolve the port
// once: a free one, or the one named - refused when something already answers.
import { afterEach, describe, expect, test } from "bun:test";
import { pickRenderPort, portAnswers, resolveRenderPort } from "../src/util";

const listeners: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const l of listeners.splice(0)) l.stop(true);
});

const listening = () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("held") });
  listeners.push(server);
  return server.port!;
};

describe("the render service's port", () => {
  test("unnamed, it is a free port nothing answers on", async () => {
    const held = listening();
    const port = await resolveRenderPort({});
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(held);
    expect(await portAnswers(port)).toBe(false);
  });

  test("named and free, it is used as named", async () => {
    const free = await resolveRenderPort({});
    expect(await resolveRenderPort({ BORGO_RENDER_PORT: String(free) })).toBe(free);
  });

  test("named and already answering, the boot is refused with the port and the way out", async () => {
    const held = listening();
    const refusal = await resolveRenderPort({ BORGO_RENDER_PORT: String(held) }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(refusal).toContain(String(held));
    expect(refusal).toContain("already answering");
    expect(refusal).toContain("BORGO_RENDER_PORT");
  });

  // borgo dev picks without asking: it asks all its ports after its session
  // lock, so a second session in the directory hears about the lock first
  test("picking takes a named port as named, answering or not, and a free one otherwise", async () => {
    const held = listening();
    expect(await pickRenderPort({ BORGO_RENDER_PORT: String(held) })).toBe(held);
    const free = await pickRenderPort({});
    expect(free).not.toBe(held);
    expect(await portAnswers(free)).toBe(false);
  });

  // 0 would let the render service pick a port the go front never learns
  test("a named port outside 1-65535 is refused before anything is asked", async () => {
    for (const bad of ["0", "65536", "-1", "port"]) {
      const said = await resolveRenderPort({ BORGO_RENDER_PORT: bad }).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(`${bad}: ${said}`).toContain("BORGO_RENDER_PORT");
      expect(await pickRenderPort({ BORGO_RENDER_PORT: bad }).then(() => "picked", () => "refused")).toBe("refused");
    }
  });

  test("a connection is what tells a live listener apart", async () => {
    const held = listening();
    expect(await portAnswers(held)).toBe(true);
    const free = await resolveRenderPort({});
    expect(await portAnswers(free)).toBe(false);
  });
});
