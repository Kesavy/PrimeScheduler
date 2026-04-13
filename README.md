# PrimeScheduler

Schedule Trello card comments for a specific time. The comment is posted under your own Trello account at the exact moment you choose.

## Features
- Schedule comments up to 7 days ahead
- @mention board members with autocomplete (type `@` in the comment box)
- Badge on card showing pending count — opens scheduler on click
- Cancel pending comments at any time
- Full auth revoke

## Stack
- **Vercel** Serverless Functions — API
- **Upstash QStash** — delayed comment delivery
- **Upstash Redis** — encrypted token storage + job metadata
- **GitHub Pages** (or any static host) — Power-Up frontend

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth` | POST | Save encrypted OAuth token |
| `/api/schedule` | POST | Schedule a comment via QStash |
| `/api/send-comment` | POST | QStash callback — posts the comment |
| `/api/revoke` | POST | Revoke token + cancel all jobs |
| `/api/revoke-job` | POST | Cancel a single job |

## Setup

### 1. Clone and install
```bash
git clone https://github.com/your-account/primescheduler-backend
cd primescheduler-backend
npm install
```

### 2. Generate encryption key
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Set environment variables
```bash
cp .env.example .env
# Fill in values, then add the same to Vercel dashboard → Settings → Environment Variables
```

### 4. Deploy backend
```bash
npx vercel --prod
```

### 5. Deploy frontend
Host the HTML files on GitHub Pages (or any static host). Update `BACKEND` and `APP_KEY` constants in `connector.html`, `authorize.html`, and `schedule-popup.html`.

### 6. Register Power-Up in Trello
Go to https://trello.com/power-ups/admin, create a new Power-Up, set the connector URL to your hosted `connector.html`, and enable capabilities: `authorization-status`, `show-authorization`, `card-detail-badges`, `card-buttons`.

## Migration note
If deploying alongside an existing PrimeTime installation, both share the same Redis key schema. They can coexist safely — PrimeScheduler only reads/writes `token:*`, `scheduled:*`, and `member:*:jobs` keys.
