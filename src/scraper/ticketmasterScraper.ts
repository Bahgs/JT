import { chromium } from "playwright";
import type { RawCapture } from "../types.js";

const OFFERS_PATTERN = /\/offers/i;
const FACETS_PATTERN = /\/facets/i;

function classifyResponseUrl(url: string): RawCapture["kind"] {
  if (OFFERS_PATTERN.test(url)) return "offers";
  if (FACETS_PATTERN.test(url)) return "facets";
  return "other";
}

export async function captureTicketmasterResponses(eventUrl: string): Promise<RawCapture[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const captures: RawCapture[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    const kind = classifyResponseUrl(url);

    // Keep this broad for MVP observability; narrow later if noisy.
    if (kind === "other") return;

    try {
      const body = await response.json();
      captures.push({ url, kind, body });
      console.log(`[capture] ${kind.toUpperCase()} ${url}`);
    } catch (error) {
      console.warn(`[capture] Failed to parse JSON from ${url}`, error);
    }
  });

  console.log(`[scraper] Navigating to ${eventUrl}`);
  await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // TODO: Replace with deterministic wait strategy once we know exact requests.
  await page.waitForTimeout(7_000);

  await context.close();
  await browser.close();

  return captures;
}
