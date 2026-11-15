// The owner account, made (or its password reset) by scripts/create-owner.ts: public sign-up is off.
import { MIN_PASSWORD, type Auth } from "./auth.server";

/** Creates the owner with a credential (password) account, or resets the password of an existing one. */
export async function createOrResetOwner(auth: Auth, o: { email: string; name: string; password: string }): Promise<"created" | "reset"> {
  if (o.password.length < MIN_PASSWORD) throw new Error(`the password must be at least ${MIN_PASSWORD} characters`);
  const email = o.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("that is not an email address");
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(o.password);
  const found = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (found) {
    if (found.accounts.some((a) => a.providerId === "credential")) await ctx.internalAdapter.updatePassword(found.user.id, hash);
    else await ctx.internalAdapter.linkAccount({ userId: found.user.id, providerId: "credential", accountId: found.user.id, password: hash });
    // Signed-in browsers must sign in again with the new password.
    await ctx.internalAdapter.deleteUserSessions(found.user.id);
    return "reset";
  }
  const user = await ctx.internalAdapter.createUser({ email, name: o.name, emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  return "created";
}
