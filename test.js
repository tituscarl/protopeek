// Loads panel.js under node with the chrome/DOM bits stubbed, then feeds it a
// hand-encoded gRPC-Web call and checks the decoder and search. Run: node test.js
"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const els = new Map();
const el = (id) => {
  if (!els.has(id)) els.set(id, {
    listeners: {}, addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    contains: () => true, appendChild() {}, remove() {}, click() {}, setAttribute() {},
    querySelectorAll(sel) { return sel === "mark" ? (this.innerHTML.match(/<mark>/g) || []) : []; },
    querySelector(sel) {
      if (sel !== "mark" || !this.innerHTML.includes("<mark>")) return null;
      this.scrolled = (this.scrolled || 0);
      return { scrollIntoView: () => { this.scrolled++; } };
    },
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect: () => ({ width: 300 }),
    innerHTML: "", textContent: "", className: "", value: "", hidden: false,
  });
  return els.get(id);
};
let nextLi = 0;
const ctx = vm.createContext({
  console, TextDecoder, TextEncoder, URL, atob, btoa, setTimeout, clearTimeout,
  document: { getElementById: el, createElement: () => el("li" + nextLi++), body: { style: {} }, addEventListener() {} },
  window: { addEventListener() {}, innerWidth: 1200 },
  chrome: { storage: { local: { get() {}, set() {}, remove() {} } },
            devtools: { network: { onRequestFinished: { addListener() {} } } } },
});
const p = vm.runInContext(
  fs.readFileSync(__dirname + "/panel.js", "utf8") +
  ";({ handleRequest, calls, entryMatches, readVarint, zigzag, decodeMessage, parseFileDescriptorSet, buildSchemaIndex, setSelection, renderDetail, openNode, lazyBodies, scrollToFirstMatch, applySearch," +
  " setQuery: (q) => { searchQuery = q; }, setListQuery: (q) => { listQuery = q; }, setSchema: (s) => { schema = s; invalidateSearch(); } })",
  ctx);

// --- tiny protobuf / gRPC-Web encoder
const enc = new TextEncoder();
const varint = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return o; };
const field = (num, wt, payload) => [...varint(num * 8 + wt), ...payload];
const vi = (num, n) => field(num, 0, varint(n));
const ld = (num, bytes) => field(num, 2, [...varint(bytes.length), ...bytes]);
const str = (num, s) => ld(num, [...enc.encode(s)]);
const frame = (flag, payload) => [flag, (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff, ...payload];
const latin1 = (bytes) => String.fromCharCode(...bytes);

// message { 1: 150, 2: "hello", 3: { 1: 42 }, 4: { 1: { 1: { 1: 7 } } } }
const msg = [...vi(1, 150), ...str(2, "hello"), ...ld(3, vi(1, 42)), ...ld(4, ld(1, ld(1, vi(1, 7))))];
const reqBody = frame(0, msg);
const resBody = [...frame(0, msg), ...frame(0x80, [...enc.encode("grpc-status: 0\r\n")])];

// FileDescriptorSet: package pkg; message Req { int32 user_id = 1; } service Svc { rpc Do(Req) returns (Req); }
const fds = ld(1, [
  ...str(1, "t.proto"), ...str(2, "pkg"),
  ...ld(4, [...str(1, "Req"), ...ld(2, [...str(1, "user_id"), ...vi(3, 1), ...vi(5, 5)])]),
  ...ld(6, [...str(1, "Svc"), ...ld(2, [...str(1, "Do"), ...str(2, ".pkg.Req"), ...str(3, ".pkg.Req")])]),
]);

// --- varint fast path and BigInt fallback
assert.strictEqual(p.readVarint(Uint8Array.of(0x96, 0x01), 0).value, 150);
assert.strictEqual(p.readVarint(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01), 0).value, 2 ** 42);
assert.strictEqual(p.readVarint(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01), 0).value, 2n ** 49n);
assert.strictEqual(p.readVarint(new Uint8Array([...Array(9).fill(0xff), 0x01]), 0).value, 2n ** 64n - 1n);
assert.throws(() => p.readVarint(Uint8Array.of(0x80, 0x80), 0));
assert.strictEqual(p.zigzag(1), -1);
assert.strictEqual(p.zigzag(2), 1);
assert.strictEqual(p.zigzag(4294967295), -2147483648);
assert.strictEqual(p.zigzag(3n), -2n);
// a tag that only fits in a BigInt is garbage, not a field
assert.strictEqual(p.decodeMessage(new Uint8Array([...Array(8).fill(0xff), 0x01]), true), null);

// --- capture a call
const hdr = [{ name: "content-type", value: "application/grpc-web+proto" }];
p.handleRequest({
  request: { url: "https://x.test/pkg.Svc/Do", headers: hdr, postData: { text: latin1(reqBody) } },
  response: { status: 200, statusText: "OK", headers: hdr },
  time: 12, startedDateTime: new Date().toISOString(),
  getContent: (cb) => cb(Buffer.from(resBody).toString("base64"), "base64"),
});
const e = p.calls[0];
assert.strictEqual(e.reqFrames.length, 1);
assert.strictEqual(e.resFrames.length, 1);
assert.strictEqual(e.grpcStatus, "0");
assert.ok(el("li0").innerHTML.includes("1 frame"), "list row shows response frame count");
p.setSelection(e.id); p.renderDetail();
assert.ok(el("detail").innerHTML.includes("Response · 1 data frame<"), "detail header shows frame count");

// --- schema-less search: numbers, nested numbers, strings, field tags
assert.ok(p.entryMatches(e, "150"), "top-level varint value");
assert.ok(p.entryMatches(e, "42"), "nested varint value");
assert.ok(p.entryMatches(e, "hello"), "string value");
assert.ok(p.entryMatches(e, "#3"), "field tag");
assert.ok(!p.entryMatches(e, "user_id"), "no names without a schema");
assert.ok(!p.entryMatches(e, "zzz"));
assert.ok(e._ranges.get(e.reqFrames[0]), "frame span recorded");

// --- auto-open + highlight come from the same index
const detail = el("detail");
p.setSelection(e.id);
p.setQuery("42"); p.renderDetail();
assert.ok(detail.innerHTML.includes('<details class="frame" open'), "matching frame auto-opens");
assert.ok(detail.innerHTML.includes("<mark>42</mark>"), "matched number is highlighted");
assert.ok(/^\d+ match(es)?$/.test(el("match-count").textContent), "match counter set: " + el("match-count").textContent);
p.scrollToFirstMatch();
assert.strictEqual(detail.scrolled, 1, "scrolled to first mark");
p.setQuery("zzz"); p.renderDetail();
assert.ok(!detail.innerHTML.includes('<details class="frame" open'), "no match, frames stay closed");
assert.strictEqual(el("match-count").textContent, "0 matches", "counter shows zero for a non-matching call");
p.scrollToFirstMatch(); // no marks -> no scroll
assert.strictEqual(detail.scrolled, 1, "no scroll without a match");
p.setQuery(""); p.renderDetail();
assert.strictEqual(el("match-count").textContent, "", "counter clears with the query");

// --- expand all / collapse all
// The pump walks the real DOM, which this stub doesn't have, so drive
// openNode over lazyBodies directly — the same thing the pump does for each
// closed <details> it finds.
const click = (action) => detail.listeners.click.forEach((fn) =>
  fn({ target: { closest: (sel) => sel === "button[data-action]" ? { dataset: { action }, textContent: "" } : null } }));
const fakeEl = (key) => ({
  attrs: { "data-key": key, "data-default": "closed", "data-lazy": key },
  getAttribute(k) { return this.attrs[k] ?? null; },
  insertAdjacentHTML(_, html) { this.injected = html; },
  open: false,
});
assert.ok(detail.innerHTML.includes("data-lazy="), "frames start collapsed and deferred");
const frameEl = fakeEl(e.id + ".req-0-frame");
p.openNode(frameEl);
assert.ok(frameEl.open, "openNode flips the node open");
assert.ok(frameEl.injected.includes("field-val-num"), "deferred body injected on open");
let guard = 20;
while (p.lazyBodies.size && guard--) {
  for (const key of [...p.lazyBodies.keys()]) p.openNode(fakeEl(key));
}
assert.ok(guard > 0, "lazy queue drained");
p.renderDetail();
assert.ok(!detail.innerHTML.includes("data-lazy="), "fully expanded tree survives re-render");
assert.ok(detail.innerHTML.includes('<details class="frame" open'), "frames open");
assert.ok(detail.innerHTML.includes(">7<"), "deepest value rendered");
click("expand"); // smoke: pump runs against the stub DOM and finishes without scheduling
click("collapse");
assert.ok(!detail.innerHTML.includes('<details class="frame" open'), "frames closed again");

// --- schema-aware search: field names and message names
p.setSchema(p.buildSchemaIndex(p.parseFileDescriptorSet(new Uint8Array(fds))));
assert.ok(p.entryMatches(e, "user_id"), "field name from schema");
assert.ok(p.entryMatches(e, "req"), "message name from schema");
assert.ok(p.entryMatches(e, "150"), "typed int32 value");
assert.ok(p.entryMatches(e, "hello"), "unknown field still falls back to heuristic");
p.setQuery("user_id"); p.renderDetail();
assert.ok(detail.innerHTML.includes("<mark>user_id</mark>"));

// --- no index cap: a value deep in a large payload is still searchable
const big = [];
for (let i = 0; i < 2200; i++) big.push(...str(1, "filler ".repeat(22)));
big.push(...str(2, "BILL-00000000-000002"), ...str(3, "0A0A"));
p.handleRequest({
  request: { url: "https://x.test/other.Svc/Do", headers: hdr, postData: null },
  response: { status: 200, statusText: "OK", headers: hdr },
  time: 1, startedDateTime: new Date().toISOString(),
  getContent: (cb) => cb(Buffer.from(frame(0, big)).toString("base64"), "base64"),
});
const bigCall = p.calls[p.calls.length - 1];
assert.ok(p.entryMatches(bigCall, "BILL-00000000-000002"), "match ~330KB deep is found");
// ambiguous bytes: "0A0A" parses as a valid message AND reads as text — both
// interpretations must be searchable
assert.ok(p.entryMatches(bigCall, "0A0A"), "string reading of an ambiguous field is indexed");

// --- huge frames render bounded: child paging + long-string windowing
const huge = [];
for (let i = 0; i < 600; i++) huge.push(...vi(1, 1000 + i));
huge.push(...str(2, "needle-xyz-string"), ...str(3, "start " + "pad ".repeat(200) + "deepneedle end"));
p.handleRequest({
  request: { url: "https://x.test/huge.Svc/Do", headers: hdr, postData: null },
  response: { status: 200, statusText: "OK", headers: hdr },
  time: 1, startedDateTime: new Date().toISOString(),
  getContent: (cb) => cb(Buffer.from(frame(0, huge)).toString("base64"), "base64"),
});
const hugeCall = p.calls[p.calls.length - 1];
const clickToggle = (attrs) => detail.listeners.click.forEach((fn) => fn({
  target: { closest: (sel) => sel === ".toggle" ? { getAttribute: (a) => attrs[a] ?? null } : null },
  stopPropagation() {}, preventDefault() {},
}));

// no query: an opened frame pages its 602 children
p.setQuery(""); p.setSelection(hugeCall.id); p.renderDetail();
const hugeFrame = fakeEl(hugeCall.id + ".req-0-frame");
hugeFrame.attrs["data-key"] = hugeCall.id + ".res-0-frame";
hugeFrame.attrs["data-lazy"] = hugeCall.id + ".res-0-frame";
p.openNode(hugeFrame);
assert.ok(hugeFrame.injected.includes("of 402 hidden"), "children beyond the page hide behind a stub");
assert.ok(!hugeFrame.injected.includes(">1399<"), "page 2 values not materialized");

// a match beyond the page still renders, with the gap marked
p.setQuery("needle-xyz"); p.renderDetail();
assert.ok(detail.innerHTML.includes("<mark>needle-xyz</mark>"), "match on page 4 is visible");
assert.ok(detail.innerHTML.includes("fields skipped"), "gap before the match is marked");

// long strings render a window centered on the match, with a [full] toggle
p.setQuery("deepneedle"); p.renderDetail();
assert.ok(detail.innerHTML.includes("<mark>deepneedle</mark>"), "match inside a long string stays visible");
assert.ok(detail.innerHTML.includes("[full]"), "long string offers the full toggle");
assert.ok(!detail.innerHTML.includes('"start '), "window drops the far-away prefix");
clickToggle({ "data-key": hugeCall.id + ".res-0.601:str", "data-to": "full" });
assert.ok(detail.innerHTML.includes("start "), "[full] reveals the whole string");

// [show more] pages in the next chunk
assert.ok(!detail.innerHTML.includes(">1399<"), "value on page 2 hidden before paging");
clickToggle({ "data-page": hugeCall.id + ".res-0:" });
assert.ok(detail.innerHTML.includes(">1399<"), "paging reveals the next chunk");

// --- frame paging: a 300-frame stream renders bounded, opens capped on broad queries
const streamBody = [];
for (let i = 0; i < 300; i++) streamBody.push(...frame(0, str(1, "itemvalue" + i)));
p.handleRequest({
  request: { url: "https://x.test/stream.Svc/Watch", headers: hdr, postData: null },
  response: { status: 200, statusText: "OK", headers: hdr },
  time: 1, startedDateTime: new Date().toISOString(),
  getContent: (cb) => cb(Buffer.from(streamBody).toString("base64"), "base64"),
});
const streamCall = p.calls[p.calls.length - 1];
p.setQuery(""); p.setSelection(streamCall.id); p.renderDetail();
assert.strictEqual((detail.innerHTML.match(/data frame #/g) || []).length, 100, "frames page at 100");
assert.ok(detail.innerHTML.includes("[show 100 more of 200 hidden]"), "frame paging stub");
p.setQuery("itemvalue"); p.renderDetail();
assert.strictEqual((detail.innerHTML.match(/<details class="frame" open/g) || []).length, 25,
  "broad query opens only the hit budget");
assert.ok(detail.innerHTML.includes("[show 100 more of 200 hidden]"),
  "matching frames past the budget stay behind the paging stub");
assert.strictEqual(el("match-count").textContent, "300 matches", "counter reports index hits, not rendered marks");
p.setQuery("");

// --- chunked row filtering: an uncached row resolves off the keystroke
bigCall._payloadText = null; // force a fresh index build
p.setListQuery("BILL-00000000-000002");
p.applySearch();
assert.strictEqual(el("li1").hidden, false, "uncached row keeps its old state until its chunk runs");
setTimeout(() => {
  assert.strictEqual(el("li0").hidden, true, "non-matching row hidden");
  assert.strictEqual(el("li1").hidden, false, "big call resolved as a match after chunking");
  console.log("ok");
}, 50);
