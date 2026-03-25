import { config } from "dotenv"
import { readFileSync } from "fs"
import { join } from "path"
import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"
import { plants } from "../src/db/schema"
import { slugify } from "../src/lib/slug"
import * as schema from "../src/db/schema"

config({ path: ".env.local" })

const sql = neon(process.env.DATABASE_URL!)
const db = drizzle(sql, { schema })

interface PlantRow {
  latinName: string
  dutchName: string
  voorkomen: string | null
  pollenColor: string | null
  nectarValue: number | null
  pollenValue: number | null
  bloomStart: number | null
  bloomEnd: number | null
  slug: string
}

/**
 * Parse "N 3" -> 3, "N -" -> null, "-" -> null
 */
function parseValue(raw: string, prefix: string): number | null {
  const cleaned = raw.replace(prefix, "").trim()
  if (cleaned === "-" || cleaned === "?" || cleaned === "") return null
  const num = parseInt(cleaned, 10)
  return isNaN(num) ? null : num
}

/**
 * Parse month string: "8" -> 8, "-" -> null
 */
function parseMonth(raw: string): number | null {
  const cleaned = raw.trim()
  if (cleaned === "-" || cleaned === "?" || cleaned === "") return null
  const num = parseInt(cleaned, 10)
  if (isNaN(num) || num < 1 || num > 12) return null
  return num
}

/**
 * Strip HTML tags from a string.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim()
}

/**
 * Parse pollen color: "?" -> null, "-" -> null
 */
function parsePollenColor(raw: string): string | null {
  const cleaned = raw.trim()
  if (cleaned === "?" || cleaned === "-" || cleaned === "") return null
  return cleaned
}

/**
 * Parse voorkomen: normalise and return
 */
function parseVoorkomen(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === "" || cleaned === "?") return null
  return cleaned
}

/**
 * Extract all <tr>...</tr> blocks that contain <td>, i.e. data rows.
 */
function extractRows(html: string): string[] {
  const rows: string[] = []
  const trRegex = /<tr>([\s\S]*?)<\/tr>/gi
  let match: RegExpExecArray | null

  while ((match = trRegex.exec(html)) !== null) {
    const rowContent = match[1]
    // Skip header rows (contain <th>)
    if (rowContent.includes("<th")) continue
    // Only include rows with <td>
    if (rowContent.includes("<td>") || rowContent.includes("<td ")) {
      rows.push(rowContent)
    }
  }

  return rows
}

/**
 * Extract cell values from a row's HTML content.
 * Returns array of text content for each <td>.
 */
function extractCells(rowHtml: string): string[] {
  const cells: string[] = []
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
  let match: RegExpExecArray | null

  while ((match = tdRegex.exec(rowHtml)) !== null) {
    cells.push(stripTags(match[1]).trim())
  }

  return cells
}

function parseRow(rowHtml: string): PlantRow | null {
  const cells = extractCells(rowHtml)

  if (cells.length < 8) return null

  const latinName = cells[0]
  const dutchName = cells[1]

  if (!latinName || !dutchName) return null
  if (latinName.length < 2 || dutchName.length < 1) return null

  const slug = slugify(latinName)
  if (!slug) return null

  return {
    latinName,
    dutchName,
    voorkomen: parseVoorkomen(cells[2]),
    pollenColor: parsePollenColor(cells[3]),
    nectarValue: parseValue(cells[4], "N"),
    pollenValue: parseValue(cells[5], "P"),
    bloomStart: parseMonth(cells[6]),
    bloomEnd: parseMonth(cells[7]),
    slug,
  }
}

async function main() {
  const htmlPath = join(process.cwd(), ".docs", "dracht.html")
  console.warn(`Reading HTML from: ${htmlPath}`)

  const html = readFileSync(htmlPath, "utf-8")
  console.warn(`HTML file size: ${html.length} characters`)

  const rows = extractRows(html)
  console.warn(`Found ${rows.length} data rows`)

  const plants_data: PlantRow[] = []
  let skipped = 0

  for (const row of rows) {
    const parsed = parseRow(row)
    if (parsed) {
      plants_data.push(parsed)
    } else {
      skipped++
    }
  }

  console.warn(`Parsed: ${plants_data.length} plants, skipped: ${skipped}`)

  // Insert in batches of 100 for performance
  const BATCH_SIZE = 100
  let inserted = 0
  let conflicts = 0

  for (let i = 0; i < plants_data.length; i += BATCH_SIZE) {
    const batch = plants_data.slice(i, i + BATCH_SIZE)
    const result = await db
      .insert(plants)
      .values(
        batch.map((p) => ({
          latinName: p.latinName,
          dutchName: p.dutchName,
          voorkomen: p.voorkomen,
          pollenColor: p.pollenColor,
          nectarValue: p.nectarValue,
          pollenValue: p.pollenValue,
          bloomStart: p.bloomStart,
          bloomEnd: p.bloomEnd,
          slug: p.slug,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: plants.id })

    inserted += result.length
    conflicts += batch.length - result.length
    console.warn(
      `Batch ${Math.floor(i / BATCH_SIZE) + 1}: inserted ${result.length}, conflicts ${batch.length - result.length}`,
    )
  }

  console.warn(`\nDone! Total inserted: ${inserted}, conflicts (already existing): ${conflicts}`)
}

main().catch((err) => {
  console.error("Seed failed:", err)
  process.exit(1)
})
