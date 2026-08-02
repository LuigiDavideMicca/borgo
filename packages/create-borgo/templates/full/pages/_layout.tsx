import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { apiFetch } from "borgo-framework";
import type { Me } from "../.borgo/api-types";

export default function RootLayout({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    fetch("/api/me").then(async (res) => {
      if (res.ok) setMe(await res.json());
    });
  }, []);

  // apiFetch, not fetch: a browser call to /api/* that changes something has
  // to echo the csrf token in a header, and this is what attaches it
  const logout = async () => {
    await apiFetch("/api/logout", { method: "POST" });
    location.assign("/");
  };

  return (
    <div className="app">
      <header>
        <a href="/" className="brand">
          <img src="/logo.svg" alt="" width={28} height={28} />
          {"{{name}}"}
        </a>
        <nav>
          <a href="/">Notes</a>
          <a href="/live">Live</a>
          <a href="/account">Account</a>
          {me ? (
            <span className="session">
              ciao <strong>{me.username}</strong> ·{" "}
              <button type="button" onClick={logout}>
                logout
              </button>
            </span>
          ) : (
            <a href="/login" className="session">
              login
            </a>
          )}
        </nav>
      </header>
      {children}
    </div>
  );
}
