import { countFromQuery, itemList } from "../../lib/items.js";

export const prerender = false;

export function GET({ url }) {
  return Response.json(itemList(countFromQuery(url.searchParams.get("n"))));
}
