/**
 * download-photos.ts  — Deep multi-source plant photo downloader
 *
 * Search chain per plant (stops at first hit):
 *   1. Wikipedia MediaWiki API — pageimages prop (most reliable for WP articles)
 *   2. Wikimedia Commons search API — File: namespace direct search
 *   3. Wikimedia Commons category crawl — Category:<LatinName>
 *   4. iNaturalist observations API   — real taxon photos, very broad coverage
 *
 * Already-downloaded files are skipped unless --no-skip-existing flag is set.
 *
 * Usage:
 *   npm run photos                      # all plants, skip existing
 *   npm run photos -- --no-skip-existing # re-download everything
 *   npm run photos -- --only-missing    # only plants without a DB record
 *   npm run photos -- --limit 50        # first 50 plants only (for testing)
 */

import { config } from "dotenv"
import { existsSync, mkdirSync } from "fs"
import { join } from "path"
import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"
import { eq } from "drizzle-orm"
import * as schema from "../src/db/schema"
import sharp from "sharp"

config({ path: ".env.local" })

const dbSql = neon(process.env.DATABASE_URL!)
const db = drizzle(dbSql, { schema })

const PHOTOS_DIR = join(process.cwd(), "public", "photos")
const UA = "DrachtplantenBot/2.0 (https://drachtplanten.nl; educational)"
const DELAY_MS = 500
const CONCURRENCY = 2
const MAX_W = 1200
const MAX_H = 900

// ── CLI flags ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const limitIdx = argv.indexOf("--limit")
const LIMIT = limitIdx !== -1 ? parseInt(argv[limitIdx + 1], 10) : Infinity
const SKIP_EXISTING = !argv.includes("--no-skip-existing")
const ONLY_MISSING  = argv.includes("--only-missing")
// --no-disk: re-try all plants that have no photo file on disk (ignores DB state)
const NO_DISK_MODE  = argv.includes("--no-disk")
// --debug: log the resolved URL and HTTP status for every download attempt
const DEBUG_MODE    = argv.includes("--debug")

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function downloadBuffer(url: string, retries = 2): Promise<Buffer | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) {
        if (DEBUG_MODE) console.error(`    [HTTP ${res.status}] ${url.slice(0, 120)}`)
        if (attempt < retries && (res.status === 429 || res.status >= 500)) {
          await sleep(5000 * (attempt + 1)) // back off 5s, 10s
          continue
        }
        return null
      }
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (DEBUG_MODE) console.error(`    [FETCH ERR] ${url.slice(0, 120)} — ${e}`)
      if (attempt < retries) { await sleep(5000 * (attempt + 1)); continue }
      return null
    }
  }
  return null
}

async function saveImage(
  buf: Buffer,
  dest: string
): Promise<{ width: number; height: number } | null> {
  try {
    const r = await sharp(buf)
      .resize({ width: MAX_W, height: MAX_H, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, progressive: true })
      .toFile(dest)
    return { width: r.width, height: r.height }
  } catch (e) {
    if (DEBUG_MODE) console.error(`    [SHARP ERR] ${dest} — ${e}`)
    return null
  }
}

// ── Source 1: Wikipedia MediaWiki pageimages API ──────────────────────────────
interface MwPageImagesResponse {
  query?: {
    pages?: Record<string, {
      pageid?: number
      thumbnail?: { source: string; width: number; height: number }
    }>
  }
}

async function tryWikipediaPageImages(
  title: string,
  lang: "en" | "nl"
): Promise<string | null> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php` +
    `?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&pithumbsize=1400&pilimit=1&format=json&origin=*`
  const data = await fetchJSON<MwPageImagesResponse>(url)
  const pages = data?.query?.pages
  if (!pages) return null
  const page = Object.values(pages)[0]
  if (!page || page.pageid === undefined) return null
  return page.thumbnail?.source ?? null
}

// ── Source 2: Wikimedia Commons file search ───────────────────────────────────
interface MwSearchResponse {
  query?: {
    search?: Array<{ title: string }>
    pages?: Record<string, {
      imageinfo?: Array<{ url: string; thumburl?: string; width: number; height: number }>
    }>
  }
}

// Only accept raster image formats — skip SVG, TIFF, OGG, PDF, etc.
function isRasterImageUrl(url: string): boolean {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? ""
  return ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)
}

async function tryCommonsSearch(term: string): Promise<string | null> {
  const searchUrl =
    `https://commons.wikimedia.org/w/api.php` +
    `?action=query&list=search&srnamespace=6&srsearch=${encodeURIComponent(term)}&srlimit=10&format=json&origin=*`
  const searchData = await fetchJSON<MwSearchResponse>(searchUrl)
  const hits = searchData?.query?.search
  if (!hits || hits.length === 0) return null

  // Try each hit until we find a raster image
  for (const hit of hits) {
    if (!isRasterImageUrl(hit.title)) continue
    const fileTitle = encodeURIComponent(hit.title)
    const infoUrl =
      `https://commons.wikimedia.org/w/api.php` +
      `?action=query&titles=${fileTitle}&prop=imageinfo&iiprop=url|size&iiurlwidth=1400&format=json&origin=*`
    const infoData = await fetchJSON<MwSearchResponse>(infoUrl)
    const page = Object.values(infoData?.query?.pages ?? {})[0]
    const info = page?.imageinfo?.[0]
    const url = info?.thumburl ?? info?.url
    if (url && isRasterImageUrl(url)) return url
  }
  return null
}

// ── Source 3: Wikimedia Commons category crawl ────────────────────────────────
interface MwCategoryResponse {
  query?: {
    categorymembers?: Array<{ title: string }>
    pages?: Record<string, {
      imageinfo?: Array<{ url: string; thumburl?: string }>
    }>
  }
}

async function tryCommonsCategory(latinName: string): Promise<string | null> {
  const catTitle = encodeURIComponent(`Category:${latinName}`)
  const listUrl =
    `https://commons.wikimedia.org/w/api.php` +
    `?action=query&list=categorymembers&cmtitle=${catTitle}&cmtype=file&cmlimit=10&format=json&origin=*`
  const listData = await fetchJSON<MwCategoryResponse>(listUrl)
  const members = listData?.query?.categorymembers
  if (!members || members.length === 0) return null

  // Try each member until a raster image is found
  for (const member of members) {
    if (!isRasterImageUrl(member.title)) continue
    const fileTitle = encodeURIComponent(member.title)
    const infoUrl =
      `https://commons.wikimedia.org/w/api.php` +
      `?action=query&titles=${fileTitle}&prop=imageinfo&iiprop=url|size&iiurlwidth=1400&format=json&origin=*`
    const infoData = await fetchJSON<MwCategoryResponse>(infoUrl)
    const page = Object.values(infoData?.query?.pages ?? {})[0]
    const info = page?.imageinfo?.[0]
    const url = info?.thumburl ?? info?.url
    if (url && isRasterImageUrl(url)) return url
  }
  return null
}

// ── Source 4: iNaturalist taxon API ──────────────────────────────────────────
async function tryINaturalist(latinName: string): Promise<string | null> {
  const taxonUrl =
    `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(latinName)}&rank=species,subspecies,variety&per_page=1`
  const taxonData = await fetchJSON<{
    results?: Array<{
      id: number
      default_photo?: { medium_url?: string; large_url?: string; square_url?: string }
    }>
  }>(taxonUrl)
  const taxon = taxonData?.results?.[0]
  if (!taxon) return null
  const photo = taxon.default_photo
  // large_url is highest quality; fall back to medium_url
  const url = photo?.large_url ?? photo?.medium_url
  if (!url) return null
  // iNaturalist URLs end in /large.jpeg or /medium.jpeg — always raster
  return url
}

// ── Source 5: GBIF (Global Biodiversity Information Facility) ─────────────────
async function tryGBIF(latinName: string): Promise<string | null> {
  // Step 1: find the species key
  const matchUrl =
    `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(latinName)}&strict=false`
  const matchData = await fetchJSON<{ usageKey?: number; confidence?: number }>(matchUrl)
  const key = matchData?.usageKey
  if (!key || (matchData.confidence ?? 0) < 70) return null

  // Step 2: find an occurrence with a photo
  const occUrl =
    `https://api.gbif.org/v1/occurrence/search?taxonKey=${key}&mediaType=StillImage&limit=5`
  const occData = await fetchJSON<{
    results?: Array<{
      media?: Array<{ type?: string; identifier?: string; references?: string }>
    }>
  }>(occUrl)
  if (!occData?.results) return null

  for (const occ of occData.results) {
    for (const media of occ.media ?? []) {
      if (media.type === "StillImage" && media.identifier) {
        const url = media.identifier
        if (isRasterImageUrl(url)) return url
      }
    }
  }
  return null
}

// ── Deep search orchestrator ───────────────────────────────────────────────────
async function findImageUrl(
  latinName: string,
  dutchName: string
): Promise<{ url: string; source: string } | null> {
  let url: string | null

  // 1. Wikipedia EN — Latin name
  url = await tryWikipediaPageImages(latinName, "en")
  await sleep(DELAY_MS)
  if (url) return { url, source: "wp-en" }

  // 2. Wikipedia NL — Dutch name
  url = await tryWikipediaPageImages(dutchName, "nl")
  await sleep(DELAY_MS)
  if (url) return { url, source: "wp-nl-dutch" }

  // 3. Wikipedia NL — Latin name
  url = await tryWikipediaPageImages(latinName, "nl")
  await sleep(DELAY_MS)
  if (url) return { url, source: "wp-nl-latin" }

  // 4. Commons file search — Latin name
  url = await tryCommonsSearch(latinName)
  await sleep(DELAY_MS)
  if (url) return { url, source: "commons-search" }

  // 5. Commons category — Latin name
  url = await tryCommonsCategory(latinName)
  await sleep(DELAY_MS)
  if (url) return { url, source: "commons-cat" }

  // 6. Commons file search — Dutch name (catches vernacular-named files)
  url = await tryCommonsSearch(dutchName)
  await sleep(DELAY_MS)
  if (url) return { url, source: "commons-search-dutch" }

  // 7. Commons category — genus only (e.g. "Cornus" when "Cornus alba" fails)
  const genus = latinName.split(" ")[0]
  if (genus && genus !== latinName) {
    url = await tryCommonsCategory(genus)
    await sleep(DELAY_MS)
    if (url) return { url, source: "commons-cat-genus" }
  }

  // 8. iNaturalist — broadest coverage, real field photos
  url = await tryINaturalist(latinName)
  await sleep(DELAY_MS)
  if (url) return { url, source: "inaturalist" }

  // 9. GBIF — massive biodiversity database with CC photos
  url = await tryGBIF(latinName)
  await sleep(DELAY_MS)
  if (url) return { url, source: "gbif" }

  return null
}

// ── Per-plant processor ───────────────────────────────────────────────────────
type Status = "ok" | "skip" | "no-image" | "error"

async function processPlant(plant: {
  id: number
  latinName: string
  dutchName: string
  slug: string
  hasPhoto: boolean
}): Promise<{ slug: string; status: Status; source?: string }> {
  const filename = `${plant.slug}.jpg`
  const outputPath = join(PHOTOS_DIR, filename)

  // --no-disk: force re-try even if file exists on disk (useful when prev run succeeded in the DB but image is wrong)
  if (SKIP_EXISTING && !NO_DISK_MODE && existsSync(outputPath)) {
    return { slug: plant.slug, status: "skip" }
  }

  const found = await findImageUrl(plant.latinName, plant.dutchName)
  if (!found) return { slug: plant.slug, status: "no-image" }

  if (DEBUG_MODE) console.error(`    [URL] ${plant.slug} → [${found.source}] ${found.url.slice(0, 120)}`)
  const raw = await downloadBuffer(found.url)
  if (!raw) return { slug: plant.slug, status: "error" }

  const dims = await saveImage(raw, outputPath)
  if (!dims) return { slug: plant.slug, status: "error" }

  try {
    const existing = await db
      .select({ id: schema.plantPhotos.id })
      .from(schema.plantPhotos)
      .where(eq(schema.plantPhotos.plantId, plant.id))
      .limit(1)

    const payload = {
      plantId: plant.id,
      filename,
      altText: `${plant.dutchName} (${plant.latinName})`,
      sourceUrl: found.url,
      license: `Wikimedia Commons / iNaturalist — ${found.source}`,
      width: dims.width,
      height: dims.height,
    }

    if (existing.length === 0) {
      await db.insert(schema.plantPhotos).values(payload)
    } else {
      await db
        .update(schema.plantPhotos)
        .set(payload)
        .where(eq(schema.plantPhotos.id, existing[0].id))
    }
  } catch (err) {
    console.error(`  [DB] ${plant.slug}:`, err)
  }

  return { slug: plant.slug, status: "ok", source: found.source }
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const idx = i++
      await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(PHOTOS_DIR, { recursive: true })

  console.log("Fetching plant list from DB…")

  const rows = await db
    .select({
      id: schema.plants.id,
      latinName: schema.plants.latinName,
      dutchName: schema.plants.dutchName,
      slug: schema.plants.slug,
      photoId: schema.plantPhotos.id,
    })
    .from(schema.plants)
    .leftJoin(schema.plantPhotos, eq(schema.plantPhotos.plantId, schema.plants.id))
    .orderBy(schema.plants.id)

  let plants = rows.map((r) => ({
    id: r.id,
    latinName: r.latinName,
    dutchName: r.dutchName,
    slug: r.slug,
    hasPhoto: r.photoId !== null,
  }))

  if (ONLY_MISSING) {
    const before = plants.length
    plants = plants.filter((p) => !p.hasPhoto)
    console.log(`--only-missing: ${before - plants.length} with photos skipped, ${plants.length} remaining`)
  }

  if (isFinite(LIMIT)) plants = plants.slice(0, LIMIT)

  const total = plants.length
  console.log(
    `Processing ${total} plants  |  concurrency=${CONCURRENCY}  |  skip_existing=${SKIP_EXISTING}\n` +
    `Chain: WP-EN -> WP-NL-Dutch -> WP-NL-Latin -> Commons-search -> Commons-cat -> Commons-Dutch -> Commons-genus -> iNaturalist -> GBIF\n`
  )

  const stats = { ok: 0, skip: 0, noImage: 0, error: 0 }
  const sourceCounts: Record<string, number> = {}

  await pool(plants, CONCURRENCY, async (plant, idx) => {
    const result = await processPlant(plant)
    const pct = (((idx + 1) / total) * 100).toFixed(1).padStart(5)
    const n = String(idx + 1).padStart(4)

    if (result.status === "ok") {
      stats.ok++
      if (result.source) sourceCounts[result.source] = (sourceCounts[result.source] ?? 0) + 1
      console.log(`[${pct}%] ${n}/${total}  v  ${result.slug}  [${result.source}]`)
    } else if (result.status === "skip") {
      stats.skip++
    } else if (result.status === "no-image") {
      stats.noImage++
      console.log(`[${pct}%] ${n}/${total}  x  ${result.slug}`)
    } else {
      stats.error++
      console.log(`[${pct}%] ${n}/${total}  !  ${result.slug}`)
    }
  })

  console.log("\n── Summary ────────────────────────────────────────────────")
  console.log(`  Downloaded  : ${stats.ok}`)
  console.log(`  Skipped     : ${stats.skip}  (already on disk)`)
  console.log(`  Not found   : ${stats.noImage}`)
  console.log(`  Errors      : ${stats.error}`)
  if (Object.keys(sourceCounts).length > 0) {
    console.log("\n  Source breakdown:")
    Object.entries(sourceCounts)
      .sort(([, a], [, b]) => b - a)
      .forEach(([src, n]) => console.log(`    ${src.padEnd(30)} ${n}`))
  }
  console.log("────────────────────────────────────────────────────────────")
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})