/**
 * enrich-care.ts
 *
 * Generates four Dutch AI text blocks per plant and stores them in:
 *   wild_bee_text, honey_bee_text, cultivation_text, care_text
 *
 * Usage:
 *   npm run care                        # all plants without care text
 *   npm run care -- --force             # re-generate everything
 *   npm run care -- --limit 20          # max 20 plants
 *   npm run care -- --slug klimop       # single plant by slug
 *   npm run care -- --dry-run           # print prompts, no DB write
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import OpenAI from "openai"
import { neon } from "@neondatabase/serverless"

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN   = args.includes("--dry-run")
const FORCE     = args.includes("--force")
const limit_i   = args.indexOf("--limit")
const LIMIT     = limit_i !== -1 ? parseInt(args[limit_i + 1], 10) : Infinity
const slug_i    = args.indexOf("--slug")
const ONLY_SLUG = slug_i !== -1 ? args[slug_i + 1] : null

// ── Clients ───────────────────────────────────────────────────────────────────
const sql    = neon(process.env.DATABASE_URL!)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Month names ───────────────────────────────────────────────────────────────
const MONTHS = [
  "", "januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december",
]
function bloomLabel(start: number | null, end: number | null): string {
  if (!start || !end) return "onbekend"
  return `${MONTHS[start]} t/m ${MONTHS[end]}`
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `\
Je bent een expert in Nederlandse tuinbouw, plantkunde en bijenhouderij.
Voor elke plant die je krijgt schrijf je vier informatieve teksten in het Nederlands.
Geef altijd een geldig JSON-object terug met EXACT deze vier sleutels:

"wildBeeText"
  2-3 alinea's over de relatie tussen de plant en WILDE bijen: solitaire bijen,
  hommels en zweefvliegen. Noem concrete soorten als die bekend zijn als bezoekers
  van deze plant. Als soortspecifieke informatie ontbreekt, schrijf dan een algemene
  tekst over de ecologische waarde voor wilde bestuivers.

"honeyBeeText"
  2-3 alinea's over de relatie tussen de plant en de HONINGBIJ (Apis mellifera).
  Beschrijf de nectar- en pollenwaarde, de vluchttijden van de bij op de plant,
  stuifmeelkleur en praktische tips voor imkers. Als er geen imkerspecifieke data
  beschikbaar is, generaliseer dan op basis van de bloeiperiode en waarden.

"cultivationText"
  2-3 alinea's over hoe je de plant kweekt of teelt: bodemtype en pH, lichtbehoefte
  (volle zon / halfschaduw / schaduw), waterbehoeften, beste planttijd, vermeerdering
  (zaad / stek / scheuren), groeivorm (eenjarig / tweejarig / meerjarig / houtig) en
  eventuele bijzonderheden zoals winterhardheid of standplaatsbehoefte.

"careText"
  2-3 alinea's over de dagelijkse verzorging: welke meststof (organisch / mineraal)
  en wanneer bemesten, wanneer en hoe vaak watergeven, en snoeien (wanneer snoeien,
  hoe zwaar terugzetten, of juist waarom NIET snoeien). Wees concreet in maandaanduidingen.

Schrijf in actieve, heldere zinnen. Geen markdown, geen koppen, geen opsommingstekens.
Elke waarde bevat alleen lopende alinea's, gescheiden door \\n\\n.`

// ── Plant row type ────────────────────────────────────────────────────────────
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
  bee_text: string | null
}

// ── AI response type ──────────────────────────────────────────────────────────
interface CareResponse {
  wildBeeText: string
  honeyBeeText: string
  cultivationText: string
  careText: string
}

// ── Build user prompt ─────────────────────────────────────────────────────────
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
  if (p.description)
    lines.push(`Beschrijving: ${p.description.slice(0, 600)}`)
  if (p.bee_text)
    lines.push(`Bestaande bijentekst (ter referentie): ${p.bee_text.slice(0, 400)}`)
  lines.push("")
  lines.push(
    "Schrijf nu de vier teksten als JSON-object met de sleutels " +
    "wildBeeText, honeyBeeText, cultivationText en careText."
  )
  return lines.join("\n")
}

// ── Validate AI response ──────────────────────────────────────────────────────
function parseResponse(raw: string): CareResponse | null {
  try {
    const obj = JSON.parse(raw)
    if (
      typeof obj.wildBeeText    === "string" && obj.wildBeeText.length > 20 &&
      typeof obj.honeyBeeText   === "string" && obj.honeyBeeText.length > 20 &&
      typeof obj.cultivationText === "string" && obj.cultivationText.length > 20 &&
      typeof obj.careText       === "string" && obj.careText.length > 20
    ) {
      return obj as CareResponse
    }
    return null
  } catch {
    return null
  }
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Progress bar helper ────────────────────────────────────────────────────────
function progress(current: number, total: number): string {
  const pct  = Math.round((current / total) * 100)
  const bars = Math.round(pct / 2)
  const bar  = "[" + "#".repeat(bars) + "-".repeat(50 - bars) + "]"
  return `${bar} ${current}/${total} (${pct}%)`
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `enrich-care starting  dry-run=${DRY_RUN}  force=${FORCE}  ` +
    `limit=${Number.isFinite(LIMIT) ? LIMIT : "all"}  slug=${ONLY_SLUG ?? "all"}`
  )

  // ── Fetch rows to process ─────────────────────────────────────────────────
  let rows: PlantRow[]
  if (ONLY_SLUG) {
    rows = await sql`
      SELECT id, latin_name, dutch_name, family, voorkomen,
             nectar_value, pollen_value, pollen_color,
             bloom_start, bloom_end, description, bee_text
      FROM plants WHERE slug = ${ONLY_SLUG}
    ` as PlantRow[]
  } else if (FORCE) {
    rows = await sql`
      SELECT id, latin_name, dutch_name, family, voorkomen,
             nectar_value, pollen_value, pollen_color,
             bloom_start, bloom_end, description, bee_text
      FROM plants ORDER BY id
    ` as PlantRow[]
  } else {
    rows = await sql`
      SELECT id, latin_name, dutch_name, family, voorkomen,
             nectar_value, pollen_value, pollen_color,
             bloom_start, bloom_end, description, bee_text
      FROM plants
      WHERE care_text_generated_at IS NULL
      ORDER BY id
    ` as PlantRow[]
  }

  if (rows.length === 0) {
    console.log("Geen planten te verrijken. Gebruik --force om alles opnieuw te genereren.")
    return
  }

  const toProcess = Number.isFinite(LIMIT) ? rows.slice(0, LIMIT) : rows
  console.log(`${toProcess.length} plant(en) te verwerken...\n`)

  let ok = 0, failed = 0

  for (let idx = 0; idx < toProcess.length; idx++) {
    const plant = toProcess[idx]
    console.log(progress(idx, toProcess.length))
    console.log(`[${plant.id}] ${plant.dutch_name} (${plant.latin_name})`)

    const userPrompt = buildPrompt(plant)

    if (DRY_RUN) {
      console.log("--- PROMPT ---")
      console.log(userPrompt)
      console.log("--- (dry-run, geen API-aanroep) ---\n")
      continue
    }

    let parsed: CareResponse | null = null

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          response_format: { type: "json_object" },
          temperature: 0.7,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: userPrompt },
          ],
        })
        const raw = response.choices[0]?.message?.content ?? ""
        parsed = parseResponse(raw)
        if (parsed) break
        console.warn(`  Poging ${attempt}: ongeldig antwoord, opnieuw proberen...`)
      } catch (err) {
        console.error(`  Poging ${attempt} API-fout:`, err)
      }
      if (attempt < 2) await sleep(4000)
    }

    if (!parsed) {
      console.error(`  MISLUKT na 2 pogingen — plant ${plant.id} overgeslagen\n`)
      failed++
      continue
    }

    await sql`
      UPDATE plants SET
        wild_bee_text          = ${parsed.wildBeeText},
        honey_bee_text         = ${parsed.honeyBeeText},
        cultivation_text       = ${parsed.cultivationText},
        care_text              = ${parsed.careText},
        care_text_generated_at = NOW(),
        updated_at             = NOW()
      WHERE id = ${plant.id}
    `

    console.log(`  OK: wild_bee, honey_bee, cultivation, care opgeslagen.\n`)
    ok++

    // Respecteer OpenAI rate-limits
    await sleep(1200)
  }

  console.log(progress(toProcess.length, toProcess.length))
  console.log(`\nKlaar. OK=${ok}  Mislukt=${failed}  Overgeslagen(dry-run)=${DRY_RUN ? toProcess.length : 0}`)
}

main().catch((err) => {
  console.error("Fatale fout:", err)
  process.exit(1)
})
