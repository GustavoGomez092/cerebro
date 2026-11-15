// The app's real dependencies, built once on first use: Better Auth's session check and the cerebro-server client.
import { getAuth } from "./auth.server";
import { cerebroClient } from "./cerebro.server";
import { dashboardData, type GetSession } from "./data.server";
import { loadWebEnv } from "./env.server";

const getSession: GetSession = async (headers) => {
  const s = await getAuth().api.getSession({ headers });
  return s ? { user: { id: s.user.id, email: s.user.email, name: s.user.name } } : null;
};

let built: ReturnType<typeof build> | undefined;
function build() {
  const env = loadWebEnv();
  const cerebro = cerebroClient({ baseUrl: env.cerebroUrl, token: env.cerebroToken });
  return { getSession, cerebro, origin: new URL(env.baseUrl).origin, data: dashboardData({ getSession, cerebro }) };
}

export const appDeps = () => (built ??= build());
