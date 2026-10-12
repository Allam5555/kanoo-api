import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/lead.js";

// fetch is replaced before any test runs, so nothing here can reach the real Kanoo API.
const KANOO_URL = "https://pro360api.kanooerp.com/api/zapier/tiktok";
const ENV_KEYS = ["KANOO_TOKEN", "KANOO_DB", "ALLOWED_ORIGINS", "VERCEL_ENV", "KANOO_ENDPOINT"];

let kanooCalls;
let logged;
const saved = {};

before(() => {
  saved.fetch = globalThis.fetch;
  saved.log = console.log;
  saved.error = console.error;
  saved.env = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  globalThis.fetch = async (url, init) => {
    kanooCalls.push({ url, init });
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  console.log = (line) => logged.push(line);
  console.error = (line) => logged.push(line);
  process.env.KANOO_TOKEN = "test-token";
  process.env.KANOO_DB = "test-db";
  delete process.env.ALLOWED_ORIGINS;
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
  logged = [];
  delete process.env.VERCEL_ENV;
  delete process.env.KANOO_ENDPOINT;
});

async function submit(body) {
  const res = {
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
  await handler({ method: "POST", headers: {}, body }, res);
  return res;
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

// Captured from api/lead.js at commit bb38f2c, before Contact Us support existed.
const REGISTER_WIRE_BODY =
  '{"name":"Test Person","email":"test@example.com","phone_number":"+966500000000",' +
  '"campaign_name":"","adgroup_name":"","ad_name":"","housing_support_eligible":"",' +
  '"is_saudi_citizen":"","lead_source":"Website","marketing_tags":"Marketing Leads"}';

describe("Register Your Interest (must match the pre-Contact-Us payload byte for byte)", () => {
  for (const [label, body] of [
    ["as published", REGISTER_YOUR_INTEREST],
    ["with Framer honeypot fields", { ...REGISTER_YOUR_INTEREST, ...FRAMER_HONEYPOTS }],
  ]) {
    test(`sends the unchanged wire body (${label})`, async () => {
      const res = await submit(body);

      assert.equal(res.statusCode, 200);
      assert.equal(kanooCalls.length, 1);
      assert.equal(kanooCalls[0].init.body, REGISTER_WIRE_BODY);
    });
  }

  test("posts to the same Kanoo URL with the same auth headers", async () => {
    await submit(REGISTER_YOUR_INTEREST);

    assert.equal(kanooCalls[0].url, KANOO_URL);
    assert.equal(kanooCalls[0].init.method, "POST");
    assert.deepEqual(kanooCalls[0].init.headers, {
      Authorization: "Bearer test-token",
      db: "test-db",
      "Content-Type": "application/json",
    });
  });

  test("passes canonical snake_case fields through unchanged", async () => {
    await submit({
      name: "Test Person",
      email: "test@example.com",
      phone_number: "+966500000000",
      campaign_name: "Summer Campaign",
      adgroup_name: "Riyadh",
      ad_name: "Video A",
      housing_support_eligible: "yes",
      is_saudi_citizen: "yes",
      lead_source: "Instagram",
      marketing_tags: "VIP",
    });

    assert.equal(
      kanooCalls[0].init.body,
      '{"name":"Test Person","email":"test@example.com","phone_number":"+966500000000",' +
        '"campaign_name":"Summer Campaign","adgroup_name":"Riyadh","ad_name":"Video A",' +
        '"housing_support_eligible":"yes","is_saudi_citizen":"yes","lead_source":"Instagram",' +
        '"marketing_tags":"VIP"}',
    );
  });
});

describe("Contact Us", () => {
  test("maps the published form to form_name, q_1 and q_2", async () => {
    const res = await submit({ ...CONTACT_US, ...FRAMER_HONEYPOTS });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(sentPayload(), {
      name: "Test Person",
      email: "test@example.com",
      phone_number: "+966500000000",
      campaign_name: "",
      adgroup_name: "",
      ad_name: "",
      housing_support_eligible: "",
      is_saudi_citizen: "",
      lead_source: "Website",
      marketing_tags: "Marketing Leads",
      form_name: "Contact Us",
      q_1: "Preferred City: Riyadh",
      q_2: "Looking For: Buy | Property Type: Residential",
    });
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
    Authorization: "Bearer test-token",
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
