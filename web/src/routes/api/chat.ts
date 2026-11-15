import { createFileRoute } from "@tanstack/react-router";

// The chat turn, streamed from cerebro-server; needs a session (checked in chatProxy). Server-only modules are
// imported inside the handler so they never reach the browser bundle.
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ appDeps }, { chatProxy }] = await Promise.all([import("../../server/deps.server"), import("../../server/data.server")]);
        return chatProxy(request, appDeps());
      },
    },
  },
});
