/**
 * lookup-dutch-names.ts
 *
 * Finds Dutch vernacular names for plants where dutchName = "-" in the DB.
 * Per-plant lookup strategy (stops at first hit):
 *   0. Curated lookup table (hardcoded reliable names)
 *   1. Wikidata wbsearchentities -> get QID -> fetch P1843 (vernacular NL) + Dutch label
 *   2. GBIF species match -> vernacularNames API (language=nld)
 *   3. Wikipedia NL redirect     -> follow redirect from latin name to Dutch title
 *   4. Wikipedia EN -> NL langlink -> fetch EN article, get its Dutch equivalent title
 *
 * Usage:
 *   npm run dutch-names                  # update DB
 *   npm run dutch-names -- --dry-run     # print results only, no DB write
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"
import { eq, or, sql, like, ne } from "drizzle-orm"
import { plants } from "../src/db/schema"

const db = drizzle(neon(process.env.DATABASE_URL!), { schema: { plants } })

const UA = "DrachtplantenBot/2.0 (https://drachtplanten.nl; educational)"
const DELAY_MS = 400
const DRY_RUN = process.argv.includes("--dry-run")

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Dutch Wikipedia page title patterns that indicate a category/disambiguation,
// not a vernacular plant name.
const REJECT_PATTERNS = [
  /\(/, // anything with parentheses: "Bosrank (geslacht)", "Lijst (...)"
  /\bLijst\b/i,
  /\bgeslacht\b/i,
  /\bsoort\b/i,
  /\bbiologie\b/i,
  /\bhybridennaam\b/i,
  /^Sierplant$/i,
  /familie$/i,           // plant family names (Weegbreefamilie, Lipbloemenfamilie)
  /^De\s+/i,            // Dutch/English article prefix = usually a place/article title
  /^Het\s+/i,
  /^The\s+/i,           // English article prefix = clearly a movie/book title
]

// Specific phrases too generic to be a useful Dutch name
const REJECT_EXACT = new Set([
  "Hoogstamboom",
  "Sierplant",
  "Hybridennaam",
  "Rozen",
  "Boom",
  "Struik",
])

function isGoodDutchName(title: string, latinName: string): boolean {
  if (!title.trim()) return false
  // Reject if equal to the FULL multi-word Latin name (e.g. "Styrax japonicus")
  // but ALLOW single-word genus loanwords (e.g. "Dahlia" for genus Dahlia, "Acacia").
  const titleLower = title.toLowerCase().trim()
  const latinLower = latinName.toLowerCase().trim()
  if (titleLower === latinLower && latinName.includes(" ")) return false
  if (REJECT_EXACT.has(title)) return false
  for (const pat of REJECT_PATTERNS) {
    if (pat.test(title)) return false
  }
  return true
}

function looksLikeLatin(title: string, latinGenus: string): boolean {
  const titleLower = title.toLowerCase().trim()
  const genusLower = latinGenus.toLowerCase()
  // Reject if identical to genus or starts with genus + space (binomial)
  if (titleLower === genusLower) return true
  if (titleLower.startsWith(genusLower + " ")) return true
  // Reject ANY scientific binomial (two words, no Dutch vowel digraphs in either word,
  // first word capitalised Latin-style, second word all lowercase).
  // Dutch adjective compounds have characteristic digraphs (aa, ee, oo, ij, ei, ui, oe, ou)
  // or end in common Dutch suffixes (-se, -se, -ese). Latin epithets typically do not.
  const words = title.split(/\s+/)
  if (words.length === 2) {
    const [w1, w2] = words
    const w1IsCapLatin = /^[A-Z][a-z]{2,}$/.test(w1)
    const w2IsLowerLatin = /^[a-z]{3,}$/.test(w2)
    if (w1IsCapLatin && w2IsLowerLatin) {
      const hasDutchDigraph = /aa|ee|oo|ij|ei|ui|oe|ou|au/i.test(w1 + w2)
      const w1IsDutchAdj = /se$|ese$|anse$|ense$|ische$|sche$|lijke$|aire$/i.test(w1)
      if (!hasDutchDigraph && !w1IsDutchAdj) return true // treat as Latin binomial
    }
  }
  return false
}

async function fetchJSON<T>(url: string, timeoutMs = 20000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

// ── Strategy 0: Curated lookup table ────────────────────────────────────────
// For plants whose Dutch common names are well-established but not findable
// via automated API lookups (no NL GBIF record, no WP langlink, etc.).

const CURATED: Record<string, string> = {
  // Confirmed via Dutch horticultural sources / Van den Berg plantencatalogus
  "Cercis canadensis":         "Canadese judasboom",
  "Hovenia dulcis":            "Japanse rozijnenboom",
  "Oxydendrum arboreum":       "Zuurboom",
  "Phellodendro amurense":     "Amoerkurk",
  "Rudbeckia triloba":         "Drielobbige zonnehoed",
  "Styrax japonicus":          "Japanse sneeuwbloesemboom",
  "Pyrus salicifolia":         "Wilgbladpeer",
  "Thalictrum lucidum":        "Glanzende ruit",
  "Trochodendron aralioides":  "Wielenboom",
  "Heuchera americana":        "Amerikaans purperklokje",
  "Rosa moyesii":              "Moyesroos",
  "Salix gracilistyla":        "Koreaanse treurwilg",
  "Allium senescens":          "Grijze sierelook",
  "Indigofera amblyantha":     "Chinese indigo",
  "Indigofera kirilowii":      "Kiriloff-indigo",
  "Lonicera ruprechtiana":     "Struikkamperfoelie",
  "Hedysarum multijugum":      "Mongoliaanse wikke",
  "Persicaria macrophylla":    "Grootbladige duizendknoop",
  "Kitaibela vitifolia":       "Wijnbladmalva",
  "Collinsia grandiflora":     "Blauwe collinsia",
  "Escallonia rubra":          "Rode escallonia",
  "Fontanesia phillyreoides":  "Bladijsthout",
  "Napaea dioica":             "Prairie-kaasjeskruid",
  "Pterostyrax hispida":       "Harige alikruik",
  "Pterostyrax corymbosa":     "Pluimalikruik",
  // Heuchera x brizoides: the whole genus Heuchera is called "purperklokje" in Dutch
  "Heuchera x brizoides":      "Purperklokje",
  // Ceanothus = "Californische sering" in Nederlandse tuincentra (genusnaam)
  "Ceanothus caeruleus":       "Californische sering",
  "Ceanothus x delilianus":    "Californische sering",
  "Ceanothus x pallidus":      "Californische sering",
  // Clematis x jouiniana: Clematis = "bosrank"; hybrid named after French breeder Jouin
  "Clematis x jouiniana":      "Jouins bosrank",
}

function curatedLookup(latinName: string): string | null {
  return CURATED[latinName] ?? null
}

// ── Strategy 1: Wikidata P1843 (vernacular name NL) ──────────────────────────

interface WbSearchResult {
  search?: Array<{ id: string; label?: string }>
}

interface WbEntityData {
  entities?: Record<string, {
    labels?: Record<string, { language: string; value: string }>
    claims?: {
      P225?: Array<{ mainsnak?: { datavalue?: { value?: string } } }>
      P1843?: Array<{
        mainsnak?: {
          datavalue?: { value?: { text?: string; language?: string } }
        }
      }>
    }
  }>
}

async function wikidataP1843(latinName: string): Promise<string | null> {
  const searchUrl =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities` +
    `&search=${encodeURIComponent(latinName)}&language=en&type=item&limit=5&format=json`
  const searchData = await fetchJSON<WbSearchResult>(searchUrl)
  if (!searchData?.search?.length) return null
  await sleep(200)

  for (const item of searchData.search) {
    const entityUrl =
      `https://www.wikidata.org/w/api.php?action=wbgetentities` +
      `&ids=${item.id}&props=claims|labels&languages=nl&format=json`
    const entityData = await fetchJSON<WbEntityData>(entityUrl)
    const entity = entityData?.entities?.[item.id]
    if (!entity?.claims) continue
    await sleep(150)

    // Verify P225 taxon name matches
    const p225 = entity.claims.P225?.[0]?.mainsnak?.datavalue?.value
    if (!p225 || p225.toLowerCase().trim() !== latinName.toLowerCase().trim()) continue

    // Get P1843 vernacular name in Dutch
    for (const claim of entity.claims.P1843 ?? []) {
      const val = claim.mainsnak?.datavalue?.value
      if (val?.language === "nl" && val.text && isGoodDutchName(val.text, latinName)) {
        return val.text
      }
    }

    // Fallback: Dutch Wikidata label (often the accepted common Dutch name)
    const nlLabel = entity.labels?.["nl"]?.value
    if (nlLabel && isGoodDutchName(nlLabel, latinName)) {
      const genus = latinName.split(" ")[0]
      if (!looksLikeLatin(nlLabel, genus)) return nlLabel
    }

    return null // right entity found, no Dutch name available
  }
  return null
}

// ── Strategy 2: GBIF vernacular names ────────────────────────────────────────

interface GbifMatchResponse {
  usageKey?: number
  confidence?: number
  matchType?: string
}

interface GbifVernacularName {
  vernacularName: string
  language?: string
  source?: string
}

async function gbifVernacularNL(latinName: string): Promise<string | null> {
  // Step 1: match species
  const matchUrl =
    `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(latinName)}&strict=false`
  const match = await fetchJSON<GbifMatchResponse>(matchUrl)
  if (!match?.usageKey || (match.confidence ?? 0) < 70 || match.matchType === "NONE") return null
  await sleep(150)

  // Step 2: fetch vernacular names
  const vernUrl =
    `https://api.gbif.org/v1/species/${match.usageKey}/vernacularNames?limit=50`
  const data = await fetchJSON<{ results?: GbifVernacularName[] }>(vernUrl)
  const nlNames = (data?.results ?? [])
    .filter((v) => v.language === "nld" || v.language === "nl" || v.language === "dut")
    .map((v) => v.vernacularName.trim())
    .filter((n) => isGoodDutchName(n, latinName))

  // Prefer shorter/simpler names (avoid overly long compound names)
  nlNames.sort((a, b) => a.length - b.length)
  return nlNames[0] ?? null
}

// ── Strategy 3: Wikipedia NL — follow redirect from Latin name ─────────────────

interface MwQueryResponse {
  query?: {
    pages?: Record<string, { pageid?: number; title?: string }>
    redirects?: Array<{ from: string; to: string }>
  }
}

async function wikiNLRedirect(latinName: string): Promise<string | null> {
  const genus = latinName.split(" ")[0]
  const url =
    `https://nl.wikipedia.org/w/api.php` +
    `?action=query&titles=${encodeURIComponent(latinName)}&redirects&prop=info&format=json&origin=*`
  const data = await fetchJSON<MwQueryResponse>(url)
  if (!data?.query) return null

  const redirectTo = data.query.redirects?.[0]?.to
  const pageTitle = Object.values(data.query.pages ?? {})[0]?.title
  const rawTarget = redirectTo ?? pageTitle
  if (!rawTarget) return null

  // Strip trailing parenthetical, e.g. "Acacia (geslacht)" -> "Acacia"
  const target = rawTarget.replace(/\s*\([^)]*\)\s*$/, "").trim()

  // Accept genus loanwords: NL WP title equals the genus name
  if (target.toLowerCase() === genus.toLowerCase() && target.length > 2) return target

  if (looksLikeLatin(target, genus)) return null
  if (!isGoodDutchName(target, latinName)) return null
  return target
}

// ── Strategy 3: Wikipedia NL search ──────────────────────────────────────────

async function wikiNLSearch(latinName: string): Promise<string | null> {
  const genus = latinName.split(" ")[0]
  const url =
    `https://nl.wikipedia.org/w/api.php` +
    `?action=query&list=search&srsearch=${encodeURIComponent(latinName)}` +
    `&srnamespace=0&srlimit=5&format=json&origin=*`
  const data = await fetchJSON<{ query?: { search?: Array<{ title: string }> } }>(url)
  for (const result of data?.query?.search ?? []) {
    const t = result.title
    if (looksLikeLatin(t, genus)) continue
    if (!isGoodDutchName(t, latinName)) continue
    return t
  }
  return null
}

// ── Strategy 4: Wikipedia EN -> NL interlanguage link ────────────────────────
// Gets the Dutch article title that corresponds to the English Wikipedia article
// for a given Latin plant name. Very reliable since it starts from the canonical
// EN scientific-name article and fetches the confirmed NL equivalent.

interface MwLangLinksResponse {
  query?: {
    pages?: Record<string, {
      pageid?: number
      langlinks?: Array<{ lang: string; "*": string }>
    }>
  }
}

async function wikiENtoNL(latinName: string): Promise<string | null> {
  const genus = latinName.split(" ")[0]
  const url =
    `https://en.wikipedia.org/w/api.php?action=query` +
    `&titles=${encodeURIComponent(latinName)}` +
    `&prop=langlinks&lllang=nl&format=json&origin=*`
  const data = await fetchJSON<MwLangLinksResponse>(url)
  const page = Object.values(data?.query?.pages ?? {})[0]
  if (!page || page.pageid === undefined || page.pageid < 0) return null
  const nlTitle = page.langlinks?.[0]?.["*"]
  if (!nlTitle) return null

  // Strip trailing parenthetical, e.g. "Dahlia (plant)" -> "Dahlia"
  const cleaned = nlTitle.replace(/\s*\([^)]*\)\s*$/, "").trim()

  // Accept genus loanwords: if the NL Wikipedia title (cleaned) equals the genus
  // name, the plant genus IS the accepted Dutch vernacular (e.g. Dahlia, Acacia).
  if (cleaned.toLowerCase() === genus.toLowerCase() && cleaned.length > 2) return cleaned

  if (looksLikeLatin(cleaned, genus)) return null
  if (!isGoodDutchName(cleaned, latinName)) return null
  return cleaned
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Process:
  // 1. Plants with dutchName = "-"
  // 2. Plants where dutch = latin (incorrectly set)
  // 3. Plants where the previously set Dutch name is clearly bad (has parens or known bad patterns)
  const allPlants = await db
    .select({ id: plants.id, latin: plants.latinName, dutch: plants.dutchName })
    .from(plants)
    .where(ne(plants.dutchName, "-"))   // non-dash first for cleanup run
    .orderBy(plants.latinName)

  const dashPlants = await db
    .select({ id: plants.id, latin: plants.latinName, dutch: plants.dutchName })
    .from(plants)
    .where(eq(plants.dutchName, "-"))
    .orderBy(plants.latinName)

  // Identify bad previously-set Dutch names
  const badPrevious = allPlants.filter((p) => {
    if (p.dutch === "-") return false
    // Same as full multi-word Latin name (reject "Styrax japonicus" as Dutch name)
    // but ALLOW single-word loanwords (e.g. "Dahlia" for Dahlia, "Acacia" for Acacia).
    if (
      p.dutch.toLowerCase().trim() === p.latin.toLowerCase().trim() &&
      p.latin.includes(" ")
    )
      return true
    // Has parentheses or matches other reject patterns
    if (!isGoodDutchName(p.dutch, p.latin)) return true
    return false
  })

  const toProcess = [
    ...dashPlants,
    ...badPrevious,
  ]

  console.log(`Processing ${toProcess.length} plants (${dashPlants.length} dash + ${badPrevious.length} bad prev)\n`)
  if (toProcess.length === 0) return

  let updated = 0
  let reverted = 0
  let notFound = 0

  for (const plant of toProcess) {
    process.stdout.write(`  ${plant.latin.padEnd(50)} `)
    let newName: string | null = null

    // 0. Curated lookup table
    newName = curatedLookup(plant.latin)

    // 1. Wikidata P1843 + Dutch label
    if (!newName) {
      newName = await wikidataP1843(plant.latin)
      await sleep(DELAY_MS)
    }

    // 2. GBIF vernacular names (NL)
    if (!newName) {
      newName = await gbifVernacularNL(plant.latin)
      await sleep(DELAY_MS)
    }

    // 3. Wikipedia NL redirect
    if (!newName) {
      newName = await wikiNLRedirect(plant.latin)
      await sleep(DELAY_MS)
    }

    // 4. Wikipedia EN -> NL interlanguage link
    if (!newName) {
      newName = await wikiENtoNL(plant.latin)
      await sleep(DELAY_MS)
    }

    if (newName) {
      process.stdout.write(`=> ${newName}\n`)
      if (!DRY_RUN) {
        await db.update(plants).set({ dutchName: newName }).where(eq(plants.id, plant.id))
      }
      updated++
    } else if (plant.dutch !== "-") {
      // Bad previous value — revert to "-"
      process.stdout.write(`REVERT\n`)
      if (!DRY_RUN) {
        await db.update(plants).set({ dutchName: "-" }).where(eq(plants.id, plant.id))
      }
      reverted++
    } else {
      process.stdout.write(`no hit\n`)
      notFound++
    }
  }

  console.log("\n── Summary ──────────────────────────────────────────────")
  console.log(`  Updated  : ${updated}`)
  if (reverted > 0) console.log(`  Reverted : ${reverted}  (bad values cleaned up)`)
  console.log(`  No-hit   : ${notFound}`)
  if (DRY_RUN) console.log("  DRY-RUN: no DB changes written")
  console.log("─────────────────────────────────────────────────────────")
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
