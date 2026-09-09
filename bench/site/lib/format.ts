// the one formatting truth, imported by the page AND by the test that
// compares the rendered numbers with the committed json
export const fmtRps = (n: number) => `${Math.round(n).toLocaleString("en-US")} req/s`;
export const fmtMs = (n: number) => `${n.toFixed(1)} ms`;
export const fmtMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export const fmtKB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
export const shortCommit = (c: string) => c.slice(0, 7);
export const fmtGB = (bytes: number) => `${Math.round(bytes / 1024 / 1024 / 1024)} GB`;
