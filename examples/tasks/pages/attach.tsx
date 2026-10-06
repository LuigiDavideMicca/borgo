import { CsrfField, type ActionContext } from "borgo-framework";
import type { Attachment } from "@/.borgo/api-types";

export const head = { title: "Attach · borgo tasks" };

// the form posts multipart to this action, which hands the file to the api
// route as it is: api/attachments.go reads it with borgo.BindMultipart, so
// the body below is typed - a misspelled field, or a string where the file
// goes, fails tsc - and the client sends it as a FormData. The file is
// optional to the type (a form may leave it out, and then goes as JSON), so
// the action asks for one itself. A body over the limit never reaches here:
// the front answers 413 before the action runs
export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "choose a file" };
  const attached = await api("POST /api/attachments", {
    body: { note: String(form.get("note") ?? ""), file },
  });
  return { attached };
}

export default function Attach({ actionData }: { actionData?: { error?: string; attached?: Attachment } }) {
  return (
    <main>
      <h1>Attach a file</h1>
      <form method="post" encType="multipart/form-data">
        <CsrfField />
        <input name="note" placeholder="A note" />
        <input name="file" type="file" />
        <button>Upload</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
      {actionData?.attached && (
        <p data-testid="attached">
          {actionData.attached.name} · {actionData.attached.size} bytes · {actionData.attached.type}
          {actionData.attached.note && ` · ${actionData.attached.note}`}
        </p>
      )}
    </main>
  );
}
