import { createFileRoute } from "@tanstack/react-router";

// Better Auth's endpoints (sign-in, sign-out, session). Sign-up is disabled in its options.
const handle = async (request: Request) => (await import("../../../server/auth.server")).getAuth().handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
