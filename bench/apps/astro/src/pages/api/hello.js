import { HELLO } from "../../lib/items.js";

export const prerender = false;

export function GET() {
  return Response.json(HELLO);
}
