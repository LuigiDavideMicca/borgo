import { afterEach, describe, expect, test } from "bun:test";
import { CLIENT_ENV_PREFIX, defineEnv, envMetaOf, type EnvMeta } from "../src/env";

const read = (env: Record<string, unknown>, name: string) => () => env[name];
const metaOf = (env: unknown) => envMetaOf(env) as EnvMeta;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__BORGO_CLIENT_ENV__;
});

describe("schema mistakes are the author's, thrown at define", () => {
  test("a client variable without the prefix", () => {
    expect(() => defineEnv({ client: { ANALYTICS_ID: {} } }, {})).toThrow(CLIENT_ENV_PREFIX);
  });

  test("a server variable wearing the prefix", () => {
    expect(() => defineEnv({ server: { BORGO_PUBLIC_SECRET: {} } }, {})).toThrow("server variable");
  });

  test("borgo's own variables are refused - one source of truth", () => {
    for (const name of ["BORGO_CSP", "PORT", "API_PORT", "API_URL", "FRONT_URL"]) {
      expect(() => defineEnv({ server: { [name]: {} } }, {})).toThrow("borgo's own");
    }
  });

  test("one name on both sides", () => {
    expect(() =>
      defineEnv(
        { server: { BORGO_PUBLIC_X: {} }, client: { BORGO_PUBLIC_X: {} } },
        {},
      ),
    ).toThrow();
  });
});

describe("validation collects, the first read throws them all", () => {
  test("a missing required variable is named with its expected shape", () => {
    const env = defineEnv({ server: { DATABASE_URL: { type: "url" } } }, {});
    expect(read(env, "DATABASE_URL")).toThrow("DATABASE_URL: missing (expected a url)");
  });

  test("every failure arrives in one message, not one per boot", () => {
    const env = defineEnv(
      {
        server: {
          DATABASE_URL: { type: "url" },
          SMTP_PORT: { type: "port" },
          DEBUG_MODE: { type: "boolean" },
        },
      },
      { SMTP_PORT: "banana", DEBUG_MODE: "yes" },
    );
    const boom = read(env, "SMTP_PORT");
    expect(boom).toThrow("3 variables refused");
    expect(boom).toThrow("DATABASE_URL");
    expect(boom).toThrow("SMTP_PORT");
    expect(boom).toThrow("DEBUG_MODE");
    expect(metaOf(env).failures).toHaveLength(3);
  });

  test("a healthy environment reads typed values", () => {
    const env = defineEnv(
      {
        server: {
          DATABASE_URL: { type: "url" },
          SMTP_PORT: { type: "port" },
          STRICT: { type: "boolean" },
          RATE: { type: "number" },
          GREETING: {},
        },
      },
      {
        DATABASE_URL: "postgres://db:5432/app",
        SMTP_PORT: "25",
        STRICT: "t",
        RATE: "1.5",
        GREETING: "ciao",
      },
    );
    expect(env.DATABASE_URL).toBe("postgres://db:5432/app");
    expect(env.SMTP_PORT).toBe(25);
    expect(env.STRICT).toBe(true);
    expect(env.RATE).toBe(1.5);
    expect(env.GREETING).toBe("ciao");
    expect(metaOf(env).failures).toEqual([]);
  });

  test("an undeclared name throws by name even on a healthy environment", () => {
    const env = defineEnv({ server: { A: {} } }, { A: "1" });
    expect(read(env, "TYPO")).toThrow("TYPO is not declared");
  });

  test("serializer and inspector probes are answered, not punished", () => {
    const env = defineEnv({ server: { A: {} } }, { A: "1" });
    expect(JSON.stringify(env)).toBe('{"A":"1"}');
    expect(Object.keys(env)).toEqual(["A"]);
  });
});

describe("the grammar", () => {
  test("booleans speak ParseBool, nothing else", () => {
    const yes = ["1", "t", "T", "TRUE", "true", "True"];
    const no = ["0", "f", "F", "FALSE", "false", "False"];
    for (const raw of yes) {
      expect(defineEnv({ server: { X: { type: "boolean" } } }, { X: raw }).X).toBe(true);
    }
    for (const raw of no) {
      expect(defineEnv({ server: { X: { type: "boolean" } } }, { X: raw }).X).toBe(false);
    }
    for (const raw of ["yes", "on", "2", " true"]) {
      const env = defineEnv({ server: { X: { type: "boolean" } } }, { X: raw });
      expect(read(env, "X")).toThrow("expected a boolean");
    }
  });

  test("a number must be the whole string and finite", () => {
    for (const raw of ["abc", "", "  ", "NaN", "Infinity"]) {
      const env = defineEnv({ server: { X: { type: "number" } } }, { X: raw });
      expect(read(env, "X")).toThrow();
    }
    expect(defineEnv({ server: { X: { type: "number" } } }, { X: "-3.5" }).X).toBe(-3.5);
  });

  test("a port is an integer 0-65535", () => {
    for (const raw of ["-1", "65536", "80.5", "http"]) {
      const env = defineEnv({ server: { X: { type: "port" } } }, { X: raw });
      expect(read(env, "X")).toThrow("expected a port");
    }
    expect(defineEnv({ server: { X: { type: "port" } } }, { X: "65535" }).X).toBe(65535);
  });

  test("a url must be absolute", () => {
    const env = defineEnv({ server: { X: { type: "url" } } }, { X: "/relative" });
    expect(read(env, "X")).toThrow("expected an absolute url");
  });

  test("the empty string is missing, not a value", () => {
    const env = defineEnv({ server: { X: {} } }, { X: "" });
    expect(read(env, "X")).toThrow("X: missing");
  });

  test("optional and default answer the missing case in their two ways", () => {
    const env = defineEnv(
      { server: { MAYBE: { optional: true }, LIMIT: { type: "number", default: 10 } } },
      {},
    );
    expect(env.MAYBE).toBeUndefined();
    expect(env.LIMIT).toBe(10);
  });

  test("a set variable still beats its default", () => {
    const env = defineEnv({ server: { LIMIT: { type: "number", default: 10 } } }, { LIMIT: "3" });
    expect(env.LIMIT).toBe(3);
  });

  // found adversarially: the default branch skipped both the parse and the
  // validator - the one value guaranteed to reach production was the one
  // value nobody checked, with the compiled type lying beside it
  test("a default that breaks its own contract is the author's error, thrown at define", () => {
    expect(() => defineEnv({ server: { N: { type: "number", default: "x" as never } } }, {})).toThrow(
      "must be a finite number",
    );
    expect(() => defineEnv({ server: { P: { type: "port", default: 99999 } } }, {})).toThrow(
      "integer 0-65535",
    );
    expect(() => defineEnv({ server: { B: { type: "boolean", default: "yes" as never } } }, {})).toThrow(
      "must be a boolean",
    );
    expect(() => defineEnv({ server: { U: { type: "url", default: "/relative" } } }, {})).toThrow(
      "absolute url",
    );
    expect(() =>
      defineEnv(
        {
          server: {
            V: {
              default: "raw",
              validate: () => {
                throw new Error("never accepts");
              },
            },
          },
        },
        {},
      ),
    ).toThrow("does not pass its own validator");
    // and a healthy default of a validate spec is read PARSED, not raw
    const env = defineEnv(
      { server: { LIST: { default: "a,b", validate: (raw) => raw.split(",") } } },
      {},
    );
    expect(env.LIST).toEqual(["a", "b"]);
  });

  test("a validator returning undefined does not degrade a required variable", () => {
    const env = defineEnv({ server: { REQ: { validate: () => undefined } } }, { REQ: "set" });
    expect(read(env, "REQ")).toThrow("returned undefined for a required variable");
    // optional keeps the freedom: undefined is a value it declared possible
    const opt = defineEnv(
      { server: { MAYBE: { optional: true, validate: () => undefined } } },
      { MAYBE: "set" },
    );
    expect(opt.MAYBE).toBeUndefined();
  });

  // the browser receives json: a Date flattens to its iso string, a Map to
  // {}, and the two sides of the wall would disagree in silence
  test("a client value that is not a json primitive refuses the build by name", () => {
    const env = defineEnv(
      { client: { BORGO_PUBLIC_WHEN: { validate: (raw) => new Date(raw) } } },
      { BORGO_PUBLIC_WHEN: "2026-01-01" },
    );
    const meta = metaOf(env);
    expect(meta.clientFailures).toHaveLength(1);
    expect(meta.clientFailures[0]).toContain("json primitive");
  });

  test("a debug print shows the values, or the refusal count - never {}", () => {
    const env = defineEnv({ server: { A: { default: "x" } } }, {});
    expect(Bun.inspect(env)).toContain("x");
    const broken = defineEnv({ server: { B: { type: "number" } } }, { B: "nope" });
    expect(Bun.inspect(broken)).toContain("1 refused");
  });

  test("validate is the escape hatch: its return is the value, its throw the named failure", () => {
    const ok = defineEnv(
      { server: { LIST: { validate: (raw) => raw.split(",") } } },
      { LIST: "a,b" },
    );
    expect(ok.LIST).toEqual(["a", "b"]);

    const bad = defineEnv(
      {
        server: {
          LIST: {
            validate: () => {
              throw new Error("expected a comma list");
            },
          },
        },
      },
      { LIST: "x" },
    );
    expect(read(bad, "LIST")).toThrow("LIST: expected a comma list");
  });
});

describe("the browser side of the wall", () => {
  const ship = (values: Record<string, unknown>) => {
    (globalThis as Record<string, unknown>).__BORGO_CLIENT_ENV__ = values;
  };

  test("client values come from the build's define, not the runtime environment", () => {
    ship({ BORGO_PUBLIC_APP_NAME: "shipped" });
    const env = defineEnv(
      { server: { SECRET: {} }, client: { BORGO_PUBLIC_APP_NAME: {} } },
      { BORGO_PUBLIC_APP_NAME: "runtime", SECRET: "s3cr3t" },
    );
    expect(env.BORGO_PUBLIC_APP_NAME).toBe("shipped");
  });

  test("a server variable asked for in the browser throws by name", () => {
    ship({});
    const env = defineEnv({ server: { SECRET: {} } }, { SECRET: "s3cr3t" });
    expect(read(env, "SECRET")).toThrow("SECRET is a server variable");
  });

  test("in the browser nothing server-side is validated - there is nothing to own there", () => {
    ship({});
    const env = defineEnv({ server: { DATABASE_URL: { type: "url" } } }, {});
    expect(metaOf(env).failures).toEqual([]);
  });
});

describe("the meta the boot check and the build read", () => {
  test("client names and validated values ride along without any value read", () => {
    const env = defineEnv(
      {
        server: { SECRET: {} },
        client: { BORGO_PUBLIC_APP_NAME: { default: "borgo" }, BORGO_PUBLIC_FLAG: { type: "boolean", optional: true } },
      },
      { SECRET: "x" },
    );
    const meta = metaOf(env);
    expect(meta.clientNames).toEqual(["BORGO_PUBLIC_APP_NAME", "BORGO_PUBLIC_FLAG"]);
    expect(meta.clientValues).toEqual({ BORGO_PUBLIC_APP_NAME: "borgo", BORGO_PUBLIC_FLAG: undefined });
  });

  // found by a surviving mutation: nothing exercised the defineEnv side of
  // this chain, so the build gate read an always-empty list and a broken
  // client value would have been frozen into every bundle in silence
  test("a broken client variable lands in clientFailures, where the build gate reads", () => {
    const env = defineEnv(
      { server: { S: { type: "number" } }, client: { BORGO_PUBLIC_X: { type: "number" } } },
      { S: "nope", BORGO_PUBLIC_X: "banana" },
    );
    const meta = metaOf(env);
    expect(meta.clientFailures).toEqual(['BORGO_PUBLIC_X: expected a number, got "banana"']);
    // the server failure stays out of the build's list and in the boot's
    expect(meta.failures).toHaveLength(2);
  });

  test("envMetaOf answers null for everything that is not a borgo env", () => {
    expect(envMetaOf(null)).toBeNull();
    expect(envMetaOf("x")).toBeNull();
    expect(envMetaOf({})).toBeNull();
  });
});
