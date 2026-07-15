# kanoo-api

A minimal Vercel Serverless proxy that receives form submissions from a Framer site and forwards them to the Kanoo CRM API. The Kanoo bearer token and database name live in environment variables on Vercel, so they are never exposed to the browser.

```
POST /api/lead  →  https://pro360api.kanooerp.com/api/zapier/tiktok
```

## Requirements

- Node.js 18 or newer (native `fetch`)
- A Vercel account
- Your Kanoo API token and database name

## Install

```bash
npm install
```

Create a `.env` file for local development (it is git-ignored):

```bash
KANOO_TOKEN=your-kanoo-bearer-token
KANOO_DB=your-kanoo-db-name
# Optional. Comma-separated list of allowed browser origins.
# Leave unset to accept any origin.
ALLOWED_ORIGINS=https://your-site.framer.website,https://yourdomain.com
```

Run it locally:

```bash
npx vercel dev
# → http://localhost:3000/api/lead
```

## Deploy on Vercel

**Dashboard (recommended):** push this repo to GitHub, then in Vercel choose **Add New → Project**, import the repo, and deploy. No build settings are needed — Vercel detects `api/lead.js` automatically.

**CLI:**

```bash
npx vercel        # preview deployment
npx vercel --prod # production deployment
```

## Environment variables

In Vercel: **Project → Settings → Environment Variables**.

| Name              | Required | Example                                | Notes                                                   |
| ----------------- | -------- | -------------------------------------- | ------------------------------------------------------- |
| `KANOO_TOKEN`     | Yes      | `eyJhbGciOi...`                        | Sent as `Authorization: Bearer <token>`                  |
| `KANOO_DB`        | Yes      | `kanoo_live`                           | Sent as the `db` header                                  |
| `ALLOWED_ORIGINS` | No       | `https://your-site.framer.website`     | Comma-separated. Unset means any origin is accepted.     |

Add each one to **Production**, **Preview**, and **Development**, then **redeploy** — environment variables are only picked up by new deployments.

## API

### Request

```json
POST /api/lead
Content-Type: application/json

{
  "name": "Mohamed Allam",
  "email": "user@example.com",
  "phone_number": "+966500000000",
  "campaign_name": "Summer Campaign",
  "adgroup_name": "Riyadh",
  "ad_name": "Video A",
  "housing_support_eligible": "yes",
  "is_saudi_citizen": "yes",
  "lead_source": "Website",
  "marketing_tags": "Marketing Leads"
}
```

`name` and `phone_number` are required. `lead_source` defaults to `Website` and `marketing_tags` defaults to `Marketing Leads` when omitted.

### Accepted field aliases

Framer sends field names exactly as they are labelled in the form, so three fields accept common labels alongside the canonical key. The first non-empty match wins, and the canonical snake_case key always takes precedence. Whatever comes in, Kanoo always receives the canonical snake_case payload.

| Canonical key  | Also accepted                     |
| -------------- | --------------------------------- |
| `name`         | `Name`                            |
| `email`        | `Email`                           |
| `phone_number` | `phone`, `Phone`, `Phone Number`  |

Every other field (`campaign_name`, `adgroup_name`, `ad_name`, `housing_support_eligible`, `is_saudi_citizen`, `lead_source`, `marketing_tags`) must use its exact snake_case name.

### Responses

Every JSON response carries a `requestId` (a UUID, also returned in the `X-Request-Id` header) that appears in every server log line for that request. Quote it when chasing down a lead that did not arrive.

| Status  | Body                                                                                            | When                                     |
| ------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 200     | `{ "success": true, "requestId": "...", "message": "Lead submitted successfully", "data": ... }` | Kanoo accepted the lead                  |
| 400     | `{ "success": false, "requestId": "...", "message": "Validation error" }`                        | `name` or `phone_number` missing         |
| 403     | `{ "success": false, "requestId": "...", "message": "Origin not allowed" }`                      | Origin not in `ALLOWED_ORIGINS`          |
| 405     | `{ "success": false, "requestId": "...", "message": "Method not allowed" }`                      | Method other than `POST` / `OPTIONS`     |
| 4xx/5xx | `{ "success": false, "requestId": "...", "message": "...", "details": ... }`                     | Kanoo's own status code is forwarded     |
| 502/504 | `{ "success": false, "requestId": "...", "message": "...", "details": ... }`                     | Kanoo unreachable or timed out (15s cap) |

## Connect the Framer webhook

1. In Framer, select your form and open the right-hand panel.
2. Set **Submit → Action** (or **Connect → Webhook**) to **Webhook / HTTP POST**.
3. Paste your production URL: `https://YOUR_PROJECT.vercel.app/api/lead`
4. Name each form field to match the payload keys — `name`, `email`, `phone_number`, `campaign_name`, `adgroup_name`, `ad_name`, `housing_support_eligible`, `is_saudi_citizen`, `lead_source`, `marketing_tags`. Framer sends field names verbatim; the name, email, and phone fields also accept the common labels listed under [Accepted field aliases](#accepted-field-aliases), so a field labelled `Phone Number` works. Every other field must use its exact snake_case name.
5. Publish the Framer site and submit a real test entry.
6. Confirm the lead in Kanoo, and check the logs in **Vercel → Project → Logs** if it does not arrive.

If you set `ALLOWED_ORIGINS`, include the published Framer domain (and any custom domain) or the browser will block the request.

## Test with Postman

1. **Method:** `POST` — **URL:** `https://YOUR_PROJECT.vercel.app/api/lead`
2. **Headers:** `Content-Type: application/json`
3. **Body:** choose **raw → JSON** and paste the request example above.
4. **Send.** A success returns `200` with `"success": true`.

To verify validation, remove `phone_number` and send again — you should get `400` with `{ "success": false, "message": "Validation error" }`.

The equivalent curl:

```bash
curl -X POST https://YOUR_PROJECT.vercel.app/api/lead \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Lead","phone_number":"+966500000000","email":"test@example.com","lead_source":"Website","marketing_tags":"Marketing Leads"}'
```

## Logs

Every log line is a single structured JSON object carrying a `timestamp`, the `requestId`, and an `event`, visible under **Vercel → Project → Logs**. Searching the logs for a `requestId` returns the full story of that one submission.

| Event               | Level   | Meaning                                                             |
| ------------------- | ------- | ------------------------------------------------------------------- |
| `lead_received`     | `log`   | Valid lead, about to be sent to Kanoo. Includes name, phone, email.  |
| `kanoo_success`     | `log`   | Kanoo accepted the lead. Includes `durationMs`.                      |
| `kanoo_failure`     | `error` | Kanoo returned a non-2xx. Includes its status and response body.     |
| `kanoo_unreachable` | `error` | Network error or timeout. Includes `timedOut`.                       |
| `validation_failed` | `error` | Rejected with 400. Lists which fields were `missing`.                |
| `config_error`      | `error` | `KANOO_TOKEN` or `KANOO_DB` is not set.                              |
| `origin_rejected`   | `error` | Origin was not in `ALLOWED_ORIGINS`.                                 |

`KANOO_TOKEN` and `KANOO_DB` are never logged and never appear in a response body. Note that `lead_received` does log submitter name, phone number, and email — that is personal data sitting in your Vercel log retention, so check it against your privacy policy before going live.
