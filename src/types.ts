export type InventoryType = "primary" | "resale";

export type TicketRow = {
  section: string;
  row: string;
  price: number;
  availableSeats: number;
  inventoryType: InventoryType;
};

export type RawCapture = {
  url: string;
  kind: "offers" | "facets" | "other";
  body: unknown;
};
