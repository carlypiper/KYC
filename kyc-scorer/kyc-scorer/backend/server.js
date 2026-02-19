/**
 * KYC Address Confidence Scorer — Backend Server
 *
 * Handles all calls to the Anthropic API so the API key
 * is never exposed to the browser.
 *
 * Endpoints:
 *   POST /api/detect-schema  — LLM reads spreadsheet data and maps columns
 *   POST /api/score-customer — LLM scores a single customer's address data
 *   POST /api/score-customers — Scores multiple customers with controlled concurrency
 */

const express = require("express");
const cors    = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

// ─────────────────────────────────────────────────────────────────────────────
// 🔑 API KEY CONFIGURATION
//
// NEVER hardcode your API key here.
// Set it as an environment variable before running the server.
//
// Locally:
//   Create a .env file in this directory (see .env.example) and run:
//   node server.js
//   OR set it directly in your terminal:
//   export ANTHROPIC_API_KEY=sk-ant-...
//
// In production (Railway / Render / Heroku / AWS etc):
//   Add ANTHROPIC_API_KEY as a secret environment variable
//   in your hosting provider's dashboard. Never put it in code.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY environment variable is not set.");
  console.error("   Create a .env file from .env.example and add your key.");
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app    = express();

app.use(cors({
  // ⚠️  PRODUCTION: Replace "*" with your actual frontend domain
  // e.g. origin: "https://your-app.vercel.app"
  origin: process.env.FRONTEND_URL || "*",
}));

app.use(express.json({ limit: "10mb" }));

const MODEL   = "claude-sonnet-4-20250514";
const TODAY   = new Date().toISOString().split("T")[0];

// ── Concurrency limiter ───────────────────────────────────────────────────────
// Controls how many simultaneous Anthropic API calls are made when scoring
// multiple customers. Keeps us well within rate limits.
// Adjust CONCURRENCY_LIMIT up or down based on your API tier.

const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || "5", 10);

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        next();
      });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

const limit = createLimiter(CONCURRENCY_LIMIT);

// ── Safe JSON parser ──────────────────────────────────────────────────────────
// Wraps JSON.parse with a descriptive error so the caller knows exactly
// what went wrong and can surface it meaningfully in the UI.

function safeParseJSON(text, context) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return { data: JSON.parse(cleaned), error: null };
  } catch (err) {
    return {
      data: null,
      error: {
        code: "PARSE_ERROR",
        context,
        message: `The AI response for ${context} was not valid JSON. This can happen occasionally — please retry.`,
        raw: cleaned.slice(0, 300), // truncated for logging, not sent to client
      },
    };
  }
}

// ── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Schema Detection ─────────────────────────────────────────────────────────

app.post("/api/detect-schema", async (req, res) => {
  const { sheetSamples } = req.body;

  if (!sheetSamples) {
    return res.status(400).json({ error: "sheetSamples is required" });
  }

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
      return res.status(502).json({
        error: error.message,
        code: error.code,
      });
    }

    res.json(data);
  } catch (err) {
    console.error("Schema detection error:", err.message);
    res.status(500).json({ error: "Schema detection failed: " + err.message });
  }
});

// ── Scoring system prompt ─────────────────────────────────────────────────────

const SCORING_SYSTEM = `You are a KYC compliance analysis engine for financial institutions.

Analyse customer address data and return a structured confidence score.

SCORING FRAMEWORK (apply in this priority order):
1. RECENCY — date_recorded within 12 months = high confidence. Degrades the older the record.
2. VERIFICATION — weighted by how recently it was done. Recent document verification = large boost.
3. FREQUENCY — same address appearing multiple times adds confidence. More recent repetitions count more.
4. SOURCE QUALITY — ranked: document_verification > branch > app > call_centre

TRAFFIC LIGHT THRESHOLDS:
- GREEN: 75% and above (compliant)
- AMBER: 40–74% (needs review)
- RED: below 40% (action required)

GRACEFUL DEGRADATION: If a factor cannot be assessed due to missing data, do NOT penalise the score. Flag it in missing_data_impact instead.

TODAY: ${TODAY}

Respond ONLY with a valid JSON object, no other text:
{
  "confidence_percentage": <integer 0-100>,
  "traffic_light": <"GREEN"|"AMBER"|"RED">,
  "recommended_address": <full address string or "Insufficient data">,
  "reasoning": <2-4 sentence plain English explanation>,
  "positive_factors": [<strings>],
  "negative_factors": [<strings>],
  "missing_data_impact": [<specific actionable recommendations>]
}`;

// ── Shared scoring function ───────────────────────────────────────────────────

async function scoreCustomer(customerData) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: SCORING_SYSTEM,
    messages: [{
      role: "user",
      content: `Analyse this customer and return the JSON confidence score:\n\n${JSON.stringify(customerData, null, 2)}`,
    }],
  });

  const text = message.content.map(b => b.text || "").join("");
  const { data, error } = safeParseJSON(text, `customer ${customerData?.customer_id || "unknown"}`);

  if (error) throw error;
  return data;
}

// ── Single customer scoring ───────────────────────────────────────────────────

app.post("/api/score-customer", async (req, res) => {
  const { customerData } = req.body;

  if (!customerData) {
    return res.status(400).json({ error: "customerData is required" });
  }

  try {
    const score = await scoreCustomer(customerData);
    res.json(score);
  } catch (err) {
    // Distinguish parse errors from API errors for better UI messaging
    if (err.code === "PARSE_ERROR") {
      console.error("Scoring parse error:", err.raw);
      return res.status(502).json({ error: err.message, code: err.code });
    }
    console.error("Scoring error:", err.message);
    res.status(500).json({ error: "Scoring failed: " + err.message });
  }
});

// ── Bulk customer scoring (concurrency-limited) ───────────────────────────────
//
// Accepts an array of customerData objects and scores them in parallel,
// capped at CONCURRENCY_LIMIT simultaneous API calls.
//
// Each result includes the original customer_id so the frontend can
// match scores back to customers regardless of response order.
//
// Failed individual scores are returned with { error } rather than
// aborting the entire batch, so one bad record doesn't block the rest.

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
            const score = await scoreCustomer(customerData);
            return { customer_id: customerData?.customer_id, ...score };
          } catch (err) {
            // Per-customer failure — log and return gracefully so batch continues
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
  console.log(`   API key loaded: ${process.env.ANTHROPIC_API_KEY ? "yes" : "NO — set ANTHROPIC_API_KEY"}`);
  console.log(`   Concurrency limit: ${CONCURRENCY_LIMIT}`);
});
