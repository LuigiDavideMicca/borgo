import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { apiFetch } from "borgo-framework";
import type { Me } from "../.borgo/api-types";

export default function RootLayout({ children }: { children: ReactNode }) {
  // client-side session lookup: hydrating pages show "ciao <user> · logout",
  // zero-js pages keep the static login link and ship no extra script
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
          borgo tasks
        </a>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/slow">Streaming</a>
          <a href="/hydration">Hydration</a>
          <a href="/islands">Islands</a>
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
      <footer>demo app for the borgo framework</footer>
    </div>
  );
}
