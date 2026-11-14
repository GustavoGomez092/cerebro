export interface Client { id: string; name: string }
export interface Project { id: string; clientId: string; name: string }
export interface Binding {
  id: string;
  repo: string;
  subpath: string;
  status: "active" | "declined";
  clientId: string | null;
  projectId: string | null;
}
