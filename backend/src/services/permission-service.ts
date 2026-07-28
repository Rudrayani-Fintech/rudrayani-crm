import { pool } from "../config/db";
import type { Capability } from "../types/user";

// capability_permissions is only ever written by a migration (deploy-time
// schema change) -- no route inserts/updates/deletes from it at runtime --
// so it's safe to cache for the life of the process. Previously every
// authenticated request paid a fresh query here on top of authenticate.ts's
// own per-request user lookup, for data that is effectively static.
let cache: Map<Capability, Set<string>> | null = null;
let loading: Promise<Map<Capability, Set<string>>> | null = null;

async function loadTable(): Promise<Map<Capability, Set<string>>> {
  const { rows } = await pool.query<{ capability: Capability; permission_key: string }>(
    "SELECT capability, permission_key FROM capability_permissions",
  );
  const map = new Map<Capability, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.capability)) map.set(r.capability, new Set());
    map.get(r.capability)!.add(r.permission_key);
  }
  return map;
}

async function getTable(): Promise<Map<Capability, Set<string>>> {
  if (cache) return cache;
  if (!loading) {
    loading = loadTable().then((table) => {
      cache = table;
      return table;
    });
  }
  return loading;
}

/** Checks the capability_permissions table (data-driven, brief Section 3). */
export async function capabilitiesHavePermission(
  capabilities: Capability[],
  permissionKey: string,
): Promise<boolean> {
  if (capabilities.length === 0) return false;
  const table = await getTable();
  return capabilities.some((c) => table.get(c)?.has(permissionKey) ?? false);
}

export async function permissionsFor(capabilities: Capability[]): Promise<string[]> {
  if (capabilities.length === 0) return [];
  const table = await getTable();
  const result = new Set<string>();
  for (const c of capabilities) {
    for (const p of table.get(c) ?? []) result.add(p);
  }
  return Array.from(result);
}
