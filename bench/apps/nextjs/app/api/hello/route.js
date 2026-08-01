import { HELLO } from "../../../lib/items.js";

// nothing here is cacheable by contract: the scenario measures serving the
// response, not serving a cache of it
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(HELLO);
}
