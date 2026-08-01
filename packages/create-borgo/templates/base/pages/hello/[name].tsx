import type { Head, LoaderContext } from "borgo-framework";

export const head = (props: Record<string, unknown>): Head => ({
  title: `${props.message ?? "Hello"} · {{name}}`,
});

export async function loader({ params, api }: LoaderContext) {
  const { message } = await api("GET /api/hello/{name}", { params: { name: params.name } });
  return { message };
}

export default function Hello({ message }: { message: string }) {
  return (
    <main>
      <h1>{message}</h1>
      <p>This page was server-rendered with data fetched from the Go API.</p>
      <a href="/">← Back home</a>
    </main>
  );
}
