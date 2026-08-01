// "borgo-framework/internal" - NOT FOR APPLICATION CODE.
//
// The root entry is the application-facing api: everything an app writes by
// hand and nothing else. The registries below exist only because something
// mechanical needs them - the generated client entries (.borgo/client.tsx,
// .borgo/islands-client.tsx) emit `import { registerCsrf, registerIslands }
// from "borgo-framework/internal"`, and runtime.ts / server.ts / util.ts reach
// withCsrf across module boundaries. They are on a subpath whose name says it
// is not for you: nothing here is covered by the stability promise and it may
// change, or vanish, in any release.
import type { ComponentType, Context, ReactNode } from "react";
import type {
  createContext as CreateContext,
  createElement as CreateElement,
  useContext as UseContext,
} from "react";

export type CsrfReact = {
  createElement: typeof CreateElement;
  createContext: typeof CreateContext;
  useContext: typeof UseContext;
};

let runtime: { react: CsrfReact; context: Context<string> } | null = null;

// react is injected (like islands) so this package never bundles its own copy
// null clears the registration: the server registers on every boot, so the
// only caller that needs to unregister is a test asserting the bare path
export function registerCsrf(react: CsrfReact | null) {
  runtime = react ? { react, context: react.createContext("") } : null;
}

// what <CsrfField /> reads. null until something registers a react.
export function csrfRuntime() {
  return runtime;
}

export function withCsrf(element: ReactNode, token: string) {
  if (!runtime) return element;
  const { react, context } = runtime;
  return react.createElement(context.Provider, { value: token }, element);
}

let registry: {
  components: Record<string, ComponentType<any>>;
  createElement: typeof CreateElement;
} | null = null;

export function registerIslands(
  components: Record<string, ComponentType<any>>,
  createElement: typeof CreateElement,
) {
  registry = { components, createElement };
}

// what <Island> reads. null until a generated entry (or the ssr server)
// installs the manifest.
export function islandRegistry() {
  return registry;
}
