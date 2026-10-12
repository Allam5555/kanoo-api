import { randomUUID } from "node:crypto";

const PRODUCTION_KANOO_ENDPOINT = "https://pro360api.kanooerp.com/api/zapier/tiktok";
const PRODUCTION_KANOO_HOST = new URL(PRODUCTION_KANOO_ENDPOINT).hostname;
const NON_PRODUCTION_ENVS = ["preview", "development"];
const KANOO_TIMEOUT_MS = 15000;

// Framer sends field names exactly as they are labelled in the form, so accept
// the common labels alongside the canonical snake_case keys. First non-empty wins.
const FIELD_ALIASES = {
  name: ["name", "Name"],
  email: ["email", "Email"],
  phone_number: ["phone_number", "phone", "Phone", "Phone Number", "phone Number"],
  preferred_city: ["preferred_city", "Preferred City"],
  looking_for: ["looking_for", "Looking For"],
  property_type: ["property_type", "Property Type", "Location"],
};

// Contact Us is recognised by its distinctive fields rather than a ?form= flag,
// because Framer does not document query strings on webhook URLs. Location is too
// generic to count on its own. Register Your Interest sends none of these, so its
// payload is untouched.
const CONTACT_US_FIELDS = ["preferred_city", "looking_for"];

// Set ALLOWED_ORIGINS to a comma-separated list of Framer domains to lock this down.
// Unset means any origin may post a lead.
function resolveOrigin(requestOrigin) {
  const configured = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.length === 0) return "*";
  if (requestOrigin && configured.includes(requestOrigin)) return requestOrigin;
  return null;
}

function applyCors(req, res) {
  const origin = resolveOrigin(req.headers.origin);
  if (origin === null) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (origin !== "*") res.setHeader("Vary", "Origin");
  return true;
}

// Preview and Development must set KANOO_ENDPOINT to a non-production endpoint and
// can never fall back to, or be pointed at, production Kanoo. Everywhere else the
// production endpoint is used and KANOO_ENDPOINT is ignored, so a variable that was
// accidentally scoped to Production cannot divert real leads.
function resolveKanooEndpoint() {
  if (!NON_PRODUCTION_ENVS.includes(process.env.VERCEL_ENV)) return PRODUCTION_KANOO_ENDPOINT;

  let url;
  try {
    url = new URL((process.env.KANOO_ENDPOINT || "").trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.$/, "");
  if (!["https:", "http:"].includes(url.protocol) || host === PRODUCTION_KANOO_HOST) return null;
  return url.href;
}

function parseBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (body && typeof body === "object") return body;
  return null;
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pick(body, field) {
  for (const key of FIELD_ALIASES[field]) {
    const value = str(body[key]);
    if (value) return value;
  }
  return "";
}

function isContactUs(body) {
  return CONTACT_US_FIELDS.some((field) =>
    FIELD_ALIASES[field].some((key) => Object.hasOwn(body, key)),
  );
}

// Kanoo expects "{Question}: {Answer}". A select left on its placeholder submits
// the question itself ("Looking For"), which counts as unanswered.
function answer(question, value) {
  if (!value || value.toLowerCase() === question.toLowerCase()) return "";
  return `${question}: ${value}`;
}

function log(level, requestId, event, extra = {}) {
  const line = { timestamp: new Date().toISOString(), requestId, event, ...extra };
  if (level === "error") console.error(line);
  else console.log(line);
}

export default async function handler(req, res) {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const send = (status, body) => res.status(status).json({ ...body, requestId });

  if (!applyCors(req, res)) {
    log("error", requestId, "origin_rejected", { origin: req.headers.origin });
    return send(403, { success: false, message: "Origin not allowed" });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return send(405, { success: false, message: "Method not allowed" });
  }

  const token = process.env.KANOO_TOKEN;
  const db = process.env.KANOO_DB;
  if (!token || !db) {
    log("error", requestId, "config_error", {
      message: "Missing KANOO_TOKEN or KANOO_DB environment variable",
    });
    return send(500, { success: false, message: "Server configuration error" });
  }

  const kanooEndpoint = resolveKanooEndpoint();
  if (!kanooEndpoint) {
    log("error", requestId, "config_error", {
      message: "Preview and Development need KANOO_ENDPOINT set to a non-production endpoint",
      environment: process.env.VERCEL_ENV,
    });
    return send(500, { success: false, message: "Server configuration error" });
  }

  const body = parseBody(req.body);
  if (!body) {
    log("error", requestId, "validation_failed", { reason: "missing or invalid JSON body" });
    return send(400, { success: false, message: "Validation error" });
  }

  const name = pick(body, "name");
  const phoneNumber = pick(body, "phone_number");
  if (!name || !phoneNumber) {
    const missing = [];
    if (!name) missing.push("name");
    if (!phoneNumber) missing.push("phone_number");
    log("error", requestId, "validation_failed", { missing, receivedFields: Object.keys(body) });
    return send(400, { success: false, message: "Validation error" });
  }

  const payload = {
    name,
    email: pick(body, "email"),
    phone_number: phoneNumber,
    campaign_name: str(body.campaign_name),
    adgroup_name: str(body.adgroup_name),
    ad_name: str(body.ad_name),
    housing_support_eligible: str(body.housing_support_eligible),
    is_saudi_citizen: str(body.is_saudi_citizen),
    lead_source: str(body.lead_source) || "Website",
    marketing_tags: str(body.marketing_tags) || "Marketing Leads",
  };

  if (isContactUs(body)) {
    payload.form_name = "Contact Us";
    payload.q_1 = answer("Preferred City", pick(body, "preferred_city"));
    payload.q_2 = [
      answer("Looking For", pick(body, "looking_for")),
      answer("Property Type", pick(body, "property_type")),
    ]
      .filter(Boolean)
      .join(" | ");
  }

  log("info", requestId, "lead_received", {
    payload: {
      name: payload.name,
      phone_number: payload.phone_number,
      email: payload.email,
      campaign_name: payload.campaign_name,
      lead_source: payload.lead_source,
    },
  });

  const startedAt = Date.now();
  let kanooResponse;
  let kanooBody;
  try {
    kanooResponse = await fetch(kanooEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        db,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(KANOO_TIMEOUT_MS),
    });

    const text = await kanooResponse.text();
    try {
      kanooBody = text ? JSON.parse(text) : null;
    } catch {
      kanooBody = text;
    }
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    log("error", requestId, "kanoo_unreachable", {
      durationMs: Date.now() - startedAt,
      timedOut,
      error: error.message,
    });
    return send(timedOut ? 504 : 502, {
      success: false,
      message: timedOut ? "Kanoo API timed out" : "Could not reach Kanoo API",
      details: error.message,
    });
  }

  if (!kanooResponse.ok) {
    log("error", requestId, "kanoo_failure", {
      status: kanooResponse.status,
      durationMs: Date.now() - startedAt,
      response: kanooBody,
    });
    return send(kanooResponse.status, {
      success: false,
      message: "Kanoo API rejected the lead",
      details: kanooBody,
    });
  }

  log("info", requestId, "kanoo_success", {
    status: kanooResponse.status,
    durationMs: Date.now() - startedAt,
  });

  return send(200, {
    success: true,
    message: "Lead submitted successfully",
    data: kanooBody,
  });
}
