import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Keep direct references to the private controls to challenge event guards even
// if a caller could reach them; a real webpage cannot query the closed root.
function fixture({ matched = false } = {}) {
  const controls = new Map();
  const element = () => ({
    value: "parking fees",
    textContent: "",
    classList: { add() {}, remove() {} },
    focus() {},
    select() {},
    remove() {},
  });
  const shadow = {
    querySelector(selector) {
      if (!controls.has(selector)) controls.set(selector, element());
      return controls.get(selector);
    },
  };
  let mode;
  const host = {
    style: {},
    attachShadow(options) {
      mode = options.mode;
      return shadow;
    },
    addEventListener() {},
    remove() {},
  };
  const paragraph = {
    isConnected: true,
    scrollIntoView() {},
    textContent: "A parking fee applies.",
    closest() {
      return null;
    },
    getClientRects() {
      return [{}];
    },
  };
  const messages = [];
  const timers = new Map();
  let timerID = 0;
  const context = {
    Range: class {
      selectNodeContents() {}
    },
    NeedleTextRange() {
      return null;
    },
    matchMedia() {
      return { matches: true };
    },
    document: {
      getElementById() {
        return null;
      },
      createElement() {
        return host;
      },
      documentElement: { append() {} },
      querySelectorAll() {
        return [paragraph];
      },
      addEventListener() {},
      removeEventListener() {},
    },
    getComputedStyle() {
      return { visibility: "visible" };
    },
    setTimeout(fn) {
      timers.set(++timerID, fn);
      return timerID;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return { matches: matched ? [{ id: "b0" }] : [], elapsedMs: 1 };
        },
      },
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"),
    context,
  );
  return {
    controls,
    messages,
    timers,
    mode,
    flush() {
      for (const [id, fn] of timers) {
        timers.delete(id);
        fn();
      }
    },
  };
}
function event(extra = {}) {
  return { isTrusted: false, preventDefault() {}, ...extra };
}
test("page-generated events and UA submit events cannot start extension searches", () => {
  const f = fixture();
  assert.equal(f.mode, "closed");
  f.controls.get("input").oninput(event());
  // execCommand('insertText') can produce trusted input from a page script.
  f.controls.get("input").oninput(event({ isTrusted: true }));
  f.controls.get(".go").onclick(event());
  f.controls.get("input").onkeydown(event({ key: "Enter" }));
  f.controls.get(".search").onsubmit(event());
  // requestSubmit can produce a trusted submit without trusted user input.
  f.controls.get(".search").onsubmit(event({ isTrusted: true }));
  f.flush();
  assert.equal(f.messages.length, 0);
});
test("trusted click and Enter retain search and original extraction", () => {
  for (const activate of [
    (f) => f.controls.get(".go").onclick(event({ isTrusted: true })),
    (f) =>
      f.controls
        .get("input")
        .onkeydown(event({ isTrusted: true, key: "Enter" })),
  ]) {
    const f = fixture();
    activate(f);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].type, "NEEDLE_SEARCH");
    assert.equal(f.messages[0].payload.query, "parking fees");
    assert.equal(
      f.messages[0].payload.blocks[0].text,
      "A parking fee applies.",
    );
  }
});
test("editing, held Enter and IME composition do not spend requests", () => {
  const f = fixture();
  f.controls.get("input").oninput(event({ isTrusted: true }));
  f.controls.get(".close").onclick();
  f.flush();
  for (const extra of [{ repeat: true }, { isComposing: true }])
    f.controls
      .get("input")
      .onkeydown(event({ isTrusted: true, key: "Enter", ...extra }));
  assert.equal(f.messages.length, 0);
});

test("Enter navigates existing results without starting another inference", async () => {
  const f = fixture({ matched: true });
  f.controls.get(".go").onclick(event({ isTrusted: true }));
  await new Promise(setImmediate);
  assert.equal(f.controls.get(".label").textContent, "1 of 1 connection");
  f.controls.get("input").onkeydown(event({ isTrusted: true, key: "Enter" }));
  assert.equal(f.messages.length, 1);
  assert.equal(f.controls.get(".label").textContent, "1 of 1 connection");
});
