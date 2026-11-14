/** Normalises a git remote URL so every spelling of the same repo yields one identity. */
export function normalizeRemote(url: string): string {
  let s = url.trim().toLowerCase();
  s = s.replace(/^[a-z+]+:\/\//, "");           // scheme
  s = s.replace(/^[^@/]+@/, "");                // user[:password]@
  if (!s.includes("/") || /^[^/]+:/.test(s)) s = s.replace(/^([^/:]+):\/?/, "$1/"); // scp form host:path
  s = s.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return s;
}

/** Identity for a folder that is not a git repo: specific to one machine. */
export function pathIdentity(machineName: string, absPath: string): string {
  return `path:${machineName}:${absPath}`;
}

/** Canonical form of any folder identity: path identities kept verbatim, remotes normalised. */
export function normalizeIdentity(repo: string): string {
  const s = repo.trim();
  return s.startsWith("path:") ? s : normalizeRemote(s);
}

/** For `path:<machine>:<abs>` identities, the machine name; otherwise null. */
export function pathIdentityMachine(repo: string): string | null {
  const m = /^path:([^:]*):/.exec(repo.trim());
  return m ? m[1] : null;
}
