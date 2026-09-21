import test from "node:test";
import assert from "node:assert/strict";
import { accessError } from "../server/http.mjs";
import handler from "../api/search.js";
const headers = {
  "content-type": "application/json",
  "x-needle-token": "app-token",
};
function response() {
  return {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(n) {
      this.code = n;
      return this;
    },
    json(data) {
      this.body = data;
    },
  };
}
test("all backends require an explicit access token", () => {
  for (const env of [{}, { VERCEL: "1" }, { NEEDLE_ACCESS_TOKEN: "  " }])
    assert.equal(accessError(headers, env).status, 503);
  for (const env of [
    { NEEDLE_ACCESS_TOKEN: "app-token" },
    { VERCEL: "1", NEEDLE_ACCESS_TOKEN: "app-token" },
  ]) {
    assert.equal(accessError({}, env).status, 401);
    assert.equal(
      accessError({ ...headers, "x-needle-token": "wrong" }, env).status,
      401,
    );
    assert.equal(accessError(headers, env), null);
  }
});
test("rejects simple request formats and lookalikes, accepts JSON parameters", () => {
  const env = { NEEDLE_ACCESS_TOKEN: "app-token" };
  for (const type of [
    undefined,
    "",
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "application/jsonp",
    "application/json,text/plain",
  ])
    assert.equal(
      accessError({ ...headers, "content-type": type }, env).status,
      415,
    );
  assert.equal(
    accessError(
      { ...headers, "content-type": "Application/JSON; charset=utf-8" },
      env,
    ),
    null,
  );
});
test("API rejects methods, including CORS preflight, before inference", async () => {
  for (const method of ["GET", "OPTIONS", "PUT"]) {
    const res = response();
    await handler({ method, headers: {} }, res);
    assert.equal(res.code, 405);
    assert.equal(res.headers.Allow, "POST");
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  }
});
test("API blocks unauthorized requests without upstream calls and preserves local/Vercel JSON bodies", async () => {
  const names = [
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_KEY_FILE",
    "NEEDLE_ACCESS_TOKEN",
    "VERCEL",
  ];
  const old = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  const oldFetch = globalThis.fetch;
  let calls = 0;
  process.env.AI_GATEWAY_API_KEY = "dummy-review-key";
  process.env.AI_GATEWAY_KEY_FILE = "";
  process.env.NEEDLE_ACCESS_TOKEN = "app-token";
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/evaluate");
    assert.equal(options.headers.Authorization, "Bearer dummy-review-key");
    return {
      ok: true,
      json: async () => ({ answers: { b0: { probability: 0.9 } } }),
    };
  };
  const body = {
    query: "fees",
    blocks: [{ id: "b0", text: "A parking fee applies." }],
  };
  try {
    for (const [requestHeaders, expected] of [
      [
        { "content-type": "text/plain", origin: "https://untrusted.example" },
        401,
      ],
      [{ ...headers, "x-needle-token": "wrong" }, 401],
      [{ ...headers, "content-type": "text/plain" }, 415],
      [
        { ...headers, "content-type": "application/x-www-form-urlencoded" },
        415,
      ],
    ]) {
      const res = response();
      await handler(
        { method: "POST", headers: requestHeaders, body: JSON.stringify(body) },
        res,
      );
      assert.equal(res.code, expected);
    }
    assert.equal(calls, 0);
    for (const vercel of ["", "1"]) {
      process.env.VERCEL = vercel;
      for (const requestBody of [body, JSON.stringify(body)]) {
        const res = response();
        await handler({ method: "POST", headers, body: requestBody }, res);
        assert.equal(res.code, 200);
        assert.equal(res.body.matches[0].focus.text, body.blocks[0].text);
      }
    }
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
