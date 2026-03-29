import { chromium, BrowserContext } from "playwright"

type OfferPrice = {
  total: number | null      // total for the whole group
  perTicket: number | null  // per-seat price
}

type OfferPriceMap = Record<string, OfferPrice>

type TicketBlock = {
  section: string
  row: string | null
  seats: string[]
  quantity: number
  pricePerTicket: number | null
  totalPrice: number | null
  inventoryType: "primary"
  isLargeBlock: boolean
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

// Build a global offer-price map from the embedded offers on the first quickpicks page.
// Sum all charge amounts in an offer's charges[] array (each is per-ticket).
// Guards against missing / non-numeric entries.
function sumCharges(charges: unknown): number {
  if (!Array.isArray(charges)) return 0
  let sum = 0
  for (const charge of charges) {
    if (!charge || typeof charge !== "object") continue
    const amt = toPrice((charge as Record<string, unknown>).amount)
    if (amt !== null) sum += amt
  }
  return sum
}

// Extract the all-in price from a raw offer object using the priority chain:
//   1. allInPrice / inclusivePrice  → explicit all-in per-ticket value
//   2. totalPrice                   → all-in group total (per-ticket unknown here)
//   3. faceValue / listPrice + sum(charges[].amount) → build per-ticket ourselves
// Returns { perTicket, total } — exactly one will be non-null in cases 1 and 3;
// in case 2 only `total` is set (seatCount needed to derive perTicket).
function extractAllInPrice(o: Record<string, unknown>): OfferPrice {
  // Priority 1: explicit all-in per-ticket field
  const allInPerTicket = toPrice(o.allInPrice) ?? toPrice(o.inclusivePrice) ?? null
  if (allInPerTicket !== null) {
    return { perTicket: allInPerTicket, total: null }
  }

  // Priority 2: totalPrice is the all-in group charge as returned by TM
  const groupTotal = toPrice(o.totalPrice) ?? null
  if (groupTotal !== null) {
    return { perTicket: null, total: groupTotal }
  }

  // Priority 3: base face value + all per-ticket charges summed
  const base = toPrice(o.faceValue) ?? toPrice(o.listPrice) ?? null
  if (base !== null) {
    const fees = sumCharges(o.charges)
    console.log("OFFER fees:", { base, fees, charges: o.charges })
    return { perTicket: base + fees, total: null }
  }

  return { perTicket: null, total: null }
}

function buildOfferPriceMap(quickpicksData: unknown): OfferPriceMap {
  const map: OfferPriceMap = {}
  if (!quickpicksData || typeof quickpicksData !== "object") return map

  const data = quickpicksData as Record<string, any>
  const embeddedOffers = data._embedded?.offer ?? data._embedded?.offers ?? []
  if (!Array.isArray(embeddedOffers)) return map

  for (const rawOffer of embeddedOffers) {
    if (!rawOffer || typeof rawOffer !== "object") continue
    const offer = rawOffer as Record<string, unknown>

    const id = String(offer.id ?? offer.offerId ?? "").trim()
    if (!id) continue

    const price = extractAllInPrice(offer)
    console.log("OFFER:", { id, perTicket: price.perTicket, total: price.total })
    map[id] = price
  }

  return map
}

// Resolve a single offer entry (string ID or inline object) to an all-in OfferPrice.
// Inline objects take precedence over the global map so that any extra fields
// present inline (e.g. charges[]) are used before falling back to cached values.
function resolveOfferPrice(offer: unknown, map: OfferPriceMap): OfferPrice {
  if (typeof offer === "string") {
    return map[offer.trim()] ?? { total: null, perTicket: null }
  }
  if (offer && typeof offer === "object") {
    const o = offer as Record<string, unknown>
    const id = String(o.id ?? o.offerId ?? "").trim()

    const inline = extractAllInPrice(o)

    // If inline gave us something useful, use it; otherwise fall back to global map
    const fromMap = id ? (map[id] ?? { perTicket: null, total: null }) : { perTicket: null, total: null }
    return {
      perTicket: inline.perTicket ?? fromMap.perTicket,
      total: inline.total ?? fromMap.total,
    }
  }
  return { total: null, perTicket: null }
}

// Given a list of raw offer entries for one offerGroup and its seat count,
// return the lowest per-ticket price and its corresponding total.
// Normalise a raw `totalPrice` value into { perTicket, total }.
//
// When a referencePerTicket is available (from allInPrice, faceValue+charges, etc.
// resolved from the same offer group), we use cross-field proximity to decide:
//   - if (totalPrice / seatCount) is closer to the reference → it's a group total → divide
//   - if rawTotal itself is closer to the reference → it was already per-ticket → don't divide
//
// When no reference exists we fall back to a minimal heuristic (divided < 5 is
// implausible for any real ticket price, so treat rawTotal as per-ticket).
function normaliseTotalPrice(
  rawTotal: number,
  seatCount: number,
  referencePerTicket: number | null
): { perTicket: number | null; total: number | null } {
  if (!rawTotal || !seatCount) return { perTicket: null, total: null }

  const divided = rawTotal / seatCount

  if (referencePerTicket !== null) {
    const diffDivided = Math.abs(divided - referencePerTicket)
    const diffRaw = Math.abs(rawTotal - referencePerTicket)
    const chosenPerTicket = diffDivided <= diffRaw ? divided : rawTotal

    console.log("[PRICE DEBUG]", {
      totalPrice: rawTotal,
      seatCount,
      divided,
      referencePerTicket,
      diffDivided,
      diffRaw,
      chosenPerTicket,
    })

    if (diffDivided <= diffRaw) {
      // divided is closer to reference → rawTotal is a true group total
      return { perTicket: divided, total: rawTotal }
    } else {
      // rawTotal itself is closer to reference → it was already per-ticket
      return { perTicket: rawTotal, total: rawTotal * seatCount }
    }
  }

  // No reference available — TM quickpicks totalPrice is consistently per-ticket.
  // Never divide without explicit evidence that rawTotal is a group total.
  console.log("[PRICE DEBUG]", {
    totalPrice: rawTotal,
    seatCount,
    referencePerTicket: null,
    usedFallbackMode: "raw-is-per-ticket",
    chosenPerTicket: rawTotal,
  })

  return { perTicket: rawTotal, total: rawTotal * seatCount }
}

function bestPriceForGroup(
  offerEntries: unknown[],
  seatCount: number,
  map: OfferPriceMap
): { perTicket: number | null; total: number | null } {
  // Pass 1: collect any explicitly-resolved per-ticket prices (from allInPrice,
  // faceValue+charges, etc.) so they can serve as a reference when normalising
  // totalPrice entries. Take the lowest since we want the best price.
  let referencePerTicket: number | null = null
  for (const entry of offerEntries) {
    const p = resolveOfferPrice(entry, map)
    if (p.perTicket !== null) {
      if (referencePerTicket === null || p.perTicket < referencePerTicket) {
        referencePerTicket = p.perTicket
      }
    }
  }

  // Pass 2: resolve all entries, using referencePerTicket to disambiguate totalPrice
  let bestPerTicket: number | null = null
  let bestTotal: number | null = null

  for (const entry of offerEntries) {
    const p = resolveOfferPrice(entry, map)

    let pt: number | null = null
    let tot: number | null = null

    if (p.perTicket !== null) {
      // From allInPrice/inclusivePrice or faceValue+charges — unambiguously per-ticket
      pt = p.perTicket
      tot = p.perTicket * seatCount
    } else if (p.total !== null) {
      // From totalPrice — semantics are ambiguous; use cross-field validation
      const normalised = normaliseTotalPrice(p.total, seatCount, referencePerTicket)
      pt = normalised.perTicket
      tot = normalised.total
    }

    if (pt !== null && (bestPerTicket === null || pt < bestPerTicket)) {
      bestPerTicket = pt
      bestTotal = tot
    }
  }

  return { perTicket: bestPerTicket, total: bestTotal }
}

function isConsecutive(seats: string[]): boolean {
  if (seats.length === 0) return false
  const sorted = seats.map(Number).sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false
  }
  return true
}

function buildTicketBlocksFromPicks(
  picks: unknown[],
  offerPriceMap: OfferPriceMap
): TicketBlock[] {
  const blocks: TicketBlock[] = []

  // Top-level places/seats fallback (used when offerGroup has no explicit seats)
  function topLevelSeats(pick: Record<string, any>): string[] {
    return Array.isArray(pick.places)
      ? pick.places.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
      : Array.isArray(pick.seats)
        ? pick.seats.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
        : []
  }

  for (const rawPick of picks) {
    if (!rawPick || typeof rawPick !== "object") continue
    const pick = rawPick as Record<string, any>

    if (pick.selection !== "standard") continue

    const section = String(pick.section ?? "").trim()
    const row = typeof pick.row === "string" ? pick.row.trim() || null : null
    const offerGroups: unknown[] = Array.isArray(pick.offerGroups) ? pick.offerGroups : []

    if (offerGroups.length > 0) {
      // Each offerGroup is an independent seat+offer bundle
      for (const rawGroup of offerGroups) {
        if (!rawGroup || typeof rawGroup !== "object") continue
        const group = rawGroup as Record<string, any>

        const groupSeats: string[] = Array.isArray(group.seats)
          ? group.seats.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
          : []

        const seats = groupSeats.length > 0 ? groupSeats : topLevelSeats(pick)
        if (seats.length < 2 || !isConsecutive(seats)) continue

        const offerEntries: unknown[] = Array.isArray(group.offers) ? group.offers : []
        const { perTicket, total } = bestPriceForGroup(offerEntries, seats.length, offerPriceMap)

        console.log("PARSED:", section, row, seats, "| $/ticket:", perTicket, "| total:", total)

        blocks.push({
          section,
          row,
          seats,
          quantity: seats.length,
          pricePerTicket: perTicket,
          totalPrice: total,
          inventoryType: "primary",
          isLargeBlock: seats.length >= 4,
        })
      }
    } else {
      // No offerGroups at all — seats at the top level, no per-seat offer linkage
      const seats = topLevelSeats(pick)
      if (seats.length < 2 || !isConsecutive(seats)) continue

      console.log("PARSED (no offerGroups):", section, row, seats)

      blocks.push({
        section,
        row,
        seats,
        quantity: seats.length,
        pricePerTicket: null,
        totalPrice: null,
        inventoryType: "primary",
        isLargeBlock: seats.length >= 4,
      })
    }
  }

  console.log("TOTAL BLOCKS:", blocks.length)
  return blocks
}

function consolidateSeatBlocks(blocks: TicketBlock[]): TicketBlock[] {
  // Group by section + row
  const groupMap: Record<string, TicketBlock[]> = {}
  for (const block of blocks) {
    const key = `${block.section}|||${block.row ?? ""}`
    if (!groupMap[key]) groupMap[key] = []
    groupMap[key].push(block)
  }

  const consolidated: TicketBlock[] = []

  for (const key of Object.keys(groupMap)) {
    const group = groupMap[key]
    const { section, row } = group[0]

    // Build seat-number → best per-ticket price map so we preserve prices
    // through the merge. When the same seat appears in multiple blocks
    // (from different qty variants), we keep the lowest per-ticket price.
    const seatPriceMap = new Map<number, number | null>()

    for (const block of group) {
      const pt = block.pricePerTicket
      for (const s of block.seats) {
        const n = Number(s)
        const existing = seatPriceMap.get(n)
        if (existing === undefined) {
          seatPriceMap.set(n, pt)
        } else if (pt !== null && (existing === null || pt < existing)) {
          seatPriceMap.set(n, pt)
        }
      }
    }

    const allSeatNums = [...seatPriceMap.keys()].sort((a, b) => a - b)
    if (allSeatNums.length === 0) continue

    // Split into consecutive runs
    const sequences: number[][] = []
    let current: number[] = [allSeatNums[0]]

    for (let i = 1; i < allSeatNums.length; i++) {
      if (allSeatNums[i] === allSeatNums[i - 1] + 1) {
        current.push(allSeatNums[i])
      } else {
        sequences.push(current)
        current = [allSeatNums[i]]
      }
    }
    sequences.push(current)

    for (const seq of sequences) {
      const seats = seq.map(String)

      // Best per-ticket across all seats in this run
      let bestPerTicket: number | null = null
      for (const n of seq) {
        const pt = seatPriceMap.get(n) ?? null
        if (pt !== null && (bestPerTicket === null || pt < bestPerTicket)) {
          bestPerTicket = pt
        }
      }
      const totalPrice = bestPerTicket !== null ? bestPerTicket * seq.length : null

      console.log("CONSOLIDATED:", section, row, seats, "| $/ticket:", bestPerTicket)

      consolidated.push({
        section,
        row,
        seats,
        quantity: seats.length,
        pricePerTicket: bestPerTicket,
        totalPrice,
        inventoryType: "primary",
        isLargeBlock: seats.length >= 4,
      })
    }
  }

  return consolidated
}

// ── ISMDS multi-variant fetcher ───────────────────────────────────────────────

const ISMDS_QTY_VARIANTS = [1, 2, 3, 4, 5, 6]
const ISMDS_LIMIT = 40

// Returns a stable key for deduplicating picks across different requests.
function pickKey(pick: Record<string, any>): string {
  const section = String(pick.section ?? "").trim()
  const row = String(pick.row ?? "").trim()
  const seats: string[] = Array.isArray(pick.offerGroups?.[0]?.seats)
    ? pick.offerGroups[0].seats.map(String)
    : Array.isArray(pick.places)
      ? pick.places.map(String)
      : Array.isArray(pick.seats)
        ? pick.seats.map(String)
        : []
  return `${section}|||${row}|||${seats.sort().join(",")}`
}

// Paginate a single ISMDS quickpicks URL to exhaustion.
async function paginateQuickpicks(
  context: BrowserContext,
  baseUrl: URL,
  headers: Record<string, string> | null,
  label: string
): Promise<unknown[]> {
  const picks: unknown[] = []
  let offset = 0

  while (true) {
    baseUrl.searchParams.set("offset", offset.toString())
    const response = await context.request.get(baseUrl.toString(), {
      headers: headers ?? undefined,
    })

    if (!response.ok()) {
      console.log(`[ISMDS] ${label} offset=${offset}: HTTP ${response.status()} — stopping`)
      break
    }

    const data = (await response.json()) as Record<string, any>
    const page: unknown[] = Array.isArray(data.picks) ? data.picks : []
    picks.push(...page)
    console.log(`[ISMDS] ${label} offset=${offset}: ${page.length} picks (total so far: ${picks.length})`)

    if (page.length < ISMDS_LIMIT) break
    offset += ISMDS_LIMIT
  }

  return picks
}

// Fetch quickpicks for every qty variant, deduplicate across all pages/qtys.
async function fetchIsmdsVariants(
  context: BrowserContext,
  quickpicksUrl: string,
  headers: Record<string, string> | null
): Promise<unknown[]> {
  const seen = new Set<string>()
  const allPicks: unknown[] = []

  function ingest(pick: unknown) {
    if (!pick || typeof pick !== "object") return
    const key = pickKey(pick as Record<string, any>)
    if (!seen.has(key)) {
      seen.add(key)
      allPicks.push(pick)
    }
  }

  for (const qty of ISMDS_QTY_VARIANTS) {
    const url = new URL(quickpicksUrl)
    url.searchParams.set("qty", qty.toString())
    url.searchParams.set("limit", ISMDS_LIMIT.toString())
    // Ensure seat-level data is returned
    url.searchParams.set("compress", "places")
    url.searchParams.set("show", "places")

    console.log(`[ISMDS] ── qty=${qty} ──────────────────────────────`)
    const picks = await paginateQuickpicks(context, url, headers, `qty=${qty}`)
    let newThisVariant = 0
    for (const p of picks) {
      const before = seen.size
      ingest(p)
      if (seen.size > before) newThisVariant++
    }
    console.log(`[ISMDS] qty=${qty}: ${picks.length} fetched, ${newThisVariant} new unique picks`)
  }

  console.log(`[ISMDS] Grand total unique picks across all qty variants: ${allPicks.length}`)
  return allPicks
}

// Fetch facets endpoint for diagnostic section/row structure.
async function fetchFacets(
  context: BrowserContext,
  quickpicksUrl: string,
  headers: Record<string, string> | null
): Promise<void> {
  const facetsBase = new URL(quickpicksUrl)
  facetsBase.pathname = facetsBase.pathname.replace(/\/quickpicks$/, "/facets")

  const configs: Record<string, string>[] = [
    { by: "section" },
    { by: "section", includeResale: "true" },
    { by: "inventoryType" },
    { by: "section", mode: "primary:ppsn" },
  ]

  for (const cfg of configs) {
    const url = new URL(facetsBase.toString())
    for (const [k, v] of Object.entries(cfg)) url.searchParams.set(k, v)

    try {
      const response = await context.request.get(url.toString(), {
        headers: headers ?? undefined,
      })
      if (!response.ok()) {
        console.log(`[FACETS] ${JSON.stringify(cfg)}: HTTP ${response.status()}`)
        continue
      }
      const data = await response.json()
      console.log(`[FACETS] ${JSON.stringify(cfg)}:`, JSON.stringify(data).slice(0, 600))
    } catch (e: any) {
      console.log(`[FACETS] ${JSON.stringify(cfg)}: error — ${e?.message}`)
    }
  }
}

// ── Coverage report ───────────────────────────────────────────────────────────

// ── Last-row filtering ────────────────────────────────────────────────────────

type LastRowMode = "strict" | "buffer"

// Convert a row label to a sortable number.
//   Numeric strings → parseInt          ("3" → 3)
//   Letter strings  → bijective base-26 ("A" → 1, "Z" → 26, "AA" → 27)
//   Anything else   → -1 (sorts before all real rows)
function normalizeRow(row: string | null): number {
  if (row === null || row.trim() === "") return -1

  const n = parseInt(row, 10)
  if (!isNaN(n)) return n

  const upper = row.trim().toUpperCase()
  if (!/^[A-Z]+$/.test(upper)) return -1

  return upper.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0)
}

// Build a map of section → highest normalised row value seen in `blocks`.
function buildLastRowMap(blocks: TicketBlock[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const block of blocks) {
    const val = normalizeRow(block.row)
    const current = map.get(block.section)
    if (current === undefined || val > current) {
      map.set(block.section, val)
    }
  }
  return map
}

// Keep only blocks that belong to the deepest row(s) per section.
// mode "strict" → exactly the last row
// mode "buffer" → last row AND the row immediately before it (value - 1)
function filterToLastRows(blocks: TicketBlock[], mode: LastRowMode = "strict"): TicketBlock[] {
  const lastRowMap = buildLastRowMap(blocks)

  return blocks.filter((block) => {
    const maxVal = lastRowMap.get(block.section)
    if (maxVal === undefined) return false
    const val = normalizeRow(block.row)
    if (mode === "strict") return val === maxVal
    // buffer: accept last row and the one before it
    return val === maxVal || val === maxVal - 1
  })
}

// ── Coverage report ───────────────────────────────────────────────────────────

function reportCoverage(blocks: TicketBlock[]): void {
  // Build section → row → sorted seat list
  const sectionMap: Record<string, Record<string, number[]>> = {}

  for (const block of blocks) {
    const sec = block.section || "(none)"
    const row = block.row ?? "(no row)"
    if (!sectionMap[sec]) sectionMap[sec] = {}
    if (!sectionMap[sec][row]) sectionMap[sec][row] = []
    sectionMap[sec][row].push(...block.seats.map(Number))
  }

  function rowSortKey(r: string): number {
    const n = parseInt(r)
    return isNaN(n)
      ? r.split("").reduce((acc, c) => acc * 26 + c.charCodeAt(0), 0)
      : n
  }

  const sections = Object.keys(sectionMap).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  let totalGroups = 0
  let gappedRows = 0

  const LINE = "─".repeat(64)
  console.log(`\n${LINE}`)
  console.log(`[COVERAGE] ${sections.length} sections, ${blocks.length} seat groups`)
  console.log(LINE)

  for (const section of sections) {
    const rowMap = sectionMap[section]
    const rows = Object.keys(rowMap).sort((a, b) => rowSortKey(a) - rowSortKey(b))

    for (const row of rows) {
      const seats = [...new Set(rowMap[row])].sort((a, b) => a - b)
      const span = seats[seats.length - 1] - seats[0] + 1
      const gaps = span - seats.length
      totalGroups++
      if (gaps > 0) gappedRows++

      const gapFlag = gaps > 0 ? `  ⚠ ${gaps} gap(s) in [${seats[0]}–${seats[seats.length - 1]}]` : ""
      console.log(
        `  Sec ${section.padEnd(6)} Row ${String(row).padEnd(4)}` +
        ` | ${String(seats.length).padStart(3)} seats` +
        ` [${seats[0]}–${seats[seats.length - 1]}]${gapFlag}`
      )
    }
  }

  console.log(LINE)
  console.log(
    `[COVERAGE] ${totalGroups} unique section/row groups` +
    (gappedRows > 0 ? ` | ${gappedRows} row(s) with seat gaps` : " | no seat gaps detected")
  )
  console.log(`${LINE}\n`)
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

const WS_INTERCEPT_SCRIPT = `
(function () {
  'use strict';

  const wsProto = window.WebSocket.prototype;
  const origAddEventListener = wsProto.addEventListener;
  const onmessageDesc = Object.getOwnPropertyDescriptor(wsProto, 'onmessage');

  // Resolve any WS message data to a string regardless of frame type
  async function resolveText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return data.text();
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer);
    return null;
  }

  async function tryIntercept(event) {
    window.__WS_COUNT__ = (window.__WS_COUNT__ || 0) + 1;

    const dataType = event.data instanceof Blob ? 'Blob'
                   : event.data instanceof ArrayBuffer ? 'ArrayBuffer'
                   : ArrayBuffer.isView(event.data) ? 'TypedArray'
                   : typeof event.data;

    console.log('[__WS__] MESSAGE RECEIVED, TYPE: ' + dataType);

    const text = await resolveText(event.data);
    if (!text) return;

    console.log('[__WS__] RAW MESSAGE: ' + text.slice(0, 200));

    if (!text.includes('availability')) return;

    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }

    if (!msg || msg.type !== 'data') return;
    console.log('[__WS__] DATA MESSAGE RECEIVED');

    const avail = msg && msg.data && msg.data.availability;
    if (!avail) return;

    console.log('[__WS__] availability keys: ' + JSON.stringify(Object.keys(avail)));
    window.__WS_AVAILABILITY_RAW__ = avail;

    const buf = avail.buffer;
    if (buf !== undefined && buf !== null) {
      if (typeof buf === 'object' && !Array.isArray(buf)) {
        // Already decoded as a plain object
        console.log('DECODED DATA: ' + JSON.stringify(buf));
        window.__SEAT_DATA__ = buf;
      } else {
        // Binary / base64 / array — log shape so we know what we're dealing with
        const shape = Array.isArray(buf) ? 'Array(' + buf.length + ')'
                    : typeof buf === 'string' ? 'base64(' + buf.length + ')'
                    : typeof buf;
        console.log('[__WS__] buffer is ' + shape + ' — waiting for page to decode it');
      }
    } else {
      // No separate buffer field; the whole availability object IS the decoded map
      console.log('DECODED DATA: ' + JSON.stringify(avail));
      window.__SEAT_DATA__ = avail;
    }
  }

  // Fire our async intercept without blocking the page's own synchronous handler
  function fireIntercept(event) {
    tryIntercept(event).catch(function (e) {
      console.log('[__WS__] intercept error: ' + e.message);
    });
  }

  // --- wrap prototype addEventListener so every WS instance is covered ---
  wsProto.addEventListener = function (type, listener, options) {
    if (type !== 'message') return origAddEventListener.call(this, type, listener, options);
    const wrapped = function (event) {
      fireIntercept(event);
      return listener.apply(this, arguments);
    };
    return origAddEventListener.call(this, type, wrapped, options);
  };

  // --- wrap the onmessage setter on the prototype ---
  if (onmessageDesc && onmessageDesc.set) {
    Object.defineProperty(wsProto, 'onmessage', {
      get: onmessageDesc.get,
      set: function (handler) {
        onmessageDesc.set.call(this, function (event) {
          fireIntercept(event);
          return handler && handler.apply(this, arguments);
        });
      },
      configurable: true,
      enumerable: onmessageDesc.enumerable,
    });
  }

  // --- hook any top-level decode / deserialize function already on window ---
  const DECODE_NAMES = ['decode', 'decodeSeats', 'decodeSeatMap', 'decodeAvailability', 'deserialize'];
  for (const name of DECODE_NAMES) {
    if (typeof window[name] === 'function') {
      const orig = window[name];
      window[name] = function () {
        const result = orig.apply(this, arguments);
        if (result && typeof result === 'object' &&
            (result.sections || result.rows || result.seatStatus || result.availableCount)) {
          console.log('DECODED DATA: ' + JSON.stringify(result));
          window.__SEAT_DATA__ = result;
        }
        return result;
      };
    }
  }

  // --- poll: once the page decodes the buffer it will likely store the result
  //     somewhere reachable; also watch for protobuf.js appearing late ---
  let polls = 0;
  const POLL_MS = 800;
  const MAX_POLLS = 150; // ~2 minutes
  const SEAT_INDICATORS = ['sections', 'rows', 'seatStatus', 'availableCount', 'inventory'];

  const timer = setInterval(function () {
    polls++;
    if (polls > MAX_POLLS) { clearInterval(timer); return; }

    // Hook protobuf.js if it appeared since last poll
    if (window.protobuf && !window.__protobuf_hooked__) {
      window.__protobuf_hooked__ = true;
      const origDec = window.protobuf.decode;
      if (typeof origDec === 'function') {
        window.protobuf.decode = function () {
          const r = origDec.apply(this, arguments);
          if (r && typeof r === 'object') {
            console.log('DECODED DATA [protobuf.decode]: ' + JSON.stringify(r).slice(0, 4000));
            window.__SEAT_DATA__ = r;
          }
          return r;
        };
      }
    }

    // Check every enumerable window property for decoded seat-map shape
    try {
      for (const key of Object.keys(window)) {
        if (key.startsWith('__') || key === 'window') continue;
        let val;
        try { val = window[key]; } catch (_) { continue; }
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        const keys = Object.keys(val);
        if (SEAT_INDICATORS.filter(k => keys.includes(k)).length >= 2) {
          if (window.__SEAT_DATA__ !== val) {
            console.log('DECODED DATA [window.' + key + ']: ' + JSON.stringify(val).slice(0, 4000));
            window.__SEAT_DATA__ = val;
          }
        }
      }
    } catch (_) {}

  }, POLL_MS);

  console.log('[__WS__] WebSocket intercept installed');
})();
`;

async function run() {
  const eventUrl = getEventUrlFromArg()
  const browser = await chromium.launch({ headless: false })

  // Completely clean context — no cache, no stored state, no cookies
  const context = await browser.newContext({
    storageState: undefined,
    bypassCSP: true,
  })

  // Disable HTTP cache so TM can't serve stale resources that skip WS init
  await context.route("**/*", (route) => {
    route.continue({ headers: { ...route.request().headers(), "Cache-Control": "no-cache" } })
  })

  // Inject the WS intercept at the CONTEXT level — fires in every frame,
  // before ANY page script, guaranteed to run before WS connections open
  await context.addInitScript({ content: WS_INTERCEPT_SCRIPT })

  const page = await context.newPage()
  let quickpicksData: unknown = null
  let quickpicksUrl: string | null = null
  let quickpicksHeaders: Record<string, string> | null = null

  // Relay browser console → Node stdout so injected logs are visible
  page.on("console", (msg) => {
    const text = msg.text()
    if (
      text.startsWith("[__WS__]") ||
      text.startsWith("DECODED DATA") ||
      text.startsWith("[__SEAT_DATA__]") ||
      text.startsWith("[protobuf")
    ) {
      console.log("[BROWSER]", text)
    }
  })

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
        quickpicksUrl = url
        const reqHeaders = response.request().headers()
        delete reqHeaders["content-length"]
        delete reqHeaders["host"]
        quickpicksHeaders = reqHeaders
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

  // ── 1. Wait for the venue / seat map to render ────────────────────────────
  // TM renders the map inside an <svg> or a canvas inside a div with well-known
  // class fragments. Wait up to 20 s for any of these to appear.
  console.log("[NAV] Waiting for seat map to appear...")
  const MAP_SELECTORS = [
    '[data-testid="map"]',
    '[class*="seatmap"]',
    '[class*="seat-map"]',
    '[class*="venueMap"]',
    '[class*="venue-map"]',
    'svg[class*="map"]',
    'canvas',
    '[class*="map-container"]',
    '[class*="mapContainer"]',
  ]
  let mapVisible = false
  for (const sel of MAP_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 20000, state: "visible" })
      console.log(`[NAV] Map found with selector: ${sel}`)
      mapVisible = true
      break
    } catch {
      // try next selector
    }
  }
  if (!mapVisible) {
    console.log("[NAV] No map selector matched — will attempt coordinate click anyway")
  }

  // Extra settle time after map paints
  await page.waitForTimeout(3000)

  // ── 2. Click a section on the map ─────────────────────────────────────────
  // Try known section selectors first; fall back to clicking in the centre of
  // the map element, or a fixed canvas coordinate.
  const SECTION_SELECTORS = [
    '[data-section]',
    '[class*="section"][fill]',       // SVG <path> with a fill (coloured sections)
    'path[fill="#0057B8"]',            // TM blue
    'path[fill="#1E90FF"]',
    'path[fill*="blue"]',
    '[class*="available"]',
    '[class*="section-available"]',
    'g[id^="section"]',
    '[data-testid*="section"]',
  ]
  let clicked = false
  for (const sel of SECTION_SELECTORS) {
    try {
      const el = page.locator(sel).first()
      const count = await el.count()
      if (count > 0) {
        await el.scrollIntoViewIfNeeded()
        await el.click({ timeout: 5000, force: true })
        console.log(`[NAV] Clicked section via selector: ${sel}`)
        clicked = true
        break
      }
    } catch {
      // try next
    }
  }

  if (!clicked) {
    // Fall back: click the centre of the first map-like element
    for (const sel of MAP_SELECTORS) {
      try {
        const el = page.locator(sel).first()
        if (await el.count() > 0) {
          const box = await el.boundingBox()
          if (box) {
            await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4)
            console.log(`[NAV] Clicked map centre via bounding box of: ${sel}`)
            clicked = true
            break
          }
        }
      } catch {
        // try next
      }
    }
  }

  if (!clicked) {
    // Last resort: click a central viewport coordinate where the map usually is
    const vp = page.viewportSize() ?? { width: 1280, height: 720 }
    await page.mouse.click(vp.width * 0.5, vp.height * 0.45)
    console.log("[NAV] Clicked fixed viewport centre as last resort")
  }

  await page.waitForTimeout(1500)

  // ── 3. Zoom in 3× to force tile / availability requests ───────────────────
  const ZOOM_SELECTORS = [
    '[aria-label="Zoom in"]',
    '[data-testid="zoom-in"]',
    'button[class*="zoom-in"]',
    'button[class*="zoomIn"]',
    '[title="Zoom in"]',
    '[class*="zoom"] button:first-child',
  ]
  let zoomed = false
  for (const sel of ZOOM_SELECTORS) {
    try {
      const btn = page.locator(sel).first()
      if (await btn.count() > 0) {
        for (let i = 0; i < 3; i++) {
          await btn.click({ timeout: 3000 })
          await page.waitForTimeout(400)
        }
        console.log("[NAV] Zoomed in 3× via: " + sel)
        zoomed = true
        break
      }
    } catch {
      // try next
    }
  }
  if (!zoomed) console.log("[NAV] No zoom button found — skipping zoom")

  // ── 4. Change ticket quantity to 4 if the control is present ──────────────
  const QTY_SELECTORS = [
    'select[class*="quantity"]',
    'select[class*="qty"]',
    '[data-testid*="quantity"] select',
    'select[aria-label*="quantity" i]',
    'select[aria-label*="tickets" i]',
  ]
  for (const sel of QTY_SELECTORS) {
    try {
      const el = page.locator(sel).first()
      if (await el.count() > 0) {
        await el.selectOption("4")
        console.log("[NAV] Set quantity to 4 via: " + sel)
        break
      }
    } catch {
      // not found or not selectable
    }
  }

  // ── 5. Wait for WS messages to arrive after interaction ───────────────────
  console.log("[NAV] Waiting up to 10 s for WebSocket messages after interaction...")
  await page.waitForTimeout(10000)
  await waitForQuickpicks(() => quickpicksData, 5000)

  // ── 6. Report interception results ────────────────────────────────────────
  const wsCount = await page.evaluate(() => (window as any).__WS_COUNT__ ?? 0)
  console.log(`[WS] Total WebSocket messages intercepted: ${wsCount}`)

  const hasRawAvail = await page.evaluate(() => !!(window as any).__WS_AVAILABILITY_RAW__)
  console.log(`[WS] __WS_AVAILABILITY_RAW__ populated: ${hasRawAvail}`)

  const hasSeatData = await page.evaluate(() => !!(window as any).__SEAT_DATA__)
  console.log(`[WS] __SEAT_DATA__ populated: ${hasSeatData}`)

  // Pull whatever the injected script decoded out of the page context
  const seatData = await page.evaluate(() => {
    return (window as any).__SEAT_DATA__ ?? null
  })
  if (seatData) {
    console.log("[SEAT_DATA] Decoded seat map retrieved from page:")
    console.log(JSON.stringify(seatData, null, 2).slice(0, 8000))
  } else {
    const rawAvail = await page.evaluate(() => {
      return (window as any).__WS_AVAILABILITY_RAW__ ?? null
    })
    if (rawAvail) {
      console.log("[SEAT_DATA] Raw availability object (buffer not yet decoded by page):")
      console.log(JSON.stringify(rawAvail, null, 2).slice(0, 4000))
    } else {
      console.log("[SEAT_DATA] No availability data captured yet — WS message may not have arrived")
    }
  }

  // ── ISMDS HTTP expansion ──────────────────────────────────────────────────
  if (!quickpicksUrl) {
    console.log("[ISMDS] No quickpicks URL captured — cannot run variant sweep")
  } else {
    // 1. Facets diagnostic (fire-and-forget logging, non-blocking for picks)
    console.log("\n[ISMDS] Fetching facets for structure diagnostics...")
    await fetchFacets(context, quickpicksUrl, quickpicksHeaders)

    // 2. Multi-qty variant sweep — deduplicated across all responses
    console.log("\n[ISMDS] Starting multi-qty variant sweep...")
    const allPicks = await fetchIsmdsVariants(context, quickpicksUrl, quickpicksHeaders)

    // 3. Build offer-price map from the first page's embedded offers
    const priceMap = buildOfferPriceMap(quickpicksData)

    // 4. Parse picks → raw seat blocks → consolidate consecutive runs
    const rawBlocks = buildTicketBlocksFromPicks(allPicks, priceMap)
    const consolidatedBlocks = consolidateSeatBlocks(rawBlocks)
    console.log(`\n[ISMDS] ${consolidatedBlocks.length} consolidated seat blocks after deduplication`)

    // 5. Last-row filtering
    //    Change to "buffer" to also include the row immediately before the last.
    const LAST_ROW_MODE: LastRowMode = "strict"
    const ticketBlocks = filterToLastRows(consolidatedBlocks, LAST_ROW_MODE)
    console.log(`[ISMDS] ${ticketBlocks.length} blocks after last-row filter (mode="${LAST_ROW_MODE}")`)

    // 6. Coverage report (full picture first, then filtered)
    console.log("\n[COVERAGE] Full inventory (pre-filter):")
    reportCoverage(consolidatedBlocks)
    console.log("[COVERAGE] Last-row only (post-filter):")
    reportCoverage(ticketBlocks)

    // 7. Per-block output
    if (ticketBlocks.length === 0) {
      console.log("[ISMDS] No seat blocks found.")
    } else {
      for (const item of ticketBlocks) {
        const perTicketText = item.pricePerTicket == null ? "N/A" : `$${item.pricePerTicket.toFixed(2)}/ea`
        const totalText = item.totalPrice == null ? "N/A" : `$${item.totalPrice.toFixed(2)} total`
        const rowText = item.row ?? "N/A"
        const seatList = item.seats.join(",")
        console.log(
          `Section ${item.section} | Row ${rowText} | Seats ${seatList}` +
          ` | Qty ${item.quantity} | ${perTicketText} | ${totalText} | LargeBlock ${item.isLargeBlock}`
        )
      }
    }
  }

  await browser.close()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
