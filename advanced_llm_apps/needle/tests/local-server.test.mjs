import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { once } from "node:events";

test("real local HTTP server rejects cross-origin simple requests before mocked inference", async () => {
  // A fresh cwd prevents the server from loading the developer's .env.
  const cwd = await mkdtemp(join(tmpdir(), "needle-http-test-"));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const mock = join(cwd, "mock.mjs");
  await writeFile(
    mock,
    `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url, options) => {
      if (url !== "https://ai-gateway.vercel.sh/v1/evaluate" || options.headers.Authorization !== "Bearer dummy-key") throw new Error("Unexpected upstream request");
      appendFileSync("calls", "mock-call\\n");
      return { ok: true, json: async () => ({ answers: { b0: { probability: 0.9 } } }) };
    };
  `,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      mock,
      fileURLToPath(new URL("../server/dev.mjs", import.meta.url)),
      "--production",
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        AI_GATEWAY_API_KEY: "dummy-key",
        NEEDLE_ACCESS_TOKEN: "test-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Test server startup timed out")),
        5000,
      );
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("Needle running")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Test server exited: ${code}`));
      });
    });
    const url = `http://127.0.0.1:${port}/api/search`;
    const body = JSON.stringify({
      query: "fees",
      blocks: [{ id: "b0", text: "A parking fee applies." }],
    });
    const headers = {
      "x-needle-token": "test-token",
      "content-type": "application/json",
    };
    for (const [requestHeaders, expected] of [
      [
        { "content-type": "text/plain", origin: "https://untrusted.example" },
        401,
      ],
      [{ "content-type": "application/x-www-form-urlencoded" }, 401],
      [{ ...headers, "x-needle-token": "wrong" }, 401],
      [{ ...headers, "content-type": "text/plain" }, 415],
    ]) {
      const res = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body,
      });
      assert.equal(res.status, expected);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      await res.text();
    }
    await assert.rejects(readFile(join(cwd, "calls")), { code: "ENOENT" });
    const options = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-needle-token",
      },
    });
    assert.equal(options.status, 405);
    const result = await fetch(url, { method: "POST", headers, body });
    assert.equal(result.status, 200);
    assert.equal(
      (await result.json()).matches[0].focus.text,
      "A parking fee applies.",
    );
    assert.equal(await readFile(join(cwd, "calls"), "utf8"), "mock-call\n");
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(cwd, { recursive: true, force: true });
  }
});
