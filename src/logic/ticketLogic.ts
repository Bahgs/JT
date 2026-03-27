import type { TicketRow } from "../types.js";

export function filterPrimaryTickets(rows: TicketRow[]): TicketRow[] {
  return rows.filter((row) => row.inventoryType === "primary");
}

export function filterRowsByAvailability(rows: TicketRow[], minSeats = 20): TicketRow[] {
  return rows.filter((row) => row.availableSeats >= minSeats);
}

export function groupBySectionAndPrice(rows: TicketRow[]): Map<string, TicketRow[]> {
  const groups = new Map<string, TicketRow[]>();

  for (const row of rows) {
    const key = `${row.section}__${row.price.toFixed(2)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  return groups;
}

export function selectLastRow(groups: Map<string, TicketRow[]>): TicketRow[] {
  const selected: TicketRow[] = [];
  for (const [, rows] of groups.entries()) {
    if (rows.length > 0) selected.push(rows[rows.length - 1]);
  }
  return selected;
}
