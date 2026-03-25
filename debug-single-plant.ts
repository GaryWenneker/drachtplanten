/**
 * debug-single-plant.ts — test downloading one plant from scratch
 * Usage: npx tsx scripts/debug-single-plant.ts "Campanula poscharskyana"
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import sharp from 'sharp'

const UA = 'DrachtplantenBot/2.0 (https://drachtplanten.nl; educational)'
const latinName = process.argv[2] ?? 'Campanula poscharskyana'
const dutchName = process.argv[3] ?? ''

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) { console.log(`  fetchJSON ${res.status} → ${url.slice(0, 100)}`); return null }
    return await res.json() as T
  } catch (e) {
    console.log(`  fetchJSON ERR → ${url.slice(0, 100)}: ${e}`)
    return null
  }
}

async function downloadTest(url: string): Promise<void> {
  console.log(`\nDownloading: ${url}`)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
    console.log(`  HTTP ${res.status} ${res.headers.get('content-type')} ${res.headers.get('content-length') ?? '?'} bytes`)
    if (!res.ok) return
    const buf = Buffer.from(await res.arrayBuffer())
    console.log(`  Buffer size: ${buf.length} bytes`)
    try {
      const meta = await sharp(buf).metadata()
      console.log(`  Sharp OK: ${meta.format} ${meta.width}x${meta.height}`)
    } catch (e) {
      console.log(`  Sharp FAILED: ${e}`)
    }
  } catch (e) {
    console.log(`  Fetch FAILED: ${e}`)
  }
}

// 1. Wikipedia EN pageimages
async function main() {
  const url1 = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(latinName)}&prop=pageimages&pithumbsize=1400&pilimit=1&format=json&origin=*`
  console.log(`\n=== Testing: "${latinName}" ===`)
  console.log(`\n[1] WP-EN pageimages API`)
  const data1 = await fetchJSON<any>(url1)
  const pages1 = data1?.query?.pages
  const page1 = pages1 ? Object.values(pages1)[0] as any : null
  const thumb1 = page1?.thumbnail?.source
  console.log(`  pageid: ${page1?.pageid}, thumbnail: ${thumb1 ?? 'none'}`)
  if (thumb1) await downloadTest(thumb1)

  // 2. WP NL (dutch name)
  if (dutchName && dutchName !== '-') {
    const url2 = `https://nl.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(dutchName)}&prop=pageimages&pithumbsize=1400&pilimit=1&format=json&origin=*`
    console.log(`\n[2] WP-NL Dutch name: "${dutchName}"`)
    const data2 = await fetchJSON<any>(url2)
    const page2 = data2?.query?.pages ? Object.values(data2.query.pages)[0] as any : null
    const thumb2 = page2?.thumbnail?.source
    console.log(`  pageid: ${page2?.pageid}, thumbnail: ${thumb2 ?? 'none'}`)
    if (thumb2) await downloadTest(thumb2)
  }

  // 3. Commons search
  const url3 = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&srsearch=${encodeURIComponent(latinName)}&srlimit=5&format=json&origin=*`
  console.log(`\n[3] Commons search: "${latinName}"`)
  const data3 = await fetchJSON<any>(url3)
  const hits3 = data3?.query?.search ?? []
  console.log(`  Hits: ${hits3.map((h: any) => h.title).join(' | ') || 'none'}`)

  // 4. iNaturalist
  const url4 = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(latinName)}&rank=species&per_page=1`
  console.log(`\n[4] iNaturalist`)
  const data4 = await fetchJSON<any>(url4)
  const taxon = data4?.results?.[0]
  const inatUrl = taxon?.default_photo?.large_url ?? taxon?.default_photo?.medium_url
  console.log(`  taxon: ${taxon?.name} (${taxon?.rank}), photo: ${inatUrl ?? 'none'}`)
  if (inatUrl) await downloadTest(inatUrl)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
