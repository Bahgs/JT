import { chromium } from "playwright"

type PriceMap = Record<string, number>

type TicketBlock = {
  section: string
  row: string | null
  seats: string[]
  quantity: number
  price: number | null
  inventoryType: "primary"
}

const TARGET_KEYWORDS = ["quickpicks", "facets", "availability", "inventory", "seat"]

function getEventUrlFromArg(): string {
  const eventUrl = process.argv[2]
  if (!eventUrl) {
    throw new Error("Usage: node scraper.js <ticketmaster_url>")
  }
  return eventUrl
}

function toPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseQuickpicksPriceMap(quickpicksData: unknown): PriceMap {
  const priceMap: PriceMap = {}
  if (!quickpicksData || typeof quickpicksData !== "object") return priceMap

  const data = quickpicksData as Record<string, any>
  const embeddedOffers = data._embedded?.offer || data._embedded?.offers || []
  if (!Array.isArray(embeddedOffers)) return priceMap

  for (const rawOffer of embeddedOffers) {
    if (!rawOffer || typeof rawOffer !== "object") continue
    const offer = rawOffer as Record<string, unknown>

    const id = String(offer.id ?? offer.offerId ?? "").trim()
    if (!id) continue

    console.log("PRICE:", { list: offer.listPrice, total: offer.totalPrice })

    const price =
      toPrice(offer.totalPrice) ??
      toPrice(offer.price) ??
      toPrice(offer.listPrice) ??
      null
    if (price == null) continue

    priceMap[id] = price
  }

  return priceMap
}

function buildTicketBlocksFromQuickpicks(
  quickpicksData: unknown,
  priceMap: PriceMap
): TicketBlock[] {
  const blocks: TicketBlock[] = []
  if (!quickpicksData || typeof quickpicksData !== "object") return blocks

  const data = quickpicksData as Record<string, any>
  const picks = Array.isArray(data.picks) ? data.picks : []

  for (const rawPick of picks) {
    if (!rawPick || typeof rawPick !== "object") continue
    const pick = rawPick as Record<string, any>

    if (pick.selection !== "standard") continue

    const section = String(pick.section ?? "").trim()
    const row = typeof pick.row === "string" ? pick.row.trim() || null : null

    const offers: string[] = Array.isArray(pick.offerGroups?.[0]?.offers)
      ? pick.offerGroups[0].offers
          .map((o: unknown) => String(o ?? "").trim())
          .filter(Boolean)
      : []

    const seats: string[] = Array.isArray(pick.offerGroups?.[0]?.seats)
      ? pick.offerGroups[0].seats
          .map((s: unknown) => String(s ?? "").trim())
          .filter(Boolean)
      : []

    const offerId = offers[0] ?? ""
    const price = offerId && priceMap[offerId] != null ? priceMap[offerId] : null

    console.log("PARSED:", section, row, seats)

    blocks.push({
      section,
      row,
      seats,
      quantity: seats.length,
      price,
      inventoryType: "primary"
    })
  }

  return blocks
}

async function waitForQuickpicks(
  getQuickpicks: () => unknown,
  timeoutMs: number
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (getQuickpicks()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function run() {
  const eventUrl = getEventUrlFromArg()
  const browser = await chromium.launch({ headless: false }) // keep visible for debugging
  const context = await browser.newContext()
  const page = await context.newPage()
  let quickpicksData: unknown = null

  console.log("Opening page...")

  page.on("response", async (response) => {
    const url = response.url()
    const lowerUrl = url.toLowerCase()
    const isRelevant = TARGET_KEYWORDS.some((keyword) => lowerUrl.includes(keyword))

    if (!isRelevant) return

    try {
      const data = await response.json()
      console.log(`URL: ${url}`)

      if (!quickpicksData && lowerUrl.includes("quickpicks")) {
        quickpicksData = data
        console.log(JSON.stringify(quickpicksData, null, 2).slice(0, 1000))
        const embedded = (quickpicksData as Record<string, any>)._embedded || {}
        console.log("EMBEDDED KEYS:", Object.keys(embedded))
        console.log("Captured quickpicks response")
      }
    } catch {
      // Ignore non-JSON responses without crashing.
    }
  })

  await page.goto(eventUrl, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(8000)
  await waitForQuickpicks(() => quickpicksData, 5000)

  const priceMap = parseQuickpicksPriceMap(quickpicksData)
  const ticketBlocks = buildTicketBlocksFromQuickpicks(quickpicksData, priceMap)
  console.log("Total parsed blocks:", ticketBlocks.length)

  if (ticketBlocks.length === 0) {
    console.log("No ticket data found.")
  } else {
    function getRowValue(row: string | null): number {
      if (!row) return -1
      return row.charCodeAt(0)
    }

    function selectLastRow(blocks: TicketBlock[]): TicketBlock {
      return blocks.reduce((max, curr) =>
        getRowValue(curr.row) > getRowValue(max.row) ? curr : max
      )
    }

    const sectionMap: Record<string, TicketBlock[]> = {}
    for (const block of ticketBlocks) {
      if (!sectionMap[block.section]) {
        sectionMap[block.section] = []
      }
      sectionMap[block.section].push(block)
    }

    const lastRowBlocks = Object.values(sectionMap).map(selectLastRow)

    for (const item of lastRowBlocks) {
      const priceText = item.price == null ? "N/A" : `$${item.price.toFixed(2)}`
      const rowText = item.row ?? "N/A"
      const seatList = item.seats.join(",")
      console.log(
        `Section ${item.section} | Row ${rowText} | Seats ${seatList} | Price ${priceText}`
      )
    }
  }

  await browser.close()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
