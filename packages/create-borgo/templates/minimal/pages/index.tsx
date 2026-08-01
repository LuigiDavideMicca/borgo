import type { LoaderContext } from "borgo-framework";

export const head = {
  title: "{{name}}",
  meta: [{ name: "description", content: "react pages server-rendered by bun, api routes in go" }],
};

export async function loader({ api }: LoaderContext) {
  const { message } = await api("GET /api/hello");
  return { message };
}

export default function Home({ message }: { message: string }) {
  return (
    <main className="hero">
      <img src="/logo.svg" alt="borgo" width={120} height={120} />
      <h1>borgo</h1>
      <p className="tagline">{message}</p>
      <p className="hint">
        Get started by editing <code>pages/index.tsx</code> and <code>api/hello.go</code>
      </p>
    </main>
  );
}
