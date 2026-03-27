import type { TicketRow } from "../types.js";

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeInventoryType(input: unknown): TicketRow["inventoryType"] {
  const text = String(input ?? "").toLowerCase();
  return text.includes("resale") ? "resale" : "primary";
}

export function parseOffers(response: unknown): TicketRow[] {
  // TODO: map this to the actual offers shape after inspecting real payloads.
  const candidates = Array.isArray((response as { offers?: unknown[] })?.offers)
    ? (response as { offers: unknown[] }).offers
    : [];

  return candidates
    .map((item): TicketRow | null => {
      const obj = (item ?? {}) as Record<string, unknown>;

      const section = String(obj.section ?? obj.sectionName ?? "").trim();
      const row = String(obj.row ?? obj.rowName ?? "").trim();
      const price = toNumber(obj.price ?? obj.listPrice ?? obj.totalPrice);
      const availableSeats = toNumber(obj.availableSeats ?? obj.quantity ?? obj.count);
      const inventoryType = normalizeInventoryType(obj.inventoryType ?? obj.type);

      if (!section || !row || price == null || availableSeats == null) return null;

      return {
        section,
        row,
        price,
        availableSeats,
        inventoryType
      };
    })
    .filter((row): row is TicketRow => row !== null);
}
