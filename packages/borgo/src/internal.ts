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

// which methods the /api csrf check covers, in one place: the browser helper
// that attaches the token and the front server that demands it have to name
// the same set, and a second copy of a security-relevant list is a second copy
// that can drift. rfc 9110 §9.2.1 - safe methods change no state, so they are
// never checked. anything not listed here (an OPTIONS, a WebDAV verb) is
// checked too: unknown is not the same as safe.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export const unsafeMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

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
