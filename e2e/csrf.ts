import type { Page } from "@playwright/test";

// Not a spec: playwright's default testMatch only picks up *.spec.ts.
//
// page.request shares the browser's cookie jar, so an /api call it makes
// carries borgo_csrf and is armed by the front server's check exactly as the
// page's own fetch would be. It has to echo the token in the header, which is
// what apiFetch does for real page code.
export async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === "borgo_csrf")?.value;
  if (!token) throw new Error("no borgo_csrf cookie: visit a page before calling this");
  return { "X-CSRF-Token": token };
}
