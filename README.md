# KYC Address Intelligence — Confidence Scoring Engine

An LLM-powered tool that reads any customer spreadsheet — regardless of column naming conventions — maps it to a standard KYC schema, and produces a deterministic confidence score for each customer's address data with plain English reasoning.

---

## How It Works

1. **Schema Detection (LLM call 1)** — The LLM reads a sample of your uploaded spreadsheet and reasons about what each column represents based on actual data values, not column names. A spreadsheet with columns called `flux_alpha`, `whisper_1`, `zigzag_code` is handled just as well as one called `customer_id`, `address_line_1`, `postcode`. The result is a JSON schema map passed to step 2.

2. **Fact Extraction (LLM call 2)** — For each customer, the LLM reads their assembled records and extracts structured facts: the most recent record date, the strongest verification method present, whether addresses conflict, and the best source quality. No scoring happens here — the LLM reports only what the data shows.

3. **Deterministic Scoring (code)** — The extracted facts are passed through a fixed arithmetic scoring function. The same facts always produce the same score. Weights are:

   | Factor       | Max pts | Basis |
   |--------------|---------|-------|
   | Recency      | 40      | Age in months of most recent address record |
   | Verification | 30      | Strongest verification method present |
   | Consistency  | 20      | Whether addresses conflict across records |
   | Source       | 10      | Best source quality present |

4. **Output** — Every customer receives a percentage score, a traffic light, a recommended address, plain English reasoning, a score breakdown, and specific recommendations for what data would improve the score.

**Thresholds:** Green ≥75% | Amber 40–74% | Red <40%

---

## Project Structure

```
kyc-scorer/
├── backend/              # Express server — Anthropic API calls and scoring arithmetic
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── frontend/             # React app
│   ├── src/
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── .env.example
└── .gitignore
```

---

## Setup

### Prerequisites
- Node.js 18+
- An Anthropic API key — get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)

---

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and add your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-YOUR-REAL-KEY-HERE
```

Start the backend:
```bash
npm start
# or for development with auto-reload:
npm run dev
```

The backend will start on `http://localhost:3001`

---

### 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env
```

The default `VITE_API_URL=http://localhost:3001` points at the local backend — no changes needed for local development.

Start the frontend:
```bash
npm run dev
```

The app will open at `http://localhost:3000`

---

## Deploying to Production

### Backend (Railway)

1. Create a new project at [railway.app](https://railway.app)
2. Connect your GitHub repo and select the `backend` folder
3. Add environment variables in Railway's dashboard:
   ```
   ANTHROPIC_API_KEY = sk-ant-YOUR-REAL-KEY-HERE
   FRONTEND_URL = https://your-frontend-domain.vercel.app
   ```
4. Railway will provide a public URL like `https://kyc-scorer-backend.railway.app`

### Frontend (Vercel)

1. Create a new project at [vercel.com](https://vercel.com)
2. Connect your GitHub repo and select the `frontend` folder
3. Add environment variable in Vercel's dashboard:
   ```
   VITE_API_URL = https://kyc-scorer-backend.railway.app
   ```
4. Deploy

---

## Security Notes

- **Your Anthropic API key lives only on the backend server** — it is never sent to or visible in the browser
- **Never commit `.env` files** — the `.gitignore` prevents this, but double-check before pushing
- **In production**, set `FRONTEND_URL` in the backend to your exact frontend domain to restrict CORS

---

## Expected Input Format

The app accepts any `.xlsx` or `.xls` spreadsheet. It works best when the data contains:

| Data | Examples of what it might be called |
|------|--------------------------------------|
| Customer identifier | `customer_id`, `client_ref`, `flux_alpha` |
| Customer name | `full_name`, `client_name`, `banana_7` |
| Address lines | `address_line_1`, `street_line1`, `whisper_1` |
| City | `city`, `town`, `fog_city` |
| Postcode | `postcode`, `postal_code`, `zigzag_code` |
| How address was obtained | `address_source` — values: `branch`, `app`, `call_centre`, `document_verification` |
| Date address was recorded | `date_recorded`, `entry_date`, `timestamp_in` |
| Verification method | `document_verification_status`, `id_check_status` |

Missing columns are handled gracefully — the system scores based on whatever is available and flags what additional data would improve reliability.

---

## Sample Test Data

Three sample datasets are included in `/sample-data/`:

- `sample_standard.xlsx` — standard column names matching the schema exactly
- `sample_different_columns.xlsx` — differently named but recognisable columns
- `test_gobbledygook.xlsx` — completely opaque column and sheet names (`Zeta_9`, `Purple_Fog`, `flux_alpha`, `zigzag_code` etc)

All three produce consistent, deterministic results.
