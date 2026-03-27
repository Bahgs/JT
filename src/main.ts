import { captureTicketmasterResponses } from "./scraper/ticketmasterScraper.js";
import { parseOffers } from "./parsers/offersParser.js";
import { parseFacets } from "./parsers/facetsParser.js";
import {
  filterPrimaryTickets,
  filterRowsByAvailability,
  groupBySectionAndPrice,
  selectLastRow
} from "./logic/ticketLogic.js";
import type { TicketRow } from "./types.js";

function formatOutput(row: TicketRow): string {
  return `Section ${row.section} | Row ${row.row} | Price $${row.price.toFixed(2)} | Available: ${row.availableSeats}`;
}

async function run(): Promise<void> {
  const eventUrl = process.argv[2];
  if (!eventUrl) {
    console.error("Usage: npm start -- <ticketmaster-event-url>");
    process.exit(1);
  }

  console.log("[main] Starting Ticketmaster MVP capture...");
  const captures = await captureTicketmasterResponses(eventUrl);
  console.log(`[main] Captured ${captures.length} relevant network responses`);

  const offerResponses = captures.filter((capture) => capture.kind === "offers");
  const facetResponses = captures.filter((capture) => capture.kind === "facets");

  if (offerResponses.length === 0) {
    console.warn("[main] No /offers responses captured yet. Check URL and wait strategy.");
  }

  const allRows: TicketRow[] = [];
  for (const response of offerResponses) {
    const parsed = parseOffers(response.body);
    console.log(`[main] Parsed ${parsed.length} rows from ${response.url}`);
    allRows.push(...parsed);
  }

  for (const response of facetResponses) {
    const parsed = parseFacets(response.body);
    console.log(`[main] Parsed ${parsed.length} facet entries from ${response.url}`);
  }

  const primaryRows = filterPrimaryTickets(allRows);
  const min20Rows = filterRowsByAvailability(primaryRows, 20);
  const grouped = groupBySectionAndPrice(min20Rows);
  const selected = selectLastRow(grouped);

  console.log(`[main] Final rows: ${selected.length}`);
  for (const row of selected) {
    console.log(formatOutput(row));
  }
}

run().catch((error) => {
  console.error("[main] Fatal error:", error);
  process.exit(1);
});
