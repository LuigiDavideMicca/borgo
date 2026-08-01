export const dynamic = "force-dynamic";

export function GET() {
  const stream = new ReadableStream({
    start(controller) {
      // the contract's immediate first flush
      controller.enqueue(new TextEncoder().encode(": ping\n\n"));
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
