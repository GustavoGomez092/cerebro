import type { SQL } from "bun";
import type { Client, Project } from "@cerebro/shared";

export async function listClients(sql: SQL): Promise<Client[]> {
  return [...(await sql`select id, name from clients order by name`)];
}

export async function createClient(sql: SQL, name: string): Promise<Client> {
  const [row] = await sql`
    insert into clients (name) values (${name})
    on conflict (name) do update set name = excluded.name
    returning id, name`;
  return row;
}

export async function listProjects(sql: SQL, clientId: string): Promise<Project[]> {
  return [...(await sql`select id, client_id as "clientId", name from projects where client_id = ${clientId} order by name`)];
}

export async function createProject(sql: SQL, clientId: string, name: string): Promise<Project> {
  const [row] = await sql`
    insert into projects (client_id, name) values (${clientId}, ${name})
    on conflict (client_id, name) do update set name = excluded.name
    returning id, client_id as "clientId", name`;
  return row;
}
