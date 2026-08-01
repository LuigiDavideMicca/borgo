import { countFromQuery, itemList } from "../../../lib/items.js";

export const dynamic = "force-dynamic";

/** @param {Request} request */
export function GET(request) {
  const n = new URL(request.url).searchParams.get("n");
  return Response.json(itemList(countFromQuery(n)));
}
