import { chromium } from "playwright"

type PriceMap = Record<string, number>
type SectionFallbackMap = Record<string, number>

type FacetItem = {
  section: string
  count: number
  inventoryType: "primary" | "resale"
  offerIds: string[]
}

type TicketBlock = {
  section: string
  count: number
  price: number | null
  inventoryType: "primary" | "resale"
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

function parseFacets(facetsData: unknown): FacetItem[] {
  const parsed: FacetItem[] = []
  if (!facetsData || typeof facetsData !== "object") return parsed

  const data = facetsData as Record<string, unknown>
  const items = data.facets || []
  if (!Array.isArray(items)) return parsed

  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const obj = item as Record<string, unknown>

    const section = String(obj.section ?? "").trim()
    const countRaw = obj.count
    const count =
      typeof countRaw === "number"
        ? countRaw
        : typeof countRaw === "string"
          ? Number(countRaw)
          : NaN
    const inventoryTypes = Array.isArray(obj.inventoryTypes) ? obj.inventoryTypes : []
    if (!inventoryTypes.includes("primary")) continue

    const offersRaw = Array.isArray(obj.offers) ? obj.offers : []
    const offerIds = offersRaw
      .map((offerId) => String(offerId ?? "").trim())
      .filter((offerId) => offerId.length > 0)

    const inventoryTypeRaw = String(inventoryTypes[0] ?? "primary").toLowerCase()
    const inventoryType: "primary" | "resale" =
      inventoryTypeRaw.includes("resale") ? "resale" : "primary"

    if (!section || !Number.isFinite(count)) continue

    parsed.push({
      section,
      count,
      inventoryType,
      offerIds
    })
  }

  return parsed
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

    const price =
      toPrice(offer.listPrice) ??
      toPrice(offer.totalPrice) ??
      toPrice(offer.price) ??
      toPrice(offer.faceValue)
    if (price == null) continue

    priceMap[id] = price
  }

  return priceMap
}

function parseQuickpicksSectionFallbackMap(
  quickpicksData: unknown,
  priceMap: PriceMap
): SectionFallbackMap {
  const sectionFallbackMap: SectionFallbackMap = {}
  if (!quickpicksData || typeof quickpicksData !== "object") return sectionFallbackMap

  const data = quickpicksData as Record<string, any>
  const picks = Array.isArray(data.picks) ? data.picks : []

  for (const rawPick of picks) {
    if (!rawPick || typeof rawPick !== "object") continue
    const pick = rawPick as Record<string, any>
    const section = String(pick.section ?? "").trim()
    if (!section) continue

    const offerGroups = Array.isArray(pick.offerGroups) ? pick.offerGroups : []
    for (const rawGroup of offerGroups) {
      if (!rawGroup || typeof rawGroup !== "object") continue
      const group = rawGroup as Record<string, any>
      const offerIds = Array.isArray(group.offers) ? group.offers : []

      for (const rawId of offerIds) {
        const id = String(rawId ?? "").trim()
        if (!id) continue
        const price = priceMap[id]
        if (price == null) continue

        const existing = sectionFallbackMap[section]
        sectionFallbackMap[section] = existing == null ? price : Math.min(existing, price)
      }
    }
  }

  return sectionFallbackMap
}

function buildTicketBlocks(
  facets: FacetItem[],
  priceMap: PriceMap,
  sectionFallbackMap: SectionFallbackMap
): TicketBlock[] {
  let debugJoinCount = 0
  return facets.map((facet): TicketBlock => {
      let price: number | null = null
      for (const id of facet.offerIds || []) {
        if (priceMap[id] != null) {
          price = priceMap[id]
          break
        }
      }
      if (price == null) {
        price = sectionFallbackMap[facet.section] ?? null
        if (price != null) {
          console.log("FALLBACK:", facet.section, "->", price)
        }
      }
      if (debugJoinCount < 5) {
        console.log("JOIN:", facet.section, facet.offerIds, "->", price)
        debugJoinCount += 1
      }

      return {
        section: facet.section,
        count: facet.count,
        price,
        inventoryType: facet.inventoryType
      }
    })
}

async function waitForDataCapture(
  getQuickpicks: () => unknown,
  getFacets: () => unknown,
  timeoutMs: number
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (getQuickpicks() && getFacets()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function run() {
  const eventUrl = getEventUrlFromArg()
  const browser = await chromium.launch({ headless: false }) // keep visible for debugging
  const context = await browser.newContext()
  const page = await context.newPage()
  let quickpicksData: unknown = null
  let facetsData: unknown = null

  console.log("Opening page...")

  // Capture responses
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

      if (
        !facetsData &&
        lowerUrl.includes("facets") &&
        lowerUrl.includes("show=places")
      ) {
        console.log("FACETS URL:", url)
        if (data && typeof data === "object") {
          console.log("Facets keys:", Object.keys(data as Record<string, unknown>))
        }
        console.log("Facets preview:", JSON.stringify(data, null, 2).slice(0, 800))

        const root = data as Record<string, unknown>
        const items = root.facets || []

        const isValidFacetsResponse =
          Array.isArray(items) &&
          items.length > 0 &&
          items.some((item) => {
            if (!item || typeof item !== "object") return false
            const obj = item as Record<string, unknown>
            return Boolean(obj.section && obj.count)
          })

        if (isValidFacetsResponse) {
          facetsData = data
          console.log("Captured REAL facets inventory")
        }
      }
    } catch {
      // Ignore non-JSON responses without crashing.
    }
  })

  await page.goto(eventUrl, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(8000)
  await waitForDataCapture(() => quickpicksData, () => facetsData, 5000)

  const priceMap = parseQuickpicksPriceMap(quickpicksData)
  const sectionFallbackMap = parseQuickpicksSectionFallbackMap(quickpicksData, priceMap)
  const facets = parseFacets(facetsData)
  const ticketBlocks = buildTicketBlocks(facets, priceMap, sectionFallbackMap)
  console.log("Total parsed blocks:", facets.length)

  if (ticketBlocks.length === 0) {
    console.log("No ticket data found.")
  } else {
    const seenSections = new Set<string>()
    for (const item of ticketBlocks) {
      if (item.inventoryType !== "primary") continue
      if (seenSections.has(item.section)) continue
      seenSections.add(item.section)

      const priceText = item.price == null ? "N/A" : `$${item.price.toFixed(2)}`
      console.log(
        `Section ${item.section} | Count ${item.count} | Price ${priceText} | ${item.inventoryType}`
      )
    }
  }

  await browser.close()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})