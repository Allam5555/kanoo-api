import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import handler from "../api/lead.js";

// fetch is replaced before any test runs, so nothing here can reach the real Kanoo API.
// Kanoo Lead Submission API specification: endpoint, headers and the 12 payload fields.
const KANOO_URL = "https://pro360api.kanooerp.com/api/zapier/Tiktok";
const KANOO_FIELDS = [
  "name",
  "email",
  "phone_number",
  "campaign_name",
  "form_name",
  "ad_name",
  "adset_name",
  "platform",
  "lead_source",
  "marketing_tags",
  "q_1",
  "q_2",
];
const ENV_KEYS = [
  "KANOO_TOKEN",
  "KANOO_DB",
  "ALLOWED_ORIGINS",
  "VERCEL_ENV",
  "KANOO_ENDPOINT",
  "FRAMER_WEBHOOK_SECRET",
];

let kanooCalls;
let kanooReply;
let logged;
const saved = {};

before(() => {
  saved.fetch = globalThis.fetch;
  saved.log = console.log;
  saved.error = console.error;
  saved.env = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  globalThis.fetch = async (url, init) => {
    kanooCalls.push({ url, init });
    return kanooReply();
  };
  console.log = (line) => logged.push(line);
  console.error = (line) => logged.push(line);
});

after(() => {
  globalThis.fetch = saved.fetch;
  console.log = saved.log;
  console.error = saved.error;
  for (const key of ENV_KEYS) {
    if (saved.env[key] === undefined) delete process.env[key];
    else process.env[key] = saved.env[key];
  }
});

beforeEach(() => {
  kanooCalls = [];
  kanooReply = async () =>
    new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  logged = [];
  process.env.KANOO_TOKEN = "test-token";
  process.env.KANOO_DB = "test-db";
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.VERCEL_ENV;
  delete process.env.KANOO_ENDPOINT;
  delete process.env.FRAMER_WEBHOOK_SECRET;
});

function makeResponse() {
  return {
    statusCode: undefined,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function submit(body) {
  const res = makeResponse();
  await handler({ method: "POST", headers: {}, body }, res);
  return res;
}

// Mirrors Vercel's Node helpers: req.body is pre-parsed and the raw bytes are replayed on the stream.
async function deliver({ method = "POST", headers = {}, raw = "", body }) {
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  let parsed = body;
  if (parsed === undefined && raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }
  Object.assign(req, { method, headers, body: parsed });
  const res = makeResponse();
  await handler(req, res);
  return res;
}

const WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";

// Framer's documented scheme: "sha256=" + hex HMAC-SHA256 over the raw body, then the submission ID.
function framerSignature(raw, submissionId, secret = WEBHOOK_SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(raw).update(submissionId).digest("hex");
}

function signedHeaders(raw, submissionId = "sub_test_0001") {
  return {
    "framer-signature": framerSignature(raw, submissionId),
    "framer-webhook-submission-id": submissionId,
  };
}

function sentPayload() {
  assert.equal(kanooCalls.length, 1, "expected exactly one Kanoo request");
  return JSON.parse(kanooCalls[0].init.body);
}

// Field names exactly as the published jewarsa.com forms send them.
const REGISTER_YOUR_INTEREST = {
  Name: "Test Person",
  Email: "test@example.com",
  phone_number: "+966500000000",
};

const CONTACT_US = {
  Name: "Test Person",
  "phone Number": "+966500000000",
  Email: "test@example.com",
  "Preferred City": "Riyadh",
  Location: "Residential",
  "Looking For": "Buy",
};

// Hidden spam-trap inputs Framer renders into both forms.
const FRAMER_HONEYPOTS = { website: "", company: "", message: "", comments: "" };

// The Register Your Interest form's submission as the official 12-field Kanoo payload.
const REGISTER_WIRE_BODY =
  '{"name":"Test Person","email":"test@example.com","phone_number":"+966500000000",' +
  '"campaign_name":"","form_name":"","ad_name":"","adset_name":"","platform":"",' +
  '"lead_source":"Website","marketing_tags":"Marketing Leads","q_1":"","q_2":""}';

describe("Register Your Interest (official Kanoo payload)", () => {
  for (const [label, body] of [
    ["as published", REGISTER_YOUR_INTEREST],
    ["with Framer honeypot fields", { ...REGISTER_YOUR_INTEREST, ...FRAMER_HONEYPOTS }],
  ]) {
    test(`sends the official wire body (${label})`, async () => {
      const res = await submit(body);

      assert.equal(res.statusCode, 200);
      assert.equal(kanooCalls.length, 1);
      assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
    });
  }

  test("posts to the official Kanoo URL with the documented headers", async () => {
    await submit(REGISTER_YOUR_INTEREST);

    assert.equal(kanooCalls[0].url, KANOO_URL);
    assert.equal(kanooCalls[0].init.method, "POST");
    assert.deepEqual(kanooCalls[0].init.headers, {
      apikey: "test-token",
      db: "test-db",
      "Content-Type": "application/json",
    });
  });

  test("passes the official fields through from identically named keys", async () => {
    await submit({
      name: "Test Person",
      email: "test@example.com",
      phone_number: "+966500000000",
      campaign_name: "Summer Campaign",
      form_name: "Landing Page",
      ad_name: "Video A",
      adset_name: "Riyadh",
      platform: "Website",
      lead_source: "Instagram",
      marketing_tags: "VIP",
      q_1: "Budget: 2M",
      q_2: "Timeline: 2027",
    });

    assert.equal(
      kanooCalls[0].init.body,
      '{"name":"Test Person","email":"test@example.com","phone_number":"+966500000000",' +
        '"campaign_name":"Summer Campaign","form_name":"Landing Page","ad_name":"Video A",' +
        '"adset_name":"Riyadh","platform":"Website","lead_source":"Instagram",' +
        '"marketing_tags":"VIP","q_1":"Budget: 2M","q_2":"Timeline: 2027"}',
    );
  });

  test("accepts the former adgroup_name key as adset_name", async () => {
    await submit({ ...REGISTER_YOUR_INTEREST, adgroup_name: "Riyadh" });

    assert.equal(sentPayload().adset_name, "Riyadh");
  });

  test("does not forward fields outside the Kanoo specification", async () => {
    await submit({ ...REGISTER_YOUR_INTEREST, housing_support_eligible: "yes", is_saudi_citizen: "yes" });

    assert.deepEqual(Object.keys(sentPayload()), KANOO_FIELDS);
  });
});

describe("Contact Us", () => {
  test("maps the published form to form_name, q_1 and q_2", async () => {
    const res = await submit({ ...CONTACT_US, ...FRAMER_HONEYPOTS });

    assert.equal(res.statusCode, 200);
    assert.equal(
      kanooCalls[0].init.body,
      '{"name":"Test Person","email":"test@example.com","phone_number":"+966500000000",' +
        '"campaign_name":"","form_name":"Contact Us","ad_name":"","adset_name":"","platform":"",' +
        '"lead_source":"Website","marketing_tags":"Marketing Leads",' +
        '"q_1":"Preferred City: Riyadh","q_2":"Looking For: Buy | Property Type: Residential"}',
    );
  });

  const emptyAnswerCases = [
    {
      label: "blank Preferred City",
      changes: { "Preferred City": "" },
      q_1: "",
      q_2: "Looking For: Buy | Property Type: Residential",
    },
    {
      label: "Preferred City not sent at all",
      changes: { "Preferred City": undefined },
      q_1: "",
      q_2: "Looking For: Buy | Property Type: Residential",
    },
    {
      label: "whitespace-only Preferred City",
      changes: { "Preferred City": "   " },
      q_1: "",
      q_2: "Looking For: Buy | Property Type: Residential",
    },
    {
      label: "blank Looking For",
      changes: { "Looking For": "" },
      q_1: "Preferred City: Riyadh",
      q_2: "Property Type: Residential",
    },
    {
      label: "blank Location",
      changes: { Location: "" },
      q_1: "Preferred City: Riyadh",
      q_2: "Looking For: Buy",
    },
    {
      label: "select placeholders submitted as values",
      changes: { "Looking For": "Looking For", Location: "Property Type" },
      q_1: "Preferred City: Riyadh",
      q_2: "",
    },
    {
      label: "every optional answer blank",
      changes: { "Preferred City": "", "Looking For": "", Location: "" },
      q_1: "",
      q_2: "",
    },
  ];

  for (const { label, changes, q_1, q_2 } of emptyAnswerCases) {
    test(`handles ${label}`, async () => {
      const body = { ...CONTACT_US, ...changes };
      for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];

      const res = await submit(body);

      assert.equal(res.statusCode, 200);
      const payload = sentPayload();
      assert.equal(payload.form_name, "Contact Us");
      assert.equal(payload.q_1, q_1);
      assert.equal(payload.q_2, q_2);
    });
  }

  for (const [label, changes] of [
    ["blank Name", { Name: "" }],
    ["blank phone", { "phone Number": "" }],
  ]) {
    test(`still rejects a submission with ${label} without calling Kanoo`, async () => {
      const res = await submit({ ...CONTACT_US, ...changes });

      assert.equal(res.statusCode, 400);
      assert.equal(kanooCalls.length, 0);
    });
  }
});

describe("Contact Us detection", () => {
  for (const [label, extra] of [
    ["Location", { Location: "Jeddah" }],
    ["Property Type", { "Property Type": "Residential" }],
    ["property_type", { property_type: "Residential" }],
  ]) {
    test(`a ${label} field alone does not turn a lead into Contact Us`, async () => {
      const res = await submit({ ...REGISTER_YOUR_INTEREST, ...extra });

      assert.equal(res.statusCode, 200);
      assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
    });
  }

  for (const [label, fields, q_1, q_2] of [
    ["Preferred City alone", { "Preferred City": "Riyadh" }, "Preferred City: Riyadh", ""],
    ["Looking For alone", { "Looking For": "Rent" }, "", "Looking For: Rent"],
    ["snake_case preferred_city", { preferred_city: "Riyadh" }, "Preferred City: Riyadh", ""],
    [
      "snake_case looking_for with property_type",
      { looking_for: "Buy", property_type: "Commercial" },
      "",
      "Looking For: Buy | Property Type: Commercial",
    ],
  ]) {
    test(`recognises Contact Us from ${label}`, async () => {
      await submit({ ...REGISTER_YOUR_INTEREST, ...fields });

      const payload = sentPayload();
      assert.equal(payload.form_name, "Contact Us");
      assert.equal(payload.q_1, q_1);
      assert.equal(payload.q_2, q_2);
    });
  }
});

describe("Kanoo endpoint selection", () => {
  const CAPTURE_URL = "https://capture.example.test/kanoo";
  const KANOO_HEADERS = {
    apikey: "test-token",
    db: "test-db",
    "Content-Type": "application/json",
  };

  for (const [label, env] of [
    ["VERCEL_ENV unset", {}],
    ["production", { VERCEL_ENV: "production" }],
    ["production with KANOO_ENDPOINT set", { VERCEL_ENV: "production", KANOO_ENDPOINT: CAPTURE_URL }],
  ]) {
    test(`${label}: posts the unchanged request to production Kanoo`, async () => {
      Object.assign(process.env, env);

      const res = await submit(REGISTER_YOUR_INTEREST);

      assert.equal(res.statusCode, 200);
      assert.equal(kanooCalls[0].url, KANOO_URL);
      assert.deepEqual(kanooCalls[0].init.headers, KANOO_HEADERS);
      assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
    });
  }

  const unsafeEndpoints = [
    ["missing", undefined],
    ["blank", "   "],
    ["not a URL", "capture-endpoint"],
    ["the production URL", KANOO_URL],
    ["production with different case and path", "https://PRO360API.KanooERP.com/api/zapier/Tiktok"],
    ["production over http with a port", "http://pro360api.kanooerp.com:443/api/zapier/tiktok"],
    ["production with a trailing-dot host", "https://pro360api.kanooerp.com./api/zapier/tiktok"],
    ["a non-HTTP scheme", "ftp://capture.example.test/kanoo"],
  ];

  for (const environment of ["preview", "development"]) {
    for (const [label, endpoint] of unsafeEndpoints) {
      test(`${environment}: refuses to send when KANOO_ENDPOINT is ${label}`, async () => {
        process.env.VERCEL_ENV = environment;
        if (endpoint !== undefined) process.env.KANOO_ENDPOINT = endpoint;

        const res = await submit(REGISTER_YOUR_INTEREST);

        assert.equal(res.statusCode, 500);
        assert.equal(res.body.message, "Server configuration error");
        assert.equal(kanooCalls.length, 0);
      });
    }
  }

  for (const [environment, endpoint] of [
    ["preview", CAPTURE_URL],
    ["development", "http://localhost:4000/kanoo"],
  ]) {
    test(`${environment}: sends the unchanged request to an explicit non-production endpoint`, async () => {
      process.env.VERCEL_ENV = environment;
      process.env.KANOO_ENDPOINT = endpoint;

      const res = await submit(REGISTER_YOUR_INTEREST);

      assert.equal(res.statusCode, 200);
      assert.equal(kanooCalls[0].url, endpoint);
      assert.deepEqual(kanooCalls[0].init.headers, KANOO_HEADERS);
      assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
    });
  }

  test("logs a refusal without credentials or submitter details", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.KANOO_ENDPOINT = KANOO_URL;

    await submit(REGISTER_YOUR_INTEREST);

    const output = JSON.stringify(logged);
    assert.match(output, /config_error/);
    for (const value of ["test-token", "test-db", "Test Person", "test@example.com", "+966500000000"]) {
      assert.ok(!output.includes(value), `log contains ${value}`);
    }
  });
});

describe("Origin handling without FRAMER_WEBHOOK_SECRET (unchanged behaviour)", () => {
  const JEWAR = "https://www.jewarsa.com";

  test("OPTIONS with an allowed Origin returns 204 and echoes that origin", async () => {
    process.env.ALLOWED_ORIGINS = JEWAR;

    const res = await deliver({ method: "OPTIONS", headers: { origin: JEWAR } });

    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["Access-Control-Allow-Origin"], JEWAR);
    assert.equal(res.headers.Vary, "Origin");
  });

  test("OPTIONS without Origin is rejected when ALLOWED_ORIGINS is set", async () => {
    process.env.ALLOWED_ORIGINS = JEWAR;

    const res = await deliver({ method: "OPTIONS" });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, "Origin not allowed");
  });

  test("OPTIONS is open to any origin when ALLOWED_ORIGINS is unset", async () => {
    const res = await deliver({ method: "OPTIONS" });

    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  });

  test("POST with an allowed Origin sends the unchanged Register payload", async () => {
    process.env.ALLOWED_ORIGINS = JEWAR;

    const res = await deliver({ headers: { origin: JEWAR }, body: REGISTER_YOUR_INTEREST });

    assert.equal(res.statusCode, 200);
    assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
  });

  test("POST without Origin is rejected before Kanoo when ALLOWED_ORIGINS is set", async () => {
    process.env.ALLOWED_ORIGINS = JEWAR;

    const res = await deliver({ body: REGISTER_YOUR_INTEREST });

    assert.equal(res.statusCode, 403);
    assert.equal(kanooCalls.length, 0);
  });

  for (const origin of ["https://jewarsa.com", "http://www.jewarsa.com", `${JEWAR}/`, "https://evil.example"]) {
    test(`POST from ${origin} is rejected before Kanoo`, async () => {
      process.env.ALLOWED_ORIGINS = JEWAR;

      const res = await deliver({ headers: { origin }, body: REGISTER_YOUR_INTEREST });

      assert.equal(res.statusCode, 403);
      assert.equal(kanooCalls.length, 0);
    });
  }
});

describe("Framer webhook signature (FRAMER_WEBHOOK_SECRET set)", () => {
  const JEWAR = "https://www.jewarsa.com";
  const REGISTER_RAW = JSON.stringify(REGISTER_YOUR_INTEREST);
  const CONTACT_US_RAW = JSON.stringify(CONTACT_US);

  beforeEach(() => {
    process.env.FRAMER_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.ALLOWED_ORIGINS = JEWAR;
  });

  test("accepts Framer's documented HMAC (known-answer vector computed with openssl)", async () => {
    const res = await deliver({
      raw: REGISTER_RAW,
      headers: {
        "framer-signature": "sha256=c55658033c539f47146de70f814b9d0a0d6d1321d2415aea873e8fb9cd472c59",
        "framer-webhook-submission-id": "sub_test_0001",
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
  });

  test("accepts a signed Register submission without an Origin header", async () => {
    const res = await deliver({ raw: REGISTER_RAW, headers: signedHeaders(REGISTER_RAW) });

    assert.equal(res.statusCode, 200);
    assert.equal(kanooCalls[0].url, KANOO_URL);
    assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
  });

  test("accepts a signed request that also carries an Origin header", async () => {
    const res = await deliver({
      raw: REGISTER_RAW,
      headers: { ...signedHeaders(REGISTER_RAW), origin: "https://anything.example" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
  });

  test("maps a signed Contact Us submission", async () => {
    const res = await deliver({ raw: CONTACT_US_RAW, headers: signedHeaders(CONTACT_US_RAW) });

    assert.equal(res.statusCode, 200);
    const payload = sentPayload();
    assert.equal(payload.phone_number, "+966500000000");
    assert.equal(payload.form_name, "Contact Us");
    assert.equal(payload.q_1, "Preferred City: Riyadh");
    assert.equal(payload.q_2, "Looking For: Buy | Property Type: Residential");
  });

  test("forwards the verified raw body, not a separately parsed req.body", async () => {
    const res = await deliver({
      raw: REGISTER_RAW,
      headers: signedHeaders(REGISTER_RAW),
      body: { Name: "Someone Else", phone_number: "+966511111111" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
  });

  const valid = signedHeaders(REGISTER_RAW);
  const rejected = [
    ["no signature headers", REGISTER_RAW, {}],
    ["Framer-Signature missing", REGISTER_RAW, { "framer-webhook-submission-id": "sub_test_0001" }],
    ["submission ID missing", REGISTER_RAW, { "framer-signature": valid["framer-signature"] }],
    [
      "an empty submission ID",
      REGISTER_RAW,
      {
        "framer-signature": framerSignature(REGISTER_RAW, ""),
        "framer-webhook-submission-id": "",
      },
    ],
    [
      "a different secret",
      REGISTER_RAW,
      {
        "framer-signature": framerSignature(REGISTER_RAW, "sub_test_0001", "another-secret-0123456789abcdefgh"),
        "framer-webhook-submission-id": "sub_test_0001",
      },
    ],
    ["a body changed after signing", REGISTER_RAW.replace("Test Person", "Mallory"), valid],
    ["a submission ID changed after signing", REGISTER_RAW, { ...valid, "framer-webhook-submission-id": "sub_test_0002" }],
    [
      "a signature over the body only",
      REGISTER_RAW,
      {
        "framer-signature": "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(REGISTER_RAW).digest("hex"),
        "framer-webhook-submission-id": "sub_test_0001",
      },
    ],
    ["no sha256= prefix", REGISTER_RAW, { ...valid, "framer-signature": valid["framer-signature"].slice(7) }],
    ["a truncated signature", REGISTER_RAW, { ...valid, "framer-signature": valid["framer-signature"].slice(0, 70) }],
    ["non-ASCII characters", REGISTER_RAW, { ...valid, "framer-signature": "sha256=" + "é".repeat(64) }],
  ];

  for (const [label, raw, headers] of rejected) {
    test(`rejects ${label} with 401 before Kanoo`, async () => {
      const res = await deliver({ raw, headers });

      assert.equal(res.statusCode, 401);
      assert.equal(res.body.message, "Invalid signature");
      assert.equal(kanooCalls.length, 0);
    });
  }

  test("rejects an unsigned POST even from an allowed Origin", async () => {
    const res = await deliver({ raw: REGISTER_RAW, headers: { origin: JEWAR } });

    assert.equal(res.statusCode, 401);
    assert.equal(kanooCalls.length, 0);
  });

  test("leaves OPTIONS governed by ALLOWED_ORIGINS", async () => {
    const allowed = await deliver({ method: "OPTIONS", headers: { origin: JEWAR } });
    const missing = await deliver({ method: "OPTIONS" });

    assert.equal(allowed.statusCode, 204);
    assert.equal(missing.statusCode, 403);
  });

  for (const [label, raw] of [
    ["an empty JSON object", "{}"],
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
  ]) {
    test(`rejects a correctly signed request with ${label} before Kanoo`, async () => {
      const res = await deliver({ raw, headers: signedHeaders(raw) });

      assert.equal(res.statusCode, 400);
      assert.equal(kanooCalls.length, 0);
    });
  }

  test("logs a signature rejection without the secret, signature or submitter details", async () => {
    await deliver({ raw: REGISTER_RAW, headers: { ...valid, "framer-webhook-submission-id": "sub_tampered" } });

    const output = JSON.stringify(logged);
    assert.match(output, /signature_rejected/);
    for (const value of [WEBHOOK_SECRET, valid["framer-signature"], "Test Person", "test@example.com", "+966500000000"]) {
      assert.ok(!output.includes(value), `log contains ${value}`);
    }
  });
});

describe("Configuration and payload errors", () => {
  for (const key of ["KANOO_TOKEN", "KANOO_DB"]) {
    test(`returns 500 without calling Kanoo when ${key} is missing`, async () => {
      delete process.env[key];

      const res = await submit(REGISTER_YOUR_INTEREST);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.message, "Server configuration error");
      assert.equal(kanooCalls.length, 0);
    });
  }

  test("returns 500 for a correctly signed request when credentials are missing", async () => {
    process.env.FRAMER_WEBHOOK_SECRET = WEBHOOK_SECRET;
    delete process.env.KANOO_TOKEN;
    const raw = JSON.stringify(REGISTER_YOUR_INTEREST);

    const res = await deliver({ raw, headers: signedHeaders(raw) });

    assert.equal(res.statusCode, 500);
    assert.equal(kanooCalls.length, 0);
  });

  test("rejects a body that is not JSON without calling Kanoo", async () => {
    const res = await submit("{not json");

    assert.equal(res.statusCode, 400);
    assert.equal(kanooCalls.length, 0);
  });
});

describe("Log privacy", () => {
  const SENSITIVE = [
    "Test Person",
    "test@example.com",
    "+966500000000",
    "Riyadh",
    "Residential",
    "test-token",
    "test-db",
    "KANOO_DETAIL_MARKER",
  ];

  function assertLogsAreClean() {
    const output = JSON.stringify(logged);
    for (const value of SENSITIVE) {
      assert.ok(!output.includes(value), `log contains ${value}`);
    }
  }

  function logEntry(event) {
    const entry = logged.find((line) => line.event === event);
    assert.ok(entry, `no ${event} log entry`);
    return entry;
  }

  test("lead_received records the form and field names, not the lead's details", async () => {
    await submit(CONTACT_US);

    const entry = logEntry("lead_received");
    assert.equal(entry.form_name, "Contact Us");
    assert.deepEqual(entry.receivedFields, Object.keys(CONTACT_US));
    assertLogsAreClean();
  });

  test("lead_received for Register Your Interest carries no personal data", async () => {
    await submit(REGISTER_YOUR_INTEREST);

    assert.equal(logEntry("lead_received").form_name, null);
    assertLogsAreClean();
  });

  test("kanoo_failure records status and category, never Kanoo's response body", async () => {
    kanooReply = async () =>
      new Response(JSON.stringify({ message: "KANOO_DETAIL_MARKER", echo: CONTACT_US }), { status: 422 });

    await submit(CONTACT_US);

    const entry = logEntry("kanoo_failure");
    assert.equal(entry.status, 422);
    assert.equal(entry.category, "upstream_rejected");
    assert.deepEqual(entry.responseKeys, ["message", "echo"]);
    assertLogsAreClean();
  });

  test("kanoo_failure categorises an upstream server error with a non-JSON body", async () => {
    kanooReply = async () => new Response("KANOO_DETAIL_MARKER for +966500000000", { status: 503 });

    await submit(REGISTER_YOUR_INTEREST);

    const entry = logEntry("kanoo_failure");
    assert.equal(entry.status, 503);
    assert.equal(entry.category, "upstream_server_error");
    assert.equal(entry.responseKeys, undefined);
    assertLogsAreClean();
  });

  test("kanoo_unreachable records a category and error code, never the raw error message", async () => {
    kanooReply = async () => {
      throw Object.assign(new TypeError("KANOO_DETAIL_MARKER Test Person +966500000000"), {
        cause: { code: "ECONNRESET" },
      });
    };

    await submit(REGISTER_YOUR_INTEREST);

    const entry = logEntry("kanoo_unreachable");
    assert.equal(entry.category, "network_error");
    assert.equal(entry.errorCode, "ECONNRESET");
    assertLogsAreClean();
  });

  test("kanoo_unreachable categorises a timeout", async () => {
    kanooReply = async () => {
      throw new DOMException("KANOO_DETAIL_MARKER", "TimeoutError");
    };

    await submit(REGISTER_YOUR_INTEREST);

    const entry = logEntry("kanoo_unreachable");
    assert.equal(entry.category, "timeout");
    assert.equal(entry.timedOut, true);
    assertLogsAreClean();
  });

  test("validation_failed lists field names only", async () => {
    await submit({ ...CONTACT_US, Name: "" });

    assert.deepEqual(logEntry("validation_failed").missing, ["name"]);
    assertLogsAreClean();
  });
});

describe("Kanoo specification contract", () => {
  for (const [label, body] of [
    ["Register Your Interest", REGISTER_YOUR_INTEREST],
    ["Contact Us", CONTACT_US],
    ["Contact Us with every answer blank", { ...CONTACT_US, "Preferred City": "", "Looking For": "", Location: "" }],
    ["a submission with unrelated extra keys", { ...REGISTER_YOUR_INTEREST, ...FRAMER_HONEYPOTS, foo: "bar" }],
  ]) {
    test(`sends exactly the 12 official fields in order for ${label}`, async () => {
      await submit(body);

      const payload = sentPayload();
      assert.deepEqual(Object.keys(payload), KANOO_FIELDS);
      for (const field of KANOO_FIELDS) assert.equal(typeof payload[field], "string", field);
    });
  }

  test("forwards Kanoo's rejection status to the caller", async () => {
    kanooReply = async () => new Response(JSON.stringify({ message: "rejected" }), { status: 422 });

    const res = await submit(REGISTER_YOUR_INTEREST);

    assert.equal(res.statusCode, 422);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, "Kanoo API rejected the lead");
  });

  test("returns 502 when Kanoo cannot be reached", async () => {
    kanooReply = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };

    const res = await submit(REGISTER_YOUR_INTEREST);

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.message, "Could not reach Kanoo API");
  });

  test("returns 504 when Kanoo times out", async () => {
    kanooReply = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };

    const res = await submit(REGISTER_YOUR_INTEREST);

    assert.equal(res.statusCode, 504);
    assert.equal(res.body.message, "Kanoo API timed out");
  });
});
