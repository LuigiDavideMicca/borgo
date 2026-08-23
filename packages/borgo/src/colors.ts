const enabled = !process.env.NO_COLOR && process.stdout.isTTY === true;

const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  terracotta: wrap("38;5;173"),
  sage: wrap("38;5;108"),
  cream: wrap("38;5;187"),
  red: wrap("38;5;167"),
  yellow: wrap("38;5;179"),
  blue: wrap("38;5;109"),
};

// windows: utf-8 marks survive only a real console in codepage 65001; a pipe
// is decoded by powershell 5.1 with the legacy oem codepage, so stay ascii there
export const consoleUnicode: boolean = await (async () => {
  if (process.platform !== "win32") return true;
  if (process.stdout.isTTY !== true) return false;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      GetConsoleOutputCP: { args: [], returns: FFIType.u32 },
    });
    return kernel32.symbols.GetConsoleOutputCP() === 65001;
  } catch {
    return false;
  }
})();

export const g = consoleUnicode
  ? { home: "⌂", ok: "✓", err: "✗", change: "↻", arrow: "➜", dot: "·" }
  : { home: "^", ok: "+", err: "x", change: "~", arrow: ">", dot: "-" };

export const mark = c.terracotta(g.home) + " " + c.bold("borgo");

export const version: string = await Bun.file(new URL("../package.json", import.meta.url))
  .json()
  .then((pkg: { version: string }) => pkg.version)
  .catch(() => "0.0.0");

export const banner = (label = "") =>
  `${mark} ${c.dim(`v${version}`)}${label ? " " + c.sage(label) : ""}`;

export const statusColor = (status: number) =>
  status >= 500 ? c.red : status >= 400 ? c.yellow : status >= 300 ? c.blue : c.sage;

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
