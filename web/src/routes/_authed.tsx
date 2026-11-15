import { Link, Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { getMe } from "../lib/api";

// Every page under this layout needs a signed-in owner; the server functions check the session again on their own.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/login" });
    return { me };
  },
  component: Layout,
});

function Layout() {
  const { me } = Route.useRouteContext();
  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    window.location.assign("/login");
  }
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Cerebro</span>
        <nav>
          <Link to="/" activeOptions={{ exact: true }}>Dashboard</Link>
          <Link to="/clients">Clients</Link>
          <Link to="/chat">Chat</Link>
        </nav>
        <span className="who">
          <span className="muted">{me.email}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </span>
      </header>
      <Outlet />
    </div>
  );
}
