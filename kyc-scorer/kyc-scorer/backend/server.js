/**
 * KYC Address Confidence Scorer — Backend Server
 *
 * Endpoints:
 *   POST /api/detect-schema  — LLM maps spreadsheet columns to KYC schema
 *   POST /api/score-customer — LLM extracts facts, code calculates score
 *   POST /api/score-customers — Scores multiple customers with controlled concurrency
 */

const express  = require("express");
const cors     = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

require("dotenv").config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY environment variable is not set.");
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app    = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "10mb" }));

const MODEL = "claude-sonnet-4-20250514";
const TODAY = new Date().toISOString().split("T")[0];

// ── Concurrency limiter ───────────────────────────────────────────────────────

const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || "5", 10);

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve).catch(reject).finally(() => { active--; next(); });
  }
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

const limit = createLimiter(CONCURRENCY_LIMIT);

// ── Safe JSON parser ──────────────────────────────────────────────────────────

function safeParseJSON(text, context) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return { data: JSON.parse(cleaned), error: null };
  } catch {
    return {
      data: null,
      error: {
        code: "PARSE_ERROR",
        message: `The AI response for ${context} was not valid JSON. Please retry.`,
        raw: cleaned.slice(0, 300),
      },
    };
  }
}

// ── Deterministic score calculator ───────────────────────────────────────────
//
// Weights:
//   Recency      40 pts  — age of most recent verified address record
//   Verification 30 pts  — strongest verification method found
//   Consistency  20 pts  — address agreement across records
//   Source       10 pts  — best source quality present
//
// Traffic lights:  GREEN 75+ | AMBER 40–74 | RED <40

const RECENCY_SCORES = [
  { maxMonths:  12, score: 40 },
  { maxMonths:  24, score: 30 },
  { maxMonths:  36, score: 20 },
  { maxMonths:  60, score: 10 },
  { maxMonths: Infinity, score: 0 },
];

const VERIFICATION_SCORES = {
  document_verification: 30,
  passport:              28,
  usps_cass:             25,
  driving_licence:       22,
  utility_bill:          20,
  bank_statement:        18,
  branch:                15,
  app:                   10,
  call_centre:            8,
  self_declared:          5,
  none:                   0,
};

const SOURCE_SCORES = {
  document_verification: 10,
  branch:                 8,
  app:                    5,
  call_centre:            3,
  none:                   0,
};

function calculateScore(facts) {
  let recencyScore = 0;
  if (facts.most_recent_record_date) {
    const ageMonths = (Date.now() - new Date(facts.most_recent_record_date).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    recencyScore = RECENCY_SCORES.find(r => ageMonths <= r.maxMonths).score;
  }

  const verificationKey  = (facts.strongest_verification_method || "none").toLowerCase().replace(/\s+/g, "_");
  const verificationScore = VERIFICATION_SCORES[verificationKey] ?? 0;

  const consistencyScore =
    facts.address_conflict === false   ? 20 :
    facts.address_conflict === "minor" ? 12 :
    0;

  const sourceKey   = (facts.best_source || "none").toLowerCase().replace(/\s+/g, "_");
  const sourceScore = SOURCE_SCORES[sourceKey] ?? 0;

  const confidence_percentage = recencyScore + verificationScore + consistencyScore + sourceScore;

  const traffic_light =
    confidence_percentage >= 75 ? "GREEN" :
    confidence_percentage >= 40 ? "AMBER" :
    "RED";

  return { confidence_percentage, traffic_light, score_breakdown: { recencyScore, verificationScore, consistencyScore, sourceScore } };
}

// ── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Schema Detection ─────────────────────────────────────────────────────────

app.post("/api/detect-schema", async (req, res) => {
  const { sheetSamples } = req.body;
  if (!sheetSamples) return res.status(400).json({ error: "sheetSamples is required" });

  const prompt = `You are a data schema analyst. You are given sample data from a spreadsheet with unknown column names.

Analyse the ACTUAL DATA VALUES — not just the column names — and map each sheet/column to our standard KYC schema.

OUR STANDARD SCHEMA:
- identity: customer_id, full_name, date_of_birth, national_id_number, gender
- address: address_id, customer_id, address_line_1, address_line_2, city, postcode, country, address_source (how address was obtained: branch/app/call_centre/document_verification), recorded_by, date_recorded, date_superseded
- account: customer_id, account_open_date, last_interaction_date, last_interaction_channel, document_verification_status

SPREADSHEET DATA:
${JSON.stringify(sheetSamples, null, 2)}

Instructions:
1. Read the actual values to understand what each column represents
2. Map each sheet to identity/address/account (may not have all three)
3. Map each column to its schema field — or null if no match
4. Identify the customer identifier: the column whose values link all sheets together

Respond ONLY with this JSON, no other text:
{
  "id_column": "<actual column name that is the customer identifier>",
  "id_sheet": "<sheet name with identity data or null>",
  "address_sheet": "<sheet name with address history or null>",
  "account_sheet": "<sheet name with account data or null>",
  "column_mappings": {
    "<sheet_name>": { "<actual_column_name>": "<schema_field or null>" }
  },
  "reasoning": "<1-2 sentences on how you identified the mapping>"
}`;

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content.map(b => b.text || "").join("");
    const { data, error } = safeParseJSON(text, "schema detection");

    if (error) {
      console.error("Schema parse error:", error.raw);
      return res.status(502).json({ error: error.message, code: error.code });
    }

    res.json(data);
  } catch (err) {
    console.error("Schema detection error:", err.message);
    res.status(500).json({ error: "Schema detection failed: " + err.message });
  }
});

// ── Fact extraction system prompt ─────────────────────────────────────────────
//
// The LLM extracts structured facts only. calculateScore() handles all arithmetic.

const EXTRACTION_SYSTEM = `You are a KYC data analyst. Read the customer address records and extract key facts only.
Do not score or judge. Just report what the data shows.

TODAY: ${TODAY}

Respond ONLY with this JSON, no other text:
{
  "customer_id": "<id>",
  "full_name": "<name>",
  "most_recent_record_date": "<YYYY-MM-DD of the most recently dated address record, or null>",
  "strongest_verification_method": "<strongest method present: document_verification | passport | driving_licence | usps_cass | utility_bill | bank_statement | branch | app | call_centre | self_declared | none>",
  "address_conflict": <true if meaningfully different addresses exist (different street or city) | "minor" if only formatting or abbreviation differences | false if all records agree>,
  "best_source": "<best source present: document_verification | branch | app | call_centre | none>",
  "recommended_address": "<most credible full address based on recency and verification, or 'Insufficient data'>",
  "reasoning": "<2-4 sentence plain English explanation of what the data shows>",
  "positive_factors": ["<string>"],
  "negative_factors": ["<string>"],
  "missing_data_impact": ["<specific actionable recommendation>"]
}`;

// ── Shared scoring function ───────────────────────────────────────────────────

async function scoreCustomer(customerData) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: EXTRACTION_SYSTEM,
    messages: [{
      role: "user",
      content: `Extract facts from this customer's address records:\n\n${JSON.stringify(customerData, null, 2)}`,
    }],
  });

  const text = message.content.map(b => b.text || "").join("");
  const { data: facts, error } = safeParseJSON(text, `customer ${customerData?.customer_id || "unknown"}`);

  if (error) throw error;

  const { confidence_percentage, traffic_light, score_breakdown } = calculateScore(facts);

  return {
    customer_id:         facts.customer_id,
    full_name:           facts.full_name,
    confidence_percentage,
    traffic_light,
    score_breakdown,
    recommended_address: facts.recommended_address,
    reasoning:           facts.reasoning,
    positive_factors:    facts.positive_factors,
    negative_factors:    facts.negative_factors,
    missing_data_impact: facts.missing_data_impact,
  };
}

// ── Single customer scoring ───────────────────────────────────────────────────

app.post("/api/score-customer", async (req, res) => {
  const { customerData } = req.body;
  if (!customerData) return res.status(400).json({ error: "customerData is required" });

  try {
    res.json(await scoreCustomer(customerData));
  } catch (err) {
    if (err.code === "PARSE_ERROR") {
      console.error("Scoring parse error:", err.raw);
      return res.status(502).json({ error: err.message, code: err.code });
    }
    console.error("Scoring error:", err.message);
    res.status(500).json({ error: "Scoring failed: " + err.message });
  }
});

// ── Bulk customer scoring ─────────────────────────────────────────────────────

app.post("/api/score-customers", async (req, res) => {
  const { customers } = req.body;
  if (!Array.isArray(customers) || customers.length === 0) {
    return res.status(400).json({ error: "customers must be a non-empty array" });
  }

  try {
    const results = await Promise.all(
      customers.map(customerData =>
        limit(async () => {
          try {
            return await scoreCustomer(customerData);
          } catch (err) {
            console.error(`Failed to score customer ${customerData?.customer_id}:`, err.message || err);
            return {
              customer_id: customerData?.customer_id,
              error: err.message || "Scoring failed for this customer — please retry.",
              code: err.code || "SCORING_ERROR",
            };
          }
        })
      )
    );
    res.json({ results });
  } catch (err) {
    console.error("Bulk scoring error:", err.message);
    res.status(500).json({ error: "Bulk scoring failed: " + err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ KYC Scorer backend running on port ${PORT}`);
  console.log(`   Concurrency limit: ${CONCURRENCY_LIMIT}`);
});
