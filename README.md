# kanoo-api

A small Vercel serverless function that receives Framer form webhooks from the Jewar website and forwards each lead to the Kanoo CRM API. Kanoo credentials live only in Vercel environment variables and are never exposed to the browser.

```
Framer form ──(Framer webhook: server-to-server, signed)──▶ POST /api/lead ──▶ https://pro360api.kanooerp.com/api/zapier/Tiktok
```

Requirements: Node.js 18 or newer. There are no runtime dependencies; `npm install` only adds the Vercel CLI for `vercel dev`.

## How a request is handled

In order, in `api/lead.js`:

1. **Authentication.**
   - With `FRAMER_WEBHOOK_SECRET` set (required for production), every `POST` must carry a valid Framer signature, otherwise it gets `401`. `Origin` is not consulted for `POST`s.
   - Without it (legacy mode), the `Origin` header must match `ALLOWED_ORIGINS` when that variable is set, otherwise `403`. With neither set, anyone can submit leads.
   - `OPTIONS` and `GET` always follow `ALLOWED_ORIGINS`.
2. `OPTIONS` returns `204`; any other method except `POST` returns `405`.
3. `KANOO_TOKEN` and `KANOO_DB` must exist, otherwise `500`.
4. The endpoint guard picks the downstream URL (see `KANOO_ENDPOINT`), or refuses with `500`.
5. The body must be a JSON object with a name and a phone number, otherwise `400`.
6. The Kanoo payload is built and sent with the headers from Kanoo's Lead Submission API specification: `apikey: <KANOO_TOKEN>`, `db: <KANOO_DB>` and `Content-Type: application/json`. Kanoo's status is passed back to the caller.

## Framer webhook signature

When a Framer webhook destination has a secret, Framer signs every request ([Framer docs](https://www.framer.com/help/articles/framer-form-webhook-setup/)). The proxy verifies Framer's documented scheme exactly:

- `Framer-Signature` is `sha256=` followed by the hex HMAC-SHA256, keyed with the secret, of the **raw request body bytes** followed by the value of the `Framer-Webhook-Submission-Id` header.
- The raw body is verified before it is parsed, and the lead is built from those verified bytes. The comparison is constant-time.
- A request missing either header, or with a signature that doesn't match, gets `401 Invalid signature` and never reaches Kanoo.

Framer's scheme has no timestamp, so a captured signed request could be replayed. The signature is never logged.

### Setting up the secret

The order matters:

1. Generate a secret on your own machine with `openssl rand -hex 32`. Framer requires at least 32 characters. Keep it in a password manager; Framer can't show it again.
2. In Framer, do this for **every** form that posts here (Register Your Interest on the project pages, and Contact Us): select the form → **Send To** → **Webhook**. Set the URL to `https://kanoo-api.vercel.app/api/lead` and paste the secret into **Secret**. Use the same secret on every form.
3. In Vercel → **Settings → Environment Variables**, add `FRAMER_WEBHOOK_SECRET` with the identical value: type **Secret**, **Production** only.
4. Redeploy production. Environment-variable changes only apply to new deployments.

Do step 3 only after every form has the secret. Any form without it is rejected with `401`; Framer retries a non-2xx delivery up to 5 times, then gives up.

Mark the name and phone inputs as required in Framer, because the proxy rejects submissions without them. No input needs renaming.

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `KANOO_TOKEN` | **Production only** | Real Kanoo API key, sent as the `apikey` header. |
| `KANOO_DB` | **Production only** | Real Kanoo database name. |
| `FRAMER_WEBHOOK_SECRET` | Production. Optionally a *different* test value for a Preview branch. | The same value as the Framer webhook secret. When set, `POST`s must be signed. |
| `KANOO_ENDPOINT` | Preview and Development only | A non-production URL, such as a request-capture endpoint you control, that receives the outgoing Kanoo request. It must be `http(s)` and must not be on `pro360api.kanooerp.com`. It is ignored in Production. |
| `ALLOWED_ORIGINS` | Optional | A comma-separated list of browser origins, used for CORS. |

`ALLOWED_ORIGINS` is **not** authentication: any non-browser client can forge `Origin`, and server-to-server webhooks may not send one. If it is set while `FRAMER_WEBHOOK_SECRET` is unset, every request without an `Origin` header is rejected, which can include Framer's webhook.

The endpoint guard reads Vercel's `VERCEL_ENV` system variable, so keep **Automatically expose System Environment Variables** enabled. If `VERCEL_ENV` is missing, the code behaves as Production.

Scoping rules:

- **Real `KANOO_TOKEN` and `KANOO_DB` belong in Production only.**
- **Preview** gets dummy `KANOO_TOKEN` and `KANOO_DB` values, a `KANOO_ENDPOINT` pointing at a capture endpoint you control (send fake data only), and its own test `FRAMER_WEBHOOK_SECRET`. A preview without a safe `KANOO_ENDPOINT` refuses every `POST` with `500` before making any network call.
- **Development** (`vercel dev`) gets the same treatment: dummy credentials and a local capture URL in `KANOO_ENDPOINT`. Never put real credentials in a local `.env`.

## Field mapping

Framer sends each input's name as a JSON key. For each field, the canonical snake_case key is checked first, then the aliases in order, and the first non-empty value wins. Other keys, including Framer's hidden spam-trap inputs, are ignored.

| Kanoo field | Accepted input names |
| --- | --- |
| `name` | `name`, `Name` |
| `email` | `email`, `Email` |
| `phone_number` | `phone_number`, `phone`, `Phone`, `Phone Number`, `phone Number` |
| `q_1` (Contact Us) | `preferred_city`, `Preferred City` |
| `q_2`, first part (Contact Us) | `looking_for`, `Looking For` |
| `q_2`, second part (Contact Us) | `property_type`, `Property Type`, `Location` |

`name` and `phone_number` are required.

Every lead is sent with exactly the 12 fields of Kanoo's specification, in this order: `name`, `email`, `phone_number`, `campaign_name`, `form_name`, `ad_name`, `adset_name`, `platform`, `lead_source`, `marketing_tags`, `q_1`, `q_2`. All values are strings.

- The fields other than `name`, `email` and `phone_number` are copied from identically named keys when present, otherwise they are `""`.
- `lead_source` defaults to `Website` and `marketing_tags` to `Marketing Leads`. These defaults are this project's own, not part of Kanoo's specification.
- `adset_name` also accepts the former `adgroup_name` key.
- Keys outside the specification are not forwarded.

### Register Your Interest

The form sends `Name`, `Email` and `phone_number`, so Kanoo receives:

```json
{"name":"Test Person","email":"test@example.com","phone_number":"+966500000000","campaign_name":"","form_name":"","ad_name":"","adset_name":"","platform":"","lead_source":"Website","marketing_tags":"Marketing Leads","q_1":"","q_2":""}
```

### Contact Us

A submission counts as Contact Us when it contains a `Preferred City` or `Looking For` key (or `preferred_city` / `looking_for`). `Location` on its own does not count. For Contact Us, three fields are set by the proxy:

- `form_name`: `"Contact Us"`
- `q_1`: `"Preferred City: {value}"`
- `q_2`: `"Looking For: {value} | Property Type: {value}"`. The form's `Location` select holds the property type.

Blank answers are left out, with no stray separator. A select left on its placeholder ("Looking For", "Property Type") counts as unanswered. If nothing is answered, `q_1` and `q_2` are `""`.

For example, these live field names with fake values:

```json
{"Name":"Test Person","phone Number":"+966500000000","Email":"test@example.com","Preferred City":"Riyadh","Location":"Residential","Looking For":"Buy"}
```

become this Kanoo payload:

```json
{"name":"Test Person","email":"test@example.com","phone_number":"+966500000000","campaign_name":"","form_name":"Contact Us","ad_name":"","adset_name":"","platform":"","lead_source":"Website","marketing_tags":"Marketing Leads","q_1":"Preferred City: Riyadh","q_2":"Looking For: Buy | Property Type: Residential"}
```

### Still to confirm with Kanoo

- Whether empty `campaign_name`, `ad_name`, `adset_name`, `form_name` and `platform` are accepted. The specification only says `q_1` and `q_2` may be empty.
- Which `platform` value website leads should carry. The proxy sends `""` unless a `platform` key is provided.
- Whether the combined `q_2` value, two question-and-answer pairs separated by ` | `, is acceptable, since the specification's format is one `{Question}: {Answer}` per field.
- Whether the `Website` and `Marketing Leads` defaults are the right values.

## Responses

Every JSON response includes a `requestId`, which is also sent in the `X-Request-Id` header.

| Status | `message` | When |
| --- | --- | --- |
| 200 | `Lead submitted successfully` | Kanoo accepted the lead. `data` holds Kanoo's response. |
| 400 | `Validation error` | The body is not a JSON object, or the name or phone is missing. |
| 401 | `Invalid signature` | `FRAMER_WEBHOOK_SECRET` is set and a `POST` is unsigned or its signature doesn't match. |
| 403 | `Origin not allowed` | `ALLOWED_ORIGINS` is set and the `Origin` is missing or not listed. This applies to `OPTIONS`/`GET`, and to `POST` only while `FRAMER_WEBHOOK_SECRET` is unset. |
| 405 | `Method not allowed` | The method is not `POST` or `OPTIONS`. |
| 500 | `Server configuration error` | `KANOO_TOKEN` or `KANOO_DB` is missing, or Preview/Development has no safe `KANOO_ENDPOINT`. |
| Kanoo's status | `Kanoo API rejected the lead` | Kanoo returned a non-2xx status. `details` holds Kanoo's response. |
| 502 / 504 | `Could not reach Kanoo API` / `Kanoo API timed out` | A network error, or the 15-second timeout. `details` holds the error message. |

Framer treats any non-2xx response as a failed delivery and retries it. Response bodies, which only Framer sees, can include Kanoo's response; the logs never do.

## Logs

Every log line is a JSON object in **Vercel → Logs** with a `timestamp`, the `requestId`, an `event` and the fields below. Search by `requestId` to follow one submission.

**Logs never contain** secrets, signatures, request bodies, submitted values (names, phone numbers, emails, answers) or Kanoo's response body.

| Event | Level | Fields |
| --- | --- | --- |
| `lead_received` | log | `form_name` (`"Contact Us"` or `null`), `lead_source`, `receivedFields` (input names only) |
| `kanoo_success` | log | `status`, `durationMs` |
| `kanoo_failure` | error | `status`, `durationMs`, `category` (`upstream_rejected` or `upstream_server_error`), `responseKeys` (top-level keys of a JSON response, with no values) |
| `kanoo_unreachable` | error | `durationMs`, `timedOut`, `category` (`timeout` or `network_error`), `errorCode` |
| `validation_failed` | error | `reason`, or `missing` plus `receivedFields` (names only) |
| `signature_rejected` | error | `hasSignature`, `hasSubmissionId` (booleans only) |
| `origin_rejected` | error | `origin` |
| `config_error` | error | `message` naming what is missing; `environment` for the endpoint guard |

## Testing

```bash
npm test
```

The tests run offline with Node's built-in test runner. `fetch` is replaced with a mock before any test runs, so no test can contact Kanoo. They cover:

- the Register Your Interest golden payload and the Contact Us mapping;
- signature verification, including a known-answer vector computed with `openssl`;
- origin handling, the endpoint guard and configuration errors;
- log privacy.

To prove no network is used on macOS, run:

```bash
sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))' node --test
```

### Checking a deployment without creating a lead

Never send a lead, real or fake, to Production as a test: every valid lead becomes a Kanoo record. Use requests that stop before Kanoo:

- `GET /api/lead` returns `405`, or `403` when `ALLOWED_ORIGINS` is set and no `Origin` is sent.
- An unsigned `POST` returns `401` when `FRAMER_WEBHOOK_SECRET` is set.
- A **signed** `POST` of `{}` returns `400 Validation error`. That proves the signature verified, the credentials exist and the guard passed. It stops at validation, so Kanoo is never called.

```bash
read -rs FRAMER_WEBHOOK_SECRET && export FRAMER_WEBHOOK_SECRET   # paste it; it is not echoed or kept in history
BODY='{}'; SID="manual-check-$(date +%s)"
SIG=$(node -e 'const c=require("crypto");process.stdout.write("sha256="+c.createHmac("sha256",process.env.FRAMER_WEBHOOK_SECRET).update(process.argv[1]).update(process.argv[2]).digest("hex"))' "$BODY" "$SID")
curl -sS -X POST https://kanoo-api.vercel.app/api/lead \
  -H 'Content-Type: application/json' -H "Framer-Signature: $SIG" -H "Framer-Webhook-Submission-Id: $SID" \
  -d "$BODY" -w '\n%{http_code}\n'
unset FRAMER_WEBHOOK_SECRET
```

Preview deployments sit behind Vercel Deployment Protection. Add `-H "x-vercel-protection-bypass: $VERCEL_BYPASS"`, using the Protection Bypass for Automation secret, read into the shell the same way.

In a preview without `KANOO_ENDPOINT`, a correctly signed request returns `500 Server configuration error`. That means the signature passed and the guard stopped the request before any network call. If you point `KANOO_ENDPOINT` at your capture endpoint, send fake data only.

A true end-to-end test needs a real Kanoo call. Either coordinate one clearly marked test lead with the CRM team, who delete it afterwards, or use a Kanoo test database.

## Deploying

- `main` is the production branch: pushing or merging to `main` deploys to production.
- Every other branch gets a protected Preview deployment.
- To roll back, open the project's production deployment in Vercel and use **Instant Rollback**. It points the domain back at a previous build, with that build's own environment variables. On the Hobby plan, only the immediately previous production deployment is available.
- `npx vercel dev` uses the Development variables. Without a local capture URL in `KANOO_ENDPOINT`, the guard returns `500`.
