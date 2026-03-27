import type { TicketRow } from "../types.js";

export function parseFacets(response: unknown): Partial<TicketRow>[] {
  // Placeholder parser for /facets payloads.
  // Intentionally returns partial rows because facet payloads often carry aggregates,
  // not always row-level inventory. Keep this flexible during discovery.
  const payload = response as Record<string, unknown>;

  // TODO: inspect actual facet schema and extract useful dimensions.
  const hasFacets = payload != null && typeof payload === "object";
  if (!hasFacets) return [];

  return [];
}
