import { useState, useCallback } from "react";
import * as XLSX from "xlsx";

// ── Constants ────────────────────────────────────────────────────────────────

const SCHEMA_COLUMNS = {
  identity: ["customer_id","full_name","date_of_birth","national_id_number","gender"],
  address:  ["address_id","customer_id","address_line_1","address_line_2","city","postcode","country","address_source","recorded_by","date_recorded","date_superseded"],
  account:  ["customer_id","account_open_date","last_interaction_date","last_interaction_channel","document_verification_status"],
};

const TRAFFIC = {
  GREEN: { bg: "#00875A", light: "#E3FCEF", label: "COMPLIANT" },
  AMBER: { bg: "#FF8B00", light: "#FFFAE6", label: "REVIEW" },
  RED:   { bg: "#DE350B", light: "#FFEBE6", label: "ACTION" },
};

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

// ── Utilities ────────────────────────────────────────────────────────────────

function normaliseRows(rows) {
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[String(k).trim()] = v ?? "";
    }
    return out;
  });
}

// ── API Calls ─────────────────────────────────────────────────────────────────

async function detectSchema(sheetSamples) {
  const response = await fetch(`${API_URL}/api/detect-schema`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sheetSamples }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Schema detection failed. Is the backend running?");
  }
  return response.json();
}

async function scoreCustomer(customerData) {
  const response = await fetch(`${API_URL}/api/score-customer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerData }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Scoring failed. Is the backend running?");
  }
  return response.json();
}

// ── Customer Assembly ────────────────────────────────────────────────────────

function assembleCustomer(cid, schemaMap, sheets) {
  const { id_column, id_sheet, address_sheet, account_sheet, column_mappings } = schemaMap;
  const data = { customer_id: String(cid), identity: {}, addresses: [], account: {}, missing_fields: [] };

  function remapRow(sheetName, row) {
    const mapping = column_mappings[sheetName] || {};
    const remapped = {};
    for (const [col, val] of Object.entries(row)) {
      const schemaField = mapping[col];
      if (schemaField) remapped[schemaField] = val ?? "";
      else remapped[col] = val ?? "";
    }
    return remapped;
  }

  if (id_sheet && sheets[id_sheet]) {
    const row = sheets[id_sheet].find(r => String(r[id_column]) === String(cid));
    if (row) data.identity = remapRow(id_sheet, row);
    else data.missing_fields.push("No identity record found for this customer");
  } else {
    data.missing_fields.push("No identity table detected");
  }

  if (address_sheet && sheets[address_sheet]) {
    const rows = sheets[address_sheet].filter(r => String(r[id_column]) === String(cid));
    rows.forEach(r => data.addresses.push(remapRow(address_sheet, r)));
    if (!rows.length) data.missing_fields.push("No address records found for this customer");
  } else {
    data.missing_fields.push("No address table detected");
  }

  if (account_sheet && sheets[account_sheet]) {
    const row = sheets[account_sheet].find(r => String(r[id_column]) === String(cid));
    if (row) data.account = remapRow(account_sheet, row);
    else data.missing_fields.push("No account/interaction record found");
  } else {
    data.missing_fields.push("No account/interaction table detected");
  }

  return data;
}

// ── UI Components ────────────────────────────────────────────────────────────

function TrafficBadge({ light, pct }) {
  const t = TRAFFIC[light] || TRAFFIC.RED;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{
        background: t.bg, color: "#fff", borderRadius: 6,
        padding: "4px 10px", fontFamily: "'DM Mono', monospace",
        fontSize: 11, fontWeight: 700, letterSpacing: 1
      }}>{t.label}</div>
      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: 22,
        fontWeight: 700, color: t.bg
      }}>{pct}%</div>
    </div>
  );
}

function ScoreBreakdown({ breakdown }) {
  if (!breakdown) return null;
  const rows = [
    { label: "Recency",      max: 40, score: breakdown.recencyScore },
    { label: "Verification", max: 30, score: breakdown.verificationScore },
    { label: "Consistency",  max: 20, score: breakdown.consistencyScore },
    { label: "Source",       max: 10, score: breakdown.sourceScore },
  ];
  return (
    <div style={{ marginTop: 16, background: "#F4F6F9", borderRadius: 8, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7F94", letterSpacing: 1, marginBottom: 10, fontFamily: "'DM Mono', monospace" }}>SCORE BREAKDOWN</div>
      {rows.map(({ label, max, score }) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ width: 90, fontSize: 12, color: "#4A5D6E" }}>{label}</div>
          <div style={{ flex: 1, background: "#E8EDF2", borderRadius: 100, height: 6 }}>
            <div style={{
              background: "#2D6CDF", height: "100%", borderRadius: 100,
              width: `${(score / max) * 100}%`, transition: "width 0.4s ease"
            }} />
          </div>
          <div style={{ width: 50, fontSize: 12, color: "#4A5D6E", fontFamily: "'DM Mono', monospace", textAlign: "right" }}>
            {score} / {max}
          </div>
        </div>
      ))}
    </div>
  );
}

function CustomerCard({ result, index }) {
  const [open, setOpen] = useState(false);
  const t = TRAFFIC[result.traffic_light] || TRAFFIC.RED;

  return (
    <div style={{
      border: `1px solid ${open ? t.bg : "#E8EDF2"}`,
      borderRadius: 12, overflow: "hidden", marginBottom: 12,
      transition: "border-color 0.2s", background: "#fff",
      boxShadow: open ? `0 4px 20px ${t.bg}22` : "0 1px 4px #00000010"
    }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "16px 20px", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: open ? t.light : "#fff"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%", background: t.bg,
            color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 700, flexShrink: 0
          }}>{index + 1}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#0D1B2A" }}>
              {result.full_name || result.customer_id}
            </div>
            <div style={{ fontSize: 12, color: "#6B7F94", fontFamily: "'DM Mono', monospace" }}>
              {result.customer_id}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <TrafficBadge light={result.traffic_light} pct={result.confidence_percentage} />
          <div style={{ color: "#6B7F94", fontSize: 18 }}>{open ? "▲" : "▼"}</div>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 20px 20px", borderTop: `1px solid ${t.bg}33` }}>

          <div style={{ marginTop: 16, padding: "12px 16px", background: t.light, borderRadius: 8, borderLeft: `3px solid ${t.bg}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.bg, letterSpacing: 1, marginBottom: 4, fontFamily: "'DM Mono', monospace" }}>RECOMMENDED ADDRESS</div>
            <div style={{ fontSize: 14, color: "#0D1B2A", fontWeight: 500 }}>{result.recommended_address}</div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7F94", letterSpacing: 1, marginBottom: 6, fontFamily: "'DM Mono', monospace" }}>ANALYSIS</div>
            <div style={{ fontSize: 14, color: "#2D3F50", lineHeight: 1.6 }}>{result.reasoning}</div>
          </div>

          <ScoreBreakdown breakdown={result.score_breakdown} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
            <div style={{ background: "#F0FBF4", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#00875A", letterSpacing: 1, marginBottom: 8, fontFamily: "'DM Mono', monospace" }}>POSITIVE FACTORS</div>
              {result.positive_factors?.length ? result.positive_factors.map((f, i) => (
                <div key={i} style={{ fontSize: 13, color: "#0D1B2A", marginBottom: 4, display: "flex", gap: 6 }}>
                  <span style={{ color: "#00875A", flexShrink: 0 }}>✓</span>{f}
                </div>
              )) : <div style={{ fontSize: 13, color: "#6B7F94" }}>None identified</div>}
            </div>

            <div style={{ background: "#FFF5F5", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#DE350B", letterSpacing: 1, marginBottom: 8, fontFamily: "'DM Mono', monospace" }}>NEGATIVE FACTORS</div>
              {result.negative_factors?.length ? result.negative_factors.map((f, i) => (
                <div key={i} style={{ fontSize: 13, color: "#0D1B2A", marginBottom: 4, display: "flex", gap: 6 }}>
                  <span style={{ color: "#DE350B", flexShrink: 0 }}>✗</span>{f}
                </div>
              )) : <div style={{ fontSize: 13, color: "#6B7F94" }}>None identified</div>}
            </div>
          </div>

          {result.missing_data_impact?.length > 0 && (
            <div style={{ marginTop: 16, background: "#FFFAE6", borderRadius: 8, padding: "12px 14px", borderLeft: "3px solid #FF8B00" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#FF8B00", letterSpacing: 1, marginBottom: 8, fontFamily: "'DM Mono', monospace" }}>DATA GAPS — WHAT WOULD IMPROVE THIS SCORE</div>
              {result.missing_data_impact.map((m, i) => (
                <div key={i} style={{ fontSize: 13, color: "#0D1B2A", marginBottom: 4, display: "flex", gap: 6 }}>
                  <span style={{ color: "#FF8B00", flexShrink: 0 }}>→</span>{m}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryBar({ results }) {
  const green = results.filter(r => r.traffic_light === "GREEN").length;
  const amber = results.filter(r => r.traffic_light === "AMBER").length;
  const red   = results.filter(r => r.traffic_light === "RED").length;
  const avg   = results.length ? Math.round(results.reduce((s, r) => s + r.confidence_percentage, 0) / results.length) : 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
      {[
        { label: "AVG CONFIDENCE", value: `${avg}%`, color: "#0D1B2A" },
        { label: "COMPLIANT",      value: green,     color: "#00875A" },
        { label: "NEEDS REVIEW",   value: amber,     color: "#FF8B00" },
        { label: "ACTION REQUIRED",value: red,       color: "#DE350B" },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", border: "1px solid #E8EDF2", boxShadow: "0 1px 4px #00000008" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6B7F94", letterSpacing: 1, marginBottom: 6, fontFamily: "'DM Mono', monospace" }}>{label}</div>
          <div style={{ fontSize: 28, fontWeight: 800, color, fontFamily: "'DM Mono', monospace" }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [stage, setStage]       = useState("upload");
  const [results, setResults]   = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0, name: "" });
  const [error, setError]       = useState(null);
  const [dragging, setDragging] = useState(false);

  const processFile = useCallback(async (file) => {
    setError(null);
    setStage("processing");

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });

      const normSheets = {};
      wb.SheetNames.forEach(name => {
        normSheets[name] = normaliseRows(XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }));
      });

      setProgress({ current: 0, total: 1, name: "Analysing spreadsheet structure..." });

      // Build sheet samples for the backend schema detection call
      const sheetSamples = {};
      for (const [name, rows] of Object.entries(normSheets)) {
        if (!rows.length) continue;
        sheetSamples[name] = { columns: Object.keys(rows[0]), sample_rows: rows.slice(0, 3) };
      }

      const schemaMap = await detectSchema(sheetSamples);

      const { id_column } = schemaMap;
      if (!id_column) throw new Error("Could not identify a customer identifier column.");

      const cidSet = new Set();
      for (const rows of Object.values(normSheets)) {
        rows.forEach(r => { if (r[id_column]) cidSet.add(String(r[id_column])); });
      }
      const cids = [...cidSet].sort();
      if (!cids.length) throw new Error("No customer records found after schema mapping.");

      setProgress({ current: 0, total: cids.length, name: "" });

      const scored = [];
      for (let i = 0; i < cids.length; i++) {
        const cid = cids[i];
        const customerData = assembleCustomer(cid, schemaMap, normSheets);
        const fullName = customerData.identity?.full_name || cid;
        setProgress({ current: i + 1, total: cids.length, name: fullName });
        const score = await scoreCustomer(customerData);
        scored.push({ ...score, customer_id: cid, full_name: fullName });
      }

      setResults(scored);
      setStage("results");
    } catch (e) {
      setError(e.message);
      setStage("upload");
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files[0] || e.target.files[0];
    if (file) processFile(file);
  }, [processFile]);

  return (
    <div style={{ minHeight: "100vh", background: "#F4F6F9", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" }}>

      <div style={{ background: "#0D1B2A", padding: "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, background: "#2D6CDF", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#fff", fontSize: 16 }}>⬡</span>
          </div>
          <div>
            <div style={{ color: "#fff", fontWeight: 700, fontSize: 16, letterSpacing: 0.3 }}>KYC Address Intelligence</div>
            <div style={{ color: "#6B8BAF", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>Confidence Scoring Engine v1.0</div>
          </div>
        </div>
        {stage === "results" && (
          <button
            onClick={() => { setStage("upload"); setResults([]); }}
            style={{ background: "transparent", border: "1px solid #2D6CDF", color: "#6BA3FF", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            ← New Analysis
          </button>
        )}
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>

        {stage === "upload" && (
          <div>
            <div style={{ marginBottom: 32 }}>
              <h1 style={{ fontSize: 28, fontWeight: 800, color: "#0D1B2A", margin: "0 0 8px" }}>Address Confidence Scoring</h1>
              <p style={{ color: "#4A5D6E", fontSize: 15, margin: 0 }}>Upload any spreadsheet mapped to the standard schema. The system will detect your data, score each customer, and explain its reasoning.</p>
            </div>

            {error && (
              <div style={{ background: "#FFEBE6", border: "1px solid #DE350B", borderRadius: 10, padding: "14px 18px", marginBottom: 20, color: "#DE350B", fontSize: 14 }}>
                ⚠ {error}
              </div>
            )}

            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onClick={() => document.getElementById("file-input").click()}
              style={{
                border: `2px dashed ${dragging ? "#2D6CDF" : "#C5D0DC"}`,
                borderRadius: 16, padding: "60px 40px", textAlign: "center",
                cursor: "pointer", background: dragging ? "#EDF2FF" : "#fff",
                transition: "all 0.2s"
              }}
            >
              <div style={{ fontSize: 40, marginBottom: 16 }}>📊</div>
              <div style={{ fontWeight: 700, fontSize: 18, color: "#0D1B2A", marginBottom: 8 }}>Drop your spreadsheet here</div>
              <div style={{ color: "#6B7F94", fontSize: 14 }}>or click to browse — supports .xlsx and .xls</div>
              <input id="file-input" type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={onDrop} />
            </div>

            <div style={{ marginTop: 24, background: "#fff", borderRadius: 12, padding: "20px 24px", border: "1px solid #E8EDF2" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6B7F94", letterSpacing: 1, marginBottom: 12, fontFamily: "'DM Mono', monospace" }}>EXPECTED SCHEMA COLUMNS</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                {Object.entries(SCHEMA_COLUMNS).map(([domain, cols]) => (
                  <div key={domain}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#2D6CDF", marginBottom: 6, textTransform: "uppercase" }}>{domain}</div>
                    {cols.map(c => (
                      <div key={c} style={{ fontSize: 12, color: "#4A5D6E", fontFamily: "'DM Mono', monospace", marginBottom: 2 }}>{c}</div>
                    ))}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, fontSize: 12, color: "#6B7F94", fontStyle: "italic" }}>Missing columns are handled gracefully — the system scores based on what's available.</div>
            </div>
          </div>
        )}

        {stage === "processing" && (
          <div style={{ textAlign: "center", padding: "80px 40px" }}>
            <div style={{ fontSize: 48, marginBottom: 24 }}>⚙️</div>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: "#0D1B2A", marginBottom: 8 }}>
              {progress.current === 0 ? "Mapping spreadsheet schema..." : "Scoring customers"}
            </h2>
            <div style={{ color: "#6B7F94", fontSize: 15, marginBottom: 32 }}>
              {progress.current === 0
                ? "Reading your data to understand the column structure..."
                : <>Scoring {progress.name && <strong style={{ color: "#0D1B2A" }}>{progress.name}</strong>} — {progress.current} of {progress.total}</>
              }
            </div>
            <div style={{ background: "#E8EDF2", borderRadius: 100, height: 8, maxWidth: 400, margin: "0 auto" }}>
              <div style={{
                background: "#2D6CDF", height: "100%", borderRadius: 100,
                width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%`,
                transition: "width 0.4s ease"
              }} />
            </div>
          </div>
        )}

        {stage === "results" && results.length > 0 && (
          <div>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 24, fontWeight: 800, color: "#0D1B2A", margin: "0 0 4px" }}>Results — {results.length} customers scored</h2>
              <p style={{ color: "#6B7F94", fontSize: 14, margin: 0 }}>Click any row to expand the full analysis and data gap recommendations.</p>
            </div>
            <SummaryBar results={results} />
            {results
              .sort((a, b) => a.confidence_percentage - b.confidence_percentage)
              .map((r, i) => <CustomerCard key={r.customer_id} result={r} index={i} />)
            }
          </div>
        )}
      </div>
    </div>
  );
}
