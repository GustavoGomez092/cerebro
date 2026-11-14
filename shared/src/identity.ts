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
