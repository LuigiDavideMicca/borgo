// typed environment for the app's own variables, the way 0.21 hardened
// borgo's: declared once, validated with the variable named, refused at boot
// rather than discovered at the first read that happens to be in production.
//
// the boundary is the serious part. client variables carry the BORGO_PUBLIC_
// prefix and reach the browser only through the build's define, as one
// explicit allowlisted object - never by osmosis. server values are read
// from the runtime environment at runtime, so they cannot be baked into a
// bundle by construction; asking the browser for one throws, naming it.
//
// validation runs when defineEnv is called and the failures are collected,
// but the throw waits for the first value read - or for the server's boot
// check, which is the intended place: a build machine can import the schema
// to learn the client names without owning the production secrets.

export type EnvType = "string" | "number" | "boolean" | "url" | "port";

export type EnvSpec = {
  // how the raw string is read; "string" when absent. "url" must parse as an
  // absolute URL and stays a string; "port" is an integer 0-65535
  type?: EnvType;
  // a missing variable refuses the boot unless the spec says optional or
  // carries a default. the empty string counts as missing: every way of
  // writing FOO= into an environment means "not set" more often than it
  // means "the empty string", and the one app that wants "" can say optional
  optional?: boolean;
  default?: string | number | boolean;
  // the escape hatch for schemas beyond the built-in types: receives the raw
  // string, returns the parsed value, throws to refuse (the message becomes
  // the named boot failure). zod users: (raw) => mySchema.parse(raw)
  validate?: (raw: string) => unknown;
};

export type EnvSchema = {
  server?: Record<string, EnvSpec>;
  client?: Record<string, EnvSpec>;
};

// the prefix is the contract: what carries it is built for the browser, what
// does not can never reach it. borgo promises to never claim the public
// namespace for its own variables
export const CLIENT_ENV_PREFIX = "BORGO_PUBLIC_";

type SpecValue<S extends EnvSpec> = S["validate"] extends (raw: string) => infer T
  ? T
  : S["type"] extends "number" | "port"
    ? number
    : S["type"] extends "boolean"
      ? boolean
      : string;

type Value<S extends EnvSpec> = S extends { default: string | number | boolean }
  ? SpecValue<S>
  : S["optional"] extends true
    ? SpecValue<S> | undefined
    : SpecValue<S>;

export type Env<S extends EnvSchema> = { readonly [K in keyof S["server"] & string]: Value<NonNullable<S["server"]>[K]> } & {
  readonly [K in keyof S["client"] & string]: Value<NonNullable<S["client"]>[K]>;
};

// what serve() and the build read off the returned object without touching
// any value: the failures to refuse the boot with, the client map to define.
// client failures ride separately because they refuse a different gate: the
// build freezes client values in, so a broken one fails the build - while a
// server variable belongs to the machine that runs, not the one that builds
export type EnvMeta = {
  failures: string[];
  clientFailures: string[];
  clientNames: string[];
  clientValues: Record<string, unknown>;
};

export const ENV_META = Symbol.for("borgo.env");

// substituted by the build into client bundles as one explicit allowlisted
// object; never defined on the server
declare const __BORGO_CLIENT_ENV__: Record<string, unknown> | undefined;

// go's strconv.ParseBool spellings, the one grammar both halves already
// speak for BORGO_* variables - an app variable should not invent another
const BOOL: Record<string, boolean> = {
  "1": true, t: true, T: true, TRUE: true, true: true, True: true,
  "0": false, f: false, F: false, FALSE: false, false: false, False: false,
};

function parseValue(name: string, raw: string, spec: EnvSpec): { value?: unknown; error?: string } {
  if (spec.validate) {
    try {
      return { value: spec.validate(raw) };
    } catch (error) {
      return { error: `${name}: ${error instanceof Error ? error.message : error}` };
    }
  }
  switch (spec.type ?? "string") {
    case "string":
      return { value: raw };
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) {
        return { error: `${name}: expected a number, got ${JSON.stringify(raw)}` };
      }
      return { value: n };
    }
    case "boolean": {
      const b = BOOL[raw];
      if (b === undefined) {
        return { error: `${name}: expected a boolean (1/0, true/false, t/f), got ${JSON.stringify(raw)}` };
      }
      return { value: b };
    }
    case "port": {
      const n = Number(raw);
      if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 0 || n > 65535) {
        return { error: `${name}: expected a port (an integer 0-65535), got ${JSON.stringify(raw)}` };
      }
      return { value: n };
    }
    case "url": {
      try {
        new URL(raw);
        return { value: raw };
      } catch {
        return { error: `${name}: expected an absolute url, got ${JSON.stringify(raw)}` };
      }
    }
  }
}

const describe = (spec: EnvSpec) => (spec.validate ? "a value its validator accepts" : `a ${spec.type ?? "string"}`);

export function defineEnv<const S extends EnvSchema>(
  schema: S,
  // reached through globalThis: this module ships to browsers, where a bare
  // `process` is neither declared nor defined
  runtimeEnv: Record<string, string | undefined> = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {},
): Env<S> {
  // schema mistakes are the author's, not the environment's: thrown here and
  // now, because no environment can make a misnamed variable right
  const server = schema.server ?? {};
  const client = schema.client ?? {};
  for (const name of Object.keys(client)) {
    if (!name.startsWith(CLIENT_ENV_PREFIX)) {
      throw new Error(
        `borgo env: client variable ${name} must start with ${CLIENT_ENV_PREFIX} - the prefix is what marks a value as safe to ship to every browser`,
      );
    }
  }
  for (const name of Object.keys(server)) {
    if (name.startsWith(CLIENT_ENV_PREFIX)) {
      throw new Error(
        `borgo env: server variable ${name} carries the ${CLIENT_ENV_PREFIX} prefix - declare it under client, or rename it so it cannot be mistaken for one the browser may see`,
      );
    }
    if (name.startsWith("BORGO_") || name === "PORT" || name === "API_PORT" || name === "API_URL" || name === "FRONT_URL") {
      throw new Error(
        `borgo env: ${name} is borgo's own - the framework already validates it at boot, and declaring it here would give it two sources of truth`,
      );
    }
    if (name in client) {
      throw new Error(`borgo env: ${name} is declared as both server and client`);
    }
  }

  const failures: string[] = [];
  const clientFailures: string[] = [];
  const values: Record<string, unknown> = {};
  const clientValues: Record<string, unknown> = {};
  const refuse = (side: "server" | "client", message: string) => {
    failures.push(message);
    if (side === "client") clientFailures.push(message);
  };

  // in a client bundle the build defines the validated client map as one
  // bare identifier - a property read would slip past the define - and its
  // presence is also how this code knows where it runs. tests inject through
  // globalThis, which the fallback reads on purpose
  const shipped =
    typeof __BORGO_CLIENT_ENV__ !== "undefined"
      ? __BORGO_CLIENT_ENV__
      : ((globalThis as Record<string, unknown>).__BORGO_CLIENT_ENV__ as
          | Record<string, unknown>
          | undefined);

  for (const [names, side] of [
    [server, "server"],
    [client, "client"],
  ] as const) {
    for (const [name, spec] of Object.entries(names)) {
      if (side === "client" && shipped) {
        clientValues[name] = values[name] = shipped[name];
        continue;
      }
      // the browser owns no server values, so there is nothing to validate
      // there: access is what must fail, and it fails by name below
      if (side === "server" && shipped) continue;
      const raw = runtimeEnv[name];
      if (raw === undefined || raw === "") {
        if (spec.default !== undefined) {
          values[name] = spec.default;
        } else if (!spec.optional) {
          refuse(side, `${name}: missing (expected ${describe(spec)})`);
        } else {
          values[name] = undefined;
        }
      } else {
        const { value, error } = parseValue(name, raw, spec);
        if (error) refuse(side, error);
        else values[name] = value;
      }
      if (side === "client") clientValues[name] = values[name];
    }
  }

  const refusal = () =>
    new Error(
      `borgo env: ${failures.length} variable${failures.length === 1 ? "" : "s"} refused:\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
    );

  const meta: EnvMeta = { failures, clientFailures, clientNames: Object.keys(client), clientValues };

  // a proxy rather than a frozen object, for the two reads that must fail by
  // name: a server variable asked for in the browser, and any variable asked
  // for while the environment is known to be broken - the boot check in
  // serve() reports every failure at once, this is the backstop for scripts
  // that never boot a server
  return new Proxy({} as Env<S>, {
    get(_, prop) {
      if (prop === ENV_META) return meta;
      if (typeof prop !== "string") return undefined;
      if (shipped && prop in server) {
        throw new Error(
          `borgo env: ${prop} is a server variable - it never reaches the browser. values for the client carry the ${CLIENT_ENV_PREFIX} prefix and are declared under client`,
        );
      }
      if (!(prop in server) && !(prop in client)) {
        // probes serializers and inspectors make on any object are answered,
        // not punished - only a variable read by name deserves the throw
        if (prop === "toJSON" || prop === "then" || prop === "constructor") return undefined;
        throw new Error(`borgo env: ${prop} is not declared in the schema`);
      }
      if (failures.length > 0) throw refusal();
      return values[prop];
    },
    has(_, prop) {
      return typeof prop === "string" && (prop in server || prop in client);
    },
    ownKeys() {
      return [...Object.keys(server), ...Object.keys(client)];
    },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === "string" && (prop in server || prop in client)) {
        return { enumerable: true, configurable: true, value: undefined };
      }
      return undefined;
    },
  });
}

// what the boot check asks of a module the app named env.ts: every exported
// borgo env object, so serve() can refuse the boot naming each failure
export function envMetaOf(candidate: unknown): EnvMeta | null {
  if (candidate === null || typeof candidate !== "object") return null;
  const meta = (candidate as Record<symbol, unknown>)[ENV_META];
  return meta ? (meta as EnvMeta) : null;
}
