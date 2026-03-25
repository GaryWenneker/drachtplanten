/**
 * enrich-plants.ts
 *
 * Generates AI-written Dutch prose about each plant and its value for bees.
 * Stores the result in plants.bee_text.
 *
 * Usage:
 *   npm run enrich                   # enrich all plants that have no bee_text
 *   npm run enrich -- --force        # re-generate even if bee_text exists
 *   npm run enrich -- --limit 20     # process at most 20 plants
 *   npm run enrich -- --slug knoflook # single plant by slug
 *   npm run enrich -- --dry-run      # print prompts, do NOT write to DB
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import OpenAI from "openai"
import { neon } from "@neondatabase/serverless"

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const FORCE = args.includes("--force")
const LIMIT_IDX = args.indexOf("--limit")
const LIMIT = LIMIT_IDX !== -1 ? parseInt(args[LIMIT_IDX + 1], 10) : Infinity
const SLUG_IDX = args.indexOf("--slug")
const ONLY_SLUG = SLUG_IDX !== -1 ? args[SLUG_IDX + 1] : null

// ── Clients ───────────────────────────────────────────────────────────────────
const sql = neon(process.env.DATABASE_URL!)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Month name helper ─────────────────────────────────────────────────────────
const MONTHS = [
  "", "januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december",
]

function bloomLabel(start: number | null, end: number | null): string {
  if (start == null || end == null) return "onbekend"
  return `${MONTHS[start]} t/m ${MONTHS[end]}`
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Je bent een expert in de Nederlandse bijenhouderij en plantkunde.
Schrijf voor elke drachtplant een informatieve, vlot leesbare tekst in het \
Nederlands (3 tot 5 alinea's) die beschrijft:
1. Hoe de plant eruitziet en waar hij in Nederland voorkomt.
2. Wat de plant de bij te bieden heeft: nectar- en pollenwaarde, \
stuifmeelkleur, wanneer hij bloeit.
3. Welke bijensoorten de plant bezoeken en waarom hij ecologisch \
waardevol is.
4. Praktische tips voor imkers en tuiniers.
Schrijf helder, concreet en in actieve zinnen. Geen opsommingen — alleen \
lopende alinea's. Geen markdown-opmaak. Geen koppen of opsommingstekens.`

// ── Build user prompt ─────────────────────────────────────────────────────────
interface PlantRow {
  id: number
  latin_name: string
  dutch_name: string
  family: string | null
  voorkomen: string | null
  nectar_value: number | null
  pollen_value: number | null
  pollen_color: string | null
  bloom_start: number | null
  bloom_end: number | null
  description: string | null
}

function buildPrompt(p: PlantRow): string {
  const lines = [
    `Plant: ${p.dutch_name} (${p.latin_name})`,
    `Familie: ${p.family ?? "onbekend"}`,
    `Voorkomen: ${p.voorkomen ?? "onbekend"}`,
    `Nectarwaarde: ${p.nectar_value != null ? `${p.nectar_value}/5` : "onbekend"}`,
    `Pollenwaarde: ${p.pollen_value != null ? `${p.pollen_value}/5` : "onbekend"}`,
    `Stuifmeelkleur: ${p.pollen_color ?? "onbekend"}`,
    `Bloeiperiode: ${bloomLabel(p.bloom_start, p.bloom_end)}`,
  ]
  if (p.description) lines.push(`Beschrijving: ${p.description}`)
  lines.push("")
  lines.push("Schrijf nu de informatieve tekst over deze plant en zijn waarde voor bijen.")
  return lines.join("\n")
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Enrich-plants starting (dry-run=${DRY_RUN}, force=${FORCE}, limit=${LIMIT}, slug=${ONLY_SLUG ?? "all"})`)

  // Fetch plants to enrich
  let rows: PlantRow[]
  if (ONLY_SLUG) {
    rows = await sql`
      SELECT id, latin_name, dutch_name, family, voorkomen,
             nectar_value, pollen_value, pollen_color,
             bloom_start, bloom_end, description
      FROM plants
      WHERE slug = ${ONLY_SLUG}
    ` as PlantRow[]
  } else if (FORCE) {
    rows = await sql`
      SELECT id, latin_name, dutch_name, family, voorkomen,
             nectar_value, pollen_value, pollen_color,
             bloom_start, bloom_end, description
      FROM plants
      ORDER BY dutch_name
    ` as PlantRow[]
  } else {
    rows = await sql`
      SELECT id, latin_name, dutch_name, family, voorkomen,
             nectar_value, pollen_value, pollen_color,
             bloom_start, bloom_end, description
      FROM plants
      WHERE bee_text IS NULL
      ORDER BY dutch_name
    ` as PlantRow[]
  }

  if (rows.length === 0) {
    console.log("No plants to enrich. All done!")
    return
  }

  const toProcess = rows.slice(0, isFinite(LIMIT) ? LIMIT : rows.length)
  console.log(`Processing ${toProcess.length} plants (${rows.length} total candidates).\n`)

  let done = 0
  let errors = 0

  for (const plant of toProcess) {
    const label = `[${done + 1}/${toProcess.length}] ${plant.dutch_name} (${plant.latin_name})`

    const prompt = buildPrompt(plant)

    if (DRY_RUN) {
      console.log(`== DRY-RUN: ${label} ==`)
      console.log(prompt)
      console.log()
      done++
      continue
    }

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 800,
      })

      const text = response.choices[0]?.message?.content?.trim() ?? ""
      if (!text) throw new Error("Empty response from OpenAI")

      await sql`
        UPDATE plants
        SET bee_text = ${text},
            bee_text_generated_at = now(),
            updated_at = now()
        WHERE id = ${plant.id}
      `

      console.log(`  OK  ${label}`)
      done++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ERR ${label}: ${msg}`)
      errors++
    }

    // Rate-limit: 1 req/s to stay within OpenAI tier
    await sleep(1100)
  }

  console.log(`\nDone. ${done} enriched, ${errors} errors.`)
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
