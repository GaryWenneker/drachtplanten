import { config } from "dotenv"
config({ path: ".env.local" })

import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

async function run() {
  console.log("Running migration: adding bee_text columns...")

  await sql`ALTER TABLE plants ADD COLUMN IF NOT EXISTS bee_text text`
  console.log("  [OK] bee_text")

  await sql`ALTER TABLE plants ADD COLUMN IF NOT EXISTS bee_text_generated_at timestamp`
  console.log("  [OK] bee_text_generated_at")

  const rows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'plants' AND column_name LIKE 'bee%'
    ORDER BY column_name
  `
  console.log("  Verified columns:", rows.map((r) => r.column_name).join(", "))
  console.log("Migration complete.")
}

run().catch((e) => {
  console.error("Migration failed:", e)
  process.exit(1)
})
