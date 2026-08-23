import { CsrfField, type ActionContext, type Head, type LoaderContext } from "borgo-framework";

export const head = (props: Record<string, unknown>): Head => ({
  title: `${props.message ?? "Hello"} · {{name}}`,
});

export async function loader({ params, api }: LoaderContext) {
  const { message } = await api("GET /api/hello/{name}", { params: { name: params.name } });
  return { message };
}

// classic form post handled on the server; the body of the api call is typed.
// a page with an action is served by `borgo start`, never by `bun run export`:
// the export skips it, because of the loader, and a static host could not run
// the action anyway
export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim() || "stranger";
  const { message } = await api("POST /api/hello", { body: { name } });
  return { greeting: message };
}

export default function Hello({
  message,
  actionData,
}: {
  message: string;
  actionData?: { greeting?: string };
}) {
  return (
    <main>
      <h1>{message}</h1>
      <p>This page was server-rendered with data fetched from the Go API.</p>
      <form method="post" id="greet">
        <CsrfField />
        <p>{actionData?.greeting ?? "Posts to a server action, typed body end to end."}</p>
        <input name="name" placeholder="Your name" />
        <button type="submit">Greet</button>
      </form>
      <a href="/">← Back home</a>
    </main>
  );
}
