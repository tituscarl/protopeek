"use strict";

const calls = [];
const liById = new Map();
let nextId = 1;
let selectedId = null;
let detailToggles = {};
const userCollapsed = new Set(); // overrides default-open
const userExpanded = new Set();  // overrides default-closed
let expandGen = 0;               // bumped on every render / click to cancel an in-flight expand-all pump
let searchQuery = ""; // content search: inside the selected call
let listQuery = "";   // call filter: which rows the sidebar shows
let searchText = "";     // decoded search text of the selected call (see payloadSearchText)
let searchRanges = null; // frame / nested field -> [start, end) span within searchText
let searchHits = null;   // sorted positions of the query in searchText (see bindSearch)
let searchHitsCapped = false;
let schema = null; // { messages: Map<fqn, MessageDef>, enums: Map<fqn, EnumDef>, methods: Map<path, {inputType, outputType}> }

// Render-time registry of frame bodies whose decode + HTML build is deferred
// until the frame is expanded. Rebuilt on every renderDetail().
const lazyBodies = new Map();

// Nested messages up to this depth render expanded; deeper levels render
// collapsed and decode on expand, so opening one frame can't cascade an
// arbitrarily deep tree into the DOM at once.
const AUTO_OPEN_DEPTH = 2;

// Keep only the most recent N calls. Past this, the oldest are evicted so a
// long-running session under heavy traffic doesn't grow memory/DOM unbounded.
const MAX_CALLS = 500;

const callsEl = document.getElementById("calls");
const detailEl = document.getElementById("detail");
const schemaChipEl = document.getElementById("load-schema");
const clearSchemaEl = document.getElementById("clear-schema");
const matchCountEl = document.getElementById("match-count");
const listCountEl = document.getElementById("list-count");
const schemaFileEl = document.getElementById("schema-file");

document.getElementById("clear").addEventListener("click", () => {
  calls.length = 0;
  liById.clear();
  selectedId = null;
  detailToggles = {};
  userCollapsed.clear();
  userExpanded.clear();
  pageShown = {};
  callsEl.textContent = "";
  renderDetail();
});

const searchEl = document.getElementById("search");
let searchDebounce = 0;
searchEl.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    listQuery = searchEl.value;
    applySearch();
  }, 50);
});

// Content search: highlights, auto-opens and navigates inside the selected
// call only; the sidebar box above filters which calls are listed.
const detailSearchEl = document.getElementById("detail-search");
let detailDebounce = 0;
detailSearchEl.addEventListener("input", () => {
  clearTimeout(detailDebounce);
  detailDebounce = setTimeout(() => {
    searchQuery = detailSearchEl.value;
    renderDetail();
    scrollToFirstMatch();
  }, 50);
});

// ---------- Keyboard ----------

// Arrows walk the visible call list from anywhere in the panel; Cmd/Ctrl+F
// focuses the filter; Enter / Shift+Enter cycle through highlighted matches.
let markIdx = -1;

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    const target = e.shiftKey ? searchEl : detailSearchEl; // F = in-call, Shift+F = filter
    target.focus();
    target.select();
    return;
  }
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    moveSelection(e.key === "ArrowDown" ? 1 : -1);
  }
});

detailSearchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    jumpMatch(e.shiftKey ? -1 : 1);
  }
});

function moveSelection(dir) {
  const rows = callsEl.querySelectorAll("li:not([hidden])");
  if (!rows.length) return;
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i].dataset.id) === selectedId) { idx = i; break; }
  }
  idx = idx === -1 ? (dir > 0 ? 0 : rows.length - 1)
                   : Math.max(0, Math.min(rows.length - 1, idx + dir));
  setSelection(Number(rows[idx].dataset.id));
  rows[idx].scrollIntoView({ block: "nearest" });
  renderDetail();
}

function jumpMatch(dir) {
  const marks = detailEl.querySelectorAll("mark");
  if (!marks.length) return;
  if (markIdx >= 0 && markIdx < marks.length) marks[markIdx].classList.remove("current");
  markIdx = ((markIdx + dir) % marks.length + marks.length) % marks.length;
  marks[markIdx].classList.add("current");
  marks[markIdx].scrollIntoView({ block: "center" });
}

// ---------- Theme ----------

// "auto" tracks the DevTools theme via color-scheme; "light"/"dark" pin it
// through the data-theme attribute (see :root rules in panel.css).
const themeBtn = document.getElementById("theme");
const THEMES = ["auto", "light", "dark"];

function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  themeBtn.textContent = t;
  themeBtn.title = "Theme: " + t + " — click to cycle";
}

themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "auto";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
  chrome.storage.local.set({ theme: next });
});

chrome.storage.local.get("theme", (data) => {
  if (data && THEMES.includes(data.theme)) applyTheme(data.theme);
});

// ---------- Resizable call list ----------

const sidebarEl = document.getElementById("sidebar");
const resizerEl = document.getElementById("resizer");
const MIN_SIDEBAR = 200;

function setSidebarWidth(px) {
  // Always leave room for the detail pane, even on a narrow window.
  const max = Math.max(MIN_SIDEBAR, window.innerWidth - 260);
  const w = Math.max(MIN_SIDEBAR, Math.min(max, px));
  sidebarEl.style.width = w + "px";
  return w;
}

resizerEl.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = sidebarEl.getBoundingClientRect().width;
  resizerEl.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const onMove = (ev) => setSidebarWidth(startWidth + (ev.clientX - startX));
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    resizerEl.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    chrome.storage.local.set({ sidebarWidth: sidebarEl.getBoundingClientRect().width });
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// Re-clamp if the window shrinks so the detail pane never gets squeezed away.
window.addEventListener("resize", () => {
  if (sidebarEl.style.width) setSidebarWidth(parseFloat(sidebarEl.style.width));
});

chrome.storage.local.get("sidebarWidth", (data) => {
  if (data && typeof data.sidebarWidth === "number") setSidebarWidth(data.sidebarWidth);
});

callsEl.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || !callsEl.contains(li)) return;
  setSelection(Number(li.dataset.id));
  renderDetail();
  scrollToFirstMatch();
});

schemaChipEl.addEventListener("click", () => {
  schemaFileEl.click();
});

clearSchemaEl.addEventListener("click", () => {
  schema = null;
  invalidateSearch();
  chrome.storage.local.remove(["schemaB64", "schemaName"], () => {
    setSchemaStatus("no schema");
    renderDetail();
  });
});

schemaFileEl.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) loadSchemaFile(file);
  schemaFileEl.value = "";
});

// A descriptor set dropped anywhere on the panel loads as the schema.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadSchemaFile(file);
});

function loadSchemaFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result);
    try {
      const fileSet = parseFileDescriptorSet(bytes);
      schema = buildSchemaIndex(fileSet);
      invalidateSearch();
      chrome.storage.local.set({ schemaB64: bytesToBase64(bytes), schemaName: file.name }, () => {
        setSchemaStatus(file.name, "loaded",
          `${file.name} — ${schema.messages.size} messages, ${schema.methods.size} RPCs. Click to replace.`);
        renderDetail();
      });
    } catch (err) {
      setSchemaStatus("schema error", "error", "parse failed: " + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

const SCHEMA_CHIP_HINT =
  "Load a FileDescriptorSet (.binpb / .pb / .bin) — click, or drop the file anywhere on the panel";

function setSchemaStatus(text, cls, title) {
  schemaChipEl.textContent = text;
  schemaChipEl.className = "chip " + (cls || "");
  schemaChipEl.title = title || SCHEMA_CHIP_HINT;
  clearSchemaEl.hidden = cls !== "loaded";
}

chrome.devtools.network.onRequestFinished.addListener(handleRequest);

function handleRequest(req) {
  const reqCT = headerValue(req.request.headers, "content-type") || "";
  const resCT = headerValue(req.response.headers, "content-type") || "";
  const isGrpcWeb =
    reqCT.startsWith("application/grpc-web") ||
    resCT.startsWith("application/grpc-web");
  if (!isGrpcWeb) return;

  const isText =
    reqCT.includes("grpc-web-text") || resCT.includes("grpc-web-text");

  const entry = {
    id: nextId++,
    method: safeUrl(req.request.url).pathname,
    url: req.request.url,
    status: req.response.status,
    statusText: req.response.statusText,
    timeMs: Math.round(req.time || 0),
    startedLabel: formatClock(req.startedDateTime),
    grpcStatus: undefined, // filled from the trailer once the response arrives
    settled: false,        // true once getContent has come back (even empty)
    reqFrames: null,
    resFrames: null,
    trailer: null,
    error: null,
    _search: "",
    _payloadText: null, // lazily-built, capped payload index (see payloadSearchText)
  };
  entry._search = (entry.method + "\n" + entry.url).toLowerCase();

  try {
    const postText = req.request.postData && req.request.postData.text;
    if (postText) {
      let bytes = latin1ToBytes(postText);
      if (isText) bytes = maybeBase64Decode(bytes);
      entry.reqFrames = parseFrames(bytes);
    }
  } catch (e) {
    entry.error = "request decode: " + e.message;
  }

  calls.push(entry);
  appendListItem(entry);
  evictOverflow();

  req.getContent((content, encoding) => {
    entry.settled = true;
    try {
      if (content != null) {
        let bytes =
          encoding === "base64" ? base64ToBytes(content) : latin1ToBytes(content);
        if (isText) bytes = maybeBase64Decode(bytes);
        const frames = parseFrames(bytes);
        entry.resFrames = frames.filter((f) => !f.isTrailer);
        const trailer = frames.find((f) => f.isTrailer);
        if (trailer) entry.trailer = parseTrailer(trailer.payload);
        entry.grpcStatus = entry.trailer ? entry.trailer.headers["grpc-status"] : undefined;
        entry._payloadText = null; // response frames changed; drop any cached index
        if (entry.trailer && entry.trailer.raw) {
          entry._search += "\n" + entry.trailer.raw.toLowerCase();
        }
      }
    } catch (e) {
      entry.error = (entry.error ? entry.error + "; " : "") + "response decode: " + e.message;
    }
    refreshEntryVisibility(entry);
    if (selectedId === entry.id) renderDetail();
  });
}

// Build (once) the searchable text for a call: the names and values the detail
// pane prints, lowercased. Earlier versions searched the raw bytes as UTF-8,
// which missed numbers, field names and enum names and matched stray tag
// bytes; a later one capped the text at 256KB per call, which silently missed
// anything rendered past the cap on big payloads. Now the whole call is
// indexed — built only when a query runs, cached on the entry, dropped with
// the call on eviction. Invalidated by setting entry._payloadText = null.
// ponytail: index size ~= decoded payload size, so a huge call roughly doubles
// its memory while cached; re-cap per call (with a visible "truncated" hint)
// if that ever matters.
//
// entry._ranges records each frame's and nested message's [start, end) span in
// that text, so nodeHit() can answer "does this subtree match" with one indexOf
// instead of decoding the subtree again on every render.
//
function payloadSearchText(entry) {
  if (entry._payloadText != null) return entry._payloadText;
  const out = { parts: [], len: 0 };
  const ranges = new Map();
  const { inputDef, outputDef } = methodDefs(entry);
  for (const [frames, def] of [[entry.reqFrames, inputDef], [entry.resFrames, outputDef]]) {
    for (const f of frames || []) {
      const start = out.len;
      if (def) pushTok(out, def.name);
      indexFields(out, decodedFields(f), def, ranges, 0);
      ranges.set(f, [start, out.len]);
    }
  }
  entry._ranges = ranges;
  entry._payloadText = out.parts.join("").toLowerCase();
  return entry._payloadText;
}

function pushTok(out, s) {
  if (s == null) return;
  out.parts.push(s, "\n");
  out.len += s.length + 1;
}

// Mirrors what renderFields prints. If a value gets a new visible form there,
// add it here too or search will miss it.
function indexFields(out, fields, messageDef, ranges, depth) {
  if (depth > 32) return; // strict-decode false positives can nest; don't blow the stack
  const defByNum = defByNumFor(messageDef);
  for (const f of fields) {
    const fStart = out.len;
    const def = defByNum ? defByNum.get(f.fieldNumber) : null;
    pushTok(out, "#" + f.fieldNumber);
    if (def) pushTok(out, def.name);
    if (f.wireType === 0) {
      const u = f.varint;
      const t = def ? def.type : 0;
      if (t === PB_TYPE.BOOL) {
        pushTok(out, Number(u) === 0 ? "false" : "true");
      } else if (t === PB_TYPE.ENUM) {
        const enumDef = schema && schema.enums.get(def.typeName);
        const vDef = enumDef && enumDef.values.find((v) => v.number === Number(u));
        if (enumDef) pushTok(out, enumDef.name);
        if (vDef) pushTok(out, vDef.name);
        pushTok(out, u.toString());
      } else if (t === PB_TYPE.SINT32 || t === PB_TYPE.SINT64) {
        pushTok(out, zigzag(u).toString());
      } else if (t === PB_TYPE.INT32 || t === PB_TYPE.INT64) {
        pushTok(out, s64ToSigned(u).toString());
      } else {
        pushTok(out, u.toString());
        if (!def) pushTok(out, zigzag(u).toString());
      }
    } else if (f.wireType === 1 || f.wireType === 5) {
      // Typed fields only show one interpretation, but indexing all four is cheap.
      const i = f.wireType === 1 ? fixed64Interp(f.fixed) : fixed32Interp(f.fixed);
      for (const k in i) pushTok(out, String(i[k]));
    } else if (def && def.type === PB_TYPE.STRING) {
      pushTok(out, JSON.stringify(new TextDecoder().decode(f.bytes)));
    } else if (def && def.type === PB_TYPE.BYTES) {
      pushTok(out, bytesToHex(f.bytes, 64));
    } else if (def && (def.type === PB_TYPE.MESSAGE || def.type === PB_TYPE.GROUP)) {
      const subDef = schema && schema.messages.get(def.typeName);
      pushTok(out, subDef ? subDef.name : (def.typeName || "message").replace(/^\./, ""));
      indexFields(out, subFields(f), subDef, ranges, depth + 1);
    } else if (def) {
      pushTok(out, bytesToHex(f.bytes, 64));
    } else {
      classifyField(f);
      if (f._nested) {
        indexFields(out, f._nested, null, ranges, depth + 1);
        // Ambiguous bytes (a valid message that is also printable text) index
        // both readings — the [str] toggle can show the string, so searching
        // for it has to hit.
        if (f._stringVal !== null) pushTok(out, JSON.stringify(f._stringVal));
      } else if (f._stringVal !== null) {
        pushTok(out, JSON.stringify(f._stringVal));
      } else {
        pushTok(out, bytesToHex(f.bytes, 48));
      }
    }
    // Every field records its span, so nodeHit works for leaves too — paging
    // relies on it to keep a matching row visible beyond the shown page.
    ranges.set(f, [fStart, out.len]);
  }
}

// Non-strict decode of a schema-typed sub-message, cached on the field so the
// search index and the renderer walk the same objects (ranges are keyed by them).
function subFields(f) {
  if (f._msg === undefined) f._msg = decodeMessage(f.bytes, false) || [];
  return f._msg;
}

// Does this frame's / nested field's decoded subtree contain the query?
// Answered from the span recorded by payloadSearchText for the selected call.
// Point the search machinery at one call: its index text, its node spans, and
// every position of the query in that text, found in a single pass. nodeHit
// used to run indexOf from each node's start — each miss scanned to the end of
// a multi-MB index, and with tens of thousands of nodes per render that was
// tens of seconds per keystroke. One scan + binary search per node instead.
function bindSearch(entry) {
  if (!entry) { searchText = ""; searchRanges = null; searchHits = null; return; }
  searchText = payloadSearchText(entry);
  searchRanges = entry._ranges;
  searchHits = null;
  searchHitsCapped = false;
  // A 1-char query matches nearly every node; auto-opening all of them builds
  // a huge tree for a query the user is still typing. Rows still filter and
  // rendered text still gets marks — only the auto-open waits for 2 chars.
  if (searchQuery.length < 2) return;
  searchHits = [];
  const ql = searchQuery.toLowerCase();
  // Non-overlapping, capped: a broad query ("000" on numeric data) can hit
  // millions of positions; past the cap the count shows "+" and deep-tail
  // nodes stop auto-opening, which is all a query that broad deserves.
  for (let i = searchText.indexOf(ql); i !== -1; i = searchText.indexOf(ql, i + ql.length)) {
    searchHits.push(i);
    if (searchHits.length >= 50000) { searchHitsCapped = true; break; }
  }
}

function nodeHit(node) {
  if (!searchHits || !searchHits.length || !searchRanges) return false;
  const r = searchRanges.get(node);
  if (!r) return false;
  let lo = 0, hi = searchHits.length; // first hit at or after the node's start
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (searchHits[mid] < r[0]) lo = mid + 1; else hi = mid;
  }
  return lo < searchHits.length && searchHits[lo] < r[1];
}

// Field names and typed values come from the schema, so a schema change makes
// every cached search text stale.
function invalidateSearch() {
  for (const c of calls) c._payloadText = null;
}

function methodDefs(entry) {
  const methodDef = schema ? schema.methods.get(entry.method) : null;
  return {
    methodDef,
    inputDef: methodDef ? schema.messages.get(methodDef.inputType) : null,
    outputDef: methodDef ? schema.messages.get(methodDef.outputType) : null,
  };
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const h of headers || []) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return null;
}

function safeUrl(s) {
  try { return new URL(s); } catch { return { pathname: s }; }
}

function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  return latin1ToBytes(bin);
}

function maybeBase64Decode(bytes) {
  try {
    const s = new TextDecoder("ascii").decode(bytes).replace(/\s+/g, "");
    return base64ToBytes(s);
  } catch {
    return bytes;
  }
}

// ---------- gRPC-Web frame parser ----------

function parseFrames(bytes) {
  const frames = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i + 5 <= bytes.length) {
    const flag = bytes[i];
    const len = view.getUint32(i + 1, false);
    i += 5;
    if (i + len > bytes.length) break;
    const payload = bytes.subarray(i, i + len);
    i += len;
    frames.push({ flag, isTrailer: (flag & 0x80) !== 0, payload });
  }
  return frames;
}

function parseTrailer(payload) {
  const text = new TextDecoder("utf-8").decode(payload);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { headers, raw: text };
}

// ---------- Protobuf wire-format decoder ----------

// Varints up to 7 bytes (49 bits) decode as plain numbers, which covers nearly
// everything real. Only 8-10 byte ones fall back to BigInt, so callers see
// number | bigint and must not use BigInt-only operators on the value.
function readVarint(buf, pos) {
  const end = Math.min(buf.length, pos + 10);
  let result = 0;
  let mul = 1;
  for (let i = pos; i < end && i < pos + 7; i++) {
    const b = buf[i];
    result += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return { value: result, next: i + 1 };
    mul *= 128;
  }
  let big = 0n;
  let shift = 0n;
  for (let i = pos; i < end; i++) {
    const b = buf[i];
    big |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: big, next: i + 1 };
    shift += 7n;
  }
  throw new Error("varint overflow / truncated");
}

function decodeMessage(buf, strict) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tagRes;
    try { tagRes = readVarint(buf, i); } catch { return strict ? null : out; }
    const tag = tagRes.value;
    i = tagRes.next;
    // A valid tag fits in 5 bytes; a BigInt here means garbage.
    if (typeof tag !== "number") return strict ? null : out;
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNumber === 0) return strict ? null : out;
    if (![0, 1, 2, 5].includes(wireType)) return strict ? null : out;

    if (wireType === 0) {
      let v;
      try { v = readVarint(buf, i); } catch { return strict ? null : out; }
      i = v.next;
      out.push({ fieldNumber, wireType, varint: v.value });
    } else if (wireType === 1) {
      if (i + 8 > buf.length) return strict ? null : out;
      const slice = buf.subarray(i, i + 8);
      i += 8;
      out.push({ fieldNumber, wireType, fixed: slice });
    } else if (wireType === 5) {
      if (i + 4 > buf.length) return strict ? null : out;
      const slice = buf.subarray(i, i + 4);
      i += 4;
      out.push({ fieldNumber, wireType, fixed: slice });
    } else {
      let lenRes;
      try { lenRes = readVarint(buf, i); } catch { return strict ? null : out; }
      const L = Number(lenRes.value);
      i = lenRes.next;
      if (L < 0 || i + L > buf.length) return strict ? null : out;
      const slice = buf.subarray(i, i + L);
      i += L;
      // Store the raw slice only. Whether it's a nested message, a string, or
      // opaque bytes is decided lazily at render time (classifyField) so one
      // decodeMessage call costs O(this level) instead of O(whole subtree).
      out.push({ fieldNumber, wireType, bytes: slice });
    }
  }
  return out;
}

// Decide, on demand, how a length-delimited field should be shown: nested
// message, printable string, or opaque bytes. Result is cached on the field so
// re-renders are free. The strict decode probes only one level deep (see
// decodeMessage), so this never walks the whole subtree at once.
function classifyField(f) {
  if (f._nested !== undefined) return;
  const nested = f.bytes && f.bytes.length > 0 ? decodeMessage(f.bytes, true) : null;
  f._nested = nested && nested.length > 0 ? nested : null;
  // Computed even when the bytes parse as a message: short strings can be
  // false-positive messages, and both the [str] toggle and the search index
  // need the string reading of an ambiguous field.
  f._stringVal = tryString(f.bytes);
}

function tryString(buf) {
  if (buf.length === 0) return "";
  let printable = 0;
  for (const b of buf) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  if (printable / buf.length < 0.85) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function zigzag(n) {
  if (typeof n === "bigint") return (n >> 1n) ^ -(n & 1n);
  return n % 2 ? -(n + 1) / 2 : n / 2;
}

function bytesToHex(buf, max) {
  const lim = max == null ? buf.length : Math.min(buf.length, max);
  let s = "";
  for (let i = 0; i < lim; i++) s += buf[i].toString(16).padStart(2, "0");
  if (lim < buf.length) s += "…";
  return s;
}

function fixed32Interp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, 4);
  return {
    hex: bytesToHex(buf),
    u32: dv.getUint32(0, true),
    i32: dv.getInt32(0, true),
    f32: dv.getFloat32(0, true),
  };
}

function fixed64Interp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, 8);
  return {
    hex: bytesToHex(buf),
    u64: dv.getBigUint64(0, true).toString(),
    i64: dv.getBigInt64(0, true).toString(),
    f64: dv.getFloat64(0, true),
  };
}

// ---------- FileDescriptorSet parser ----------

// Wire-format field-number constants from google/protobuf/descriptor.proto
function getF(fields, num) { return fields.find((f) => f.fieldNumber === num); }
function getAllF(fields, num) { return fields.filter((f) => f.fieldNumber === num); }
function asString(f) {
  if (!f) return null;
  return new TextDecoder("utf-8").decode(f.bytes);
}
function asMessage(f) {
  if (!f) return [];
  return decodeMessage(f.bytes, false) || [];
}
function asVarint(f) {
  return f ? f.varint : null;
}

function parseFileDescriptorSet(bytes) {
  const fields = decodeMessage(bytes, true);
  if (!fields) throw new Error("not a valid FileDescriptorSet");
  return getAllF(fields, 1).map(parseFileDescriptorProto);
}

function parseFileDescriptorProto(f) {
  const m = asMessage(f);
  return {
    name: asString(getF(m, 1)),
    package: asString(getF(m, 2)) || "",
    messages: getAllF(m, 4).map(parseDescriptorProto),
    enums: getAllF(m, 5).map(parseEnumDescriptorProto),
    services: getAllF(m, 6).map(parseServiceDescriptorProto),
  };
}

function parseDescriptorProto(f) {
  const m = asMessage(f);
  return {
    name: asString(getF(m, 1)),
    fields: getAllF(m, 2).map(parseFieldDescriptorProto),
    nested: getAllF(m, 3).map(parseDescriptorProto),
    enums: getAllF(m, 4).map(parseEnumDescriptorProto),
  };
}

function parseFieldDescriptorProto(f) {
  const m = asMessage(f);
  return {
    name: asString(getF(m, 1)),
    number: Number(asVarint(getF(m, 3)) || 0n),
    label: Number(asVarint(getF(m, 4)) || 0n), // 3=repeated
    type: Number(asVarint(getF(m, 5)) || 0n),
    typeName: asString(getF(m, 6)),
  };
}

function parseEnumDescriptorProto(f) {
  const m = asMessage(f);
  return {
    name: asString(getF(m, 1)),
    values: getAllF(m, 2).map((vf) => {
      const vm = asMessage(vf);
      return { name: asString(getF(vm, 1)), number: Number(asVarint(getF(vm, 2)) || 0n) };
    }),
  };
}

function parseServiceDescriptorProto(f) {
  const m = asMessage(f);
  return {
    name: asString(getF(m, 1)),
    methods: getAllF(m, 2).map((mf) => {
      const mm = asMessage(mf);
      return {
        name: asString(getF(mm, 1)),
        inputType: asString(getF(mm, 2)),
        outputType: asString(getF(mm, 3)),
      };
    }),
  };
}

function buildSchemaIndex(files) {
  const messages = new Map();
  const enums = new Map();
  const methods = new Map();

  function indexMessages(msgs, parentFqn) {
    for (const m of msgs) {
      if (!m.name) continue;
      const fqn = parentFqn + "." + m.name;
      messages.set(fqn, m);
      indexMessages(m.nested, fqn);
      for (const e of m.enums) {
        if (e.name) enums.set(fqn + "." + e.name, e);
      }
    }
  }

  for (const file of files) {
    const pkg = file.package ? "." + file.package : "";
    indexMessages(file.messages, pkg);
    for (const e of file.enums) {
      if (e.name) enums.set(pkg + "." + e.name, e);
    }
    for (const svc of file.services) {
      if (!svc.name) continue;
      const svcPath = (file.package ? file.package + "." : "") + svc.name;
      for (const method of svc.methods) {
        if (!method.name) continue;
        methods.set(`/${svcPath}/${method.name}`, {
          inputType: method.inputType,
          outputType: method.outputType,
        });
      }
    }
  }

  return { messages, enums, methods };
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---------- Rendering ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// Escape, then wrap matches of searchQuery in <mark>.
function hl(text, q = searchQuery) {
  if (text == null) return "";
  const s = String(text);
  if (!q) return escapeHtml(s);
  const lower = s.toLowerCase();
  const ql = q.toLowerCase();
  const out = [];
  let i = 0;
  while (i < s.length) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) { out.push(escapeHtml(s.slice(i))); break; }
    if (idx > i) out.push(escapeHtml(s.slice(i, idx)));
    out.push(`<mark>${escapeHtml(s.slice(idx, idx + ql.length))}</mark>`);
    i = idx + ql.length;
  }
  return out.join("");
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// Canonical gRPC status names, indexed by code number.
const GRPC_CODES = ["OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED",
  "NOT_FOUND", "ALREADY_EXISTS", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED", "INTERNAL",
  "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED"];

// One verdict per call, gRPC first: HTTP only matters when the transport
// itself failed; otherwise the trailer's grpc-status is the real result.
function entryStatus(entry) {
  if (!(entry.status >= 200 && entry.status < 400)) {
    return { cls: "bad", label: "HTTP " + entry.status };
  }
  if (entry.grpcStatus != null && entry.grpcStatus !== "0") {
    const name = GRPC_CODES[Number(entry.grpcStatus)];
    return { cls: "bad", label: name || "gRPC " + entry.grpcStatus };
  }
  if (!entry.settled) return { cls: "pending", label: "pending" };
  return { cls: "ok", label: "OK" };
}

// Wall-clock HH:MM:SS from the request's HAR start time, so rows fired against
// the same method path stay tellable apart. Falls back to capture time.
function formatClock(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function entryMatches(entry, q) {
  if (!q) return true;
  const ql = q.toLowerCase();
  // Cheap method/url/trailer index first; only decode payload text if needed.
  if (entry._search.includes(ql)) return true;
  return payloadSearchText(entry).includes(ql);
}

function listItemHtml(entry) {
  const st = entryStatus(entry);
  const cut = entry.method.lastIndexOf("/");
  const name = entry.method.slice(cut + 1);
  const svc = cut > 0 ? entry.method.slice(1, cut) : "";
  const time = entry.startedLabel ? ` · ${entry.startedLabel}` : "";
  const n = entry.resFrames ? entry.resFrames.length : null;
  const frames = n == null ? "" : ` · ${n} frame${n === 1 ? "" : "s"}`;
  return `<div class="row-top"><span class="dot ${st.cls}"></span><span class="name">${hl(name, listQuery)}</span>` +
         (svc ? `<span class="svc">${hl(svc, listQuery)}</span>` : "") + `</div>` +
         `<div class="meta"><span class="seq">#${entry.id}</span> · <span class="st-${st.cls}">${hl(st.label, listQuery)}</span>` +
         ` · ${formatDuration(entry.timeMs)}${frames}${time}</div>`;
}

// Rebuild a row's markup and its status class together so they can't drift.
function syncRow(li, entry) {
  li.innerHTML = listItemHtml(entry);
  li.classList.toggle("bad", entryStatus(entry).cls === "bad");
}

function appendListItem(entry) {
  const li = document.createElement("li");
  li.dataset.id = String(entry.id);
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", entry.id === selectedId ? "true" : "false");
  if (entry.id === selectedId) li.classList.add("selected");
  syncRow(li, entry);
  if (listQuery && !entryMatches(entry, listQuery)) li.hidden = true;
  liById.set(entry.id, li);
  callsEl.appendChild(li);
}

// Drop the oldest calls once we exceed MAX_CALLS, releasing their frames/DOM.
// Late getContent callbacks for an evicted entry are harmless: liById no longer
// has its row, so the visibility/detail refreshes simply no-op.
function evictOverflow() {
  while (calls.length > MAX_CALLS) {
    const old = calls.shift();
    const li = liById.get(old.id);
    if (li) li.remove();
    liById.delete(old.id);
    if (selectedId === old.id) {
      selectedId = null;
      renderDetail();
    }
  }
}

let searchGen = 0; // abandons in-flight row filtering when the query changes

function applySearch() {
  const gen = ++searchGen;
  const ql = listQuery.toLowerCase();
  const pending = [];
  for (const entry of calls) {
    const li = liById.get(entry.id);
    if (!li) continue;
    if (!listQuery) { li.hidden = false; syncRow(li, entry); continue; }
    // Rows answerable right now: a cheap method/url/trailer hit, or a payload
    // index that is already built.
    if (entry._search.includes(ql) || entry._payloadText != null) {
      const matches = entryMatches(entry, listQuery);
      li.hidden = !matches;
      if (matches) syncRow(li, entry);
    } else {
      pending.push(entry);
    }
  }
  if (pending.length) applySearchChunk(gen, pending, 0);
  updateListCount();
}

// Building a call's search index decodes its whole payload. Doing that for
// every captured call inside one keystroke froze the panel on big responses,
// so the uncached ones are indexed on a time budget per tick; rows resolve
// progressively and a newer query abandons the rest.
function applySearchChunk(gen, entries, i) {
  if (gen !== searchGen) return;
  const t0 = Date.now();
  while (i < entries.length && Date.now() - t0 < 12) {
    const entry = entries[i++];
    const li = liById.get(entry.id);
    if (!li) continue;
    const matches = entryMatches(entry, listQuery);
    li.hidden = !matches;
    if (matches) syncRow(li, entry);
  }
  if (i < entries.length) setTimeout(() => applySearchChunk(gen, entries, i), 0);
  else updateListCount();
}

function refreshEntryVisibility(entry) {
  const li = liById.get(entry.id);
  if (!li) return;
  // The response just arrived, so grpc-status / duration may now be known.
  syncRow(li, entry);
  li.hidden = listQuery ? !entryMatches(entry, listQuery) : false;
}

function setSelection(id) {
  if (selectedId === id) return;
  const prev = liById.get(selectedId);
  if (prev) { prev.classList.remove("selected"); prev.setAttribute("aria-selected", "false"); }
  selectedId = id;
  const next = liById.get(id);
  if (next) { next.classList.add("selected"); next.setAttribute("aria-selected", "true"); }
}

function renderDetail() {
  expandGen++; // a full re-render supersedes any expand-all still pumping
  lazyBodies.clear();
  fullValues.clear();
  hitBudget = HIT_BUDGET;
  markIdx = -1; // marks are about to be rebuilt
  const entry = calls.find((c) => c.id === selectedId);
  if (!entry) {
    detailEl.innerHTML = '<div class="placeholder">Select a call to inspect.</div>';
    updateMatchCount();
    return;
  }

  const { methodDef, inputDef, outputDef } = methodDefs(entry);
  bindSearch(searchQuery ? entry : null);

  const parts = [];
  const cut = entry.method.lastIndexOf("/");
  parts.push(`<h1><span class="h1-svc">${hl(entry.method.slice(0, cut + 1))}</span>${hl(entry.method.slice(cut + 1))}</h1>`);
  const st = entryStatus(entry);
  parts.push(`<div class="statusline"><span class="pill ${st.cls}">${hl(st.label)}</span>` +
             `<span class="field-type">HTTP ${entry.status} · ${formatDuration(entry.timeMs)}</span></div>`);
  parts.push(`<div class="url">${hl(entry.url)}</div>`);
  if (methodDef) {
    parts.push(`<div class="url"><span class="field-name">${hl(methodDef.inputType || "?")}</span> &rarr; <span class="field-name">${hl(methodDef.outputType || "?")}</span></div>`);
  } else if (schema) {
    parts.push(`<div class="url"><em>no schema entry for this method</em></div>`);
  }
  parts.push('<div class="actions"><button data-action="expand" title="Open every frame and nested message">expand all</button>' +
             '<button data-action="collapse" title="Back to the default: frames closed">collapse all</button></div>');

  if (entry.error) {
    parts.push(`<section><h3>Errors</h3><div class="frame trailer bad"><div class="frame-body">${escapeHtml(entry.error)}</div></div></section>`);
  }

  parts.push("<section><h3>Request</h3>" + renderFrames(entry.reqFrames, `${entry.id}.req`, inputDef) + "</section>");
  const nRes = entry.resFrames ? entry.resFrames.length : null;
  const resHdr = nRes == null ? "Response" : `Response · ${nRes} data frame${nRes === 1 ? "" : "s"}`;
  parts.push(`<section><h3>${resHdr}</h3>` + renderFrames(entry.resFrames, `${entry.id}.res`, outputDef) + "</section>");

  if (entry.trailer) {
    const grpcStatus = entry.trailer.headers["grpc-status"];
    const grpcMessage = entry.trailer.headers["grpc-message"];
    const cls = grpcStatus === "0" ? "ok" : grpcStatus ? "bad" : "";
    let body = "";
    if (grpcStatus != null) body += `<div><kbd>grpc-status</kbd> = ${hl(grpcStatus)}</div>`;
    if (grpcMessage) body += `<div><kbd>grpc-message</kbd> = ${hl(grpcMessage)}</div>`;
    body += `<details style="margin-top:6px"><summary>raw trailer</summary><pre>${hl(entry.trailer.raw)}</pre></details>`;
    parts.push(`<section><h3>Trailer</h3><div class="frame trailer ${cls}"><div class="frame-body">${body}</div></div></section>`);
  }

  detailEl.innerHTML = parts.join("");
  updateMatchCount();
}

// "N matches" = highlighted hits in the detail pane, i.e. what Ctrl+F would
// count on what's actually shown (matching branches auto-open, so payload hits
// are materialized). With no call selected, fall back to how many calls match.
function updateMatchCount() {
  if (!searchQuery || selectedId == null || !calls.some((c) => c.id === selectedId)) {
    matchCountEl.textContent = "";
    return;
  }
  // Index hits when available (1-char queries have none — fall back to marks).
  const n = searchHits ? searchHits.length : detailEl.querySelectorAll("mark").length;
  matchCountEl.textContent =
    n === 1 ? "1 match" : n + (searchHits && searchHitsCapped ? "+" : "") + " matches";
}

function updateListCount() {
  if (!listQuery) { listCountEl.textContent = ""; return; }
  const n = callsEl.querySelectorAll("li:not([hidden])").length;
  listCountEl.textContent = n + " / " + calls.length + (calls.length === 1 ? " call" : " calls");
}

function scrollToFirstMatch() {
  if (!searchQuery) return;
  const m = detailEl.querySelector("mark");
  if (m && m.scrollIntoView) m.scrollIntoView({ block: "center" });
}

// Expand / collapse all for the selected call. Collapse drops the call's
// remembered toggles and re-renders back to the default (frames closed).
// Expand doesn't re-render at all: it walks the live DOM and opens every
// closed node, one batch per tick, injecting deferred bodies as it goes.
// Building the whole tree in one synchronous render froze the panel on large
// payloads; chunking keeps it painting and lets the user interrupt.
// While a query is active, renders ignore the expanded state (see
// detailsOpen), so a search keystroke never rebuilds a fully expanded tree.
// ponytail: a msg/raw toggle without a query still rebuilds the whole open
// tree in one pass; chunk renderDetail if that starts to hurt.
const EXPAND_BATCH = 250;

detailEl.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button[data-action]");
  if (!b || !detailEl.contains(b) || selectedId == null) return;
  if (b.dataset.action === "collapse") {
    const prefix = selectedId + ".";
    for (const set of [userExpanded, userCollapsed]) {
      for (const k of set) if (k.startsWith(prefix)) set.delete(k);
    }
    for (const k in pageShown) if (k.startsWith(prefix)) delete pageShown[k];
    renderDetail();
    return;
  }
  expandAllStep(++expandGen, b);
});

function expandAllStep(gen, btn) {
  if (gen !== expandGen) return; // a newer render or click took over
  const closed = detailEl.querySelectorAll("details:not([open])");
  const n = Math.min(closed.length, EXPAND_BATCH);
  for (let i = 0; i < n; i++) openNode(closed[i]);
  // Opening a batch can inject new closed children, so re-check rather than
  // trusting the count above.
  if (detailEl.querySelector("details:not([open])")) {
    btn.textContent = "expanding…";
    btn.disabled = true;
    setTimeout(() => expandAllStep(gen, btn), 0);
  } else {
    btn.textContent = "expand all";
    btn.disabled = false;
  }
}

// Open one node the way a user click would: record the override so the state
// survives re-renders, materialize a deferred body, then flip it open.
function openNode(el) {
  const k = el.getAttribute("data-key");
  if (k) {
    if (el.getAttribute("data-default") === "closed") userExpanded.add(k);
    else userCollapsed.delete(k);
  }
  injectLazy(el);
  el.open = true;
}

function injectLazy(el) {
  hitBudget = HIT_BUDGET; // a user-driven expand deserves fresh search opens
  const lazyKey = el.getAttribute("data-lazy");
  if (!lazyKey) return;
  const build = lazyBodies.get(lazyKey);
  if (build) {
    el.insertAdjacentHTML("beforeend", build());
    lazyBodies.delete(lazyKey);
  }
}

detailEl.addEventListener("click", (e) => {
  const t = e.target.closest && e.target.closest(".toggle");
  if (!t || !detailEl.contains(t)) return;
  e.stopPropagation();
  e.preventDefault();
  const pk = t.getAttribute("data-page");
  if (pk) {
    pageShown[pk] = (pageShown[pk] || 1) + 1;
    renderDetail();
    return;
  }
  const k = t.getAttribute("data-key");
  const to = t.getAttribute("data-to");
  if (to === "") delete detailToggles[k];
  else detailToggles[k] = to;
  renderDetail();
});

// ---------- Copy ----------

const COPY_BTN = '<button class="copy" title="Copy value">⧉</button>';

// Tacks the copy button inside a leaf <li>. Leaves have no nested lists, so
// splicing before the closing tag is safe.
function leafCopy(html) {
  return html.slice(0, -"</li>".length) + COPY_BTN + "</li>";
}

function copyText(text, btn, label) {
  const done = () => {
    btn.textContent = "✓";
    setTimeout(() => { btn.textContent = label; }, 900);
  };
  navigator.clipboard.writeText(text).then(done, () => {
    // The clipboard API can be refused inside a devtools page; fall back.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  });
}

detailEl.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("button.copy, button.copy-json");
  if (!btn || !detailEl.contains(btn)) return;
  e.preventDefault();
  e.stopPropagation();
  if (btn.classList.contains("copy")) {
    // Copy what the row displays; strings lose their JSON quoting.
    const li = btn.closest("li");
    const val = li && li.querySelector(".field-val-str, .field-val-num, .field-val-hex, .enum-name");
    const fk = val && val.getAttribute("data-fk");
    if (fk && fullValues.has(fk)) { copyText(fullValues.get(fk), btn, "⧉"); return; }
    let text = val ? val.textContent : "";
    if (text.startsWith('"')) { try { text = JSON.parse(text); } catch {} }
    copyText(text, btn, "⧉");
    return;
  }
  const entry = calls.find((c) => c.id === selectedId);
  if (!entry) return;
  const frames = btn.dataset.frame === "req" ? entry.reqFrames : entry.resFrames;
  const f = frames && frames[Number(btn.dataset.idx)];
  if (!f) return;
  const { inputDef, outputDef } = methodDefs(entry);
  const def = btn.dataset.frame === "req" ? inputDef : outputDef;
  copyText(JSON.stringify(fieldsToJson(decodedFields(f), def), null, 2), btn, "copy JSON");
});

// Decoded frame -> plain object, following the same interpretations the
// renderer shows. Repeated fields collapse into arrays.
function fieldsToJson(fields, messageDef, depth = 0) {
  if (depth > 32) return "…";
  const defByNum = defByNumFor(messageDef);
  const out = {};
  const arrays = new Set();
  for (const f of fields) {
    const def = defByNum ? defByNum.get(f.fieldNumber) : null;
    const key = def ? def.name : "field_" + f.fieldNumber;
    const v = fieldJsonValue(f, def, depth);
    if (!(key in out)) out[key] = v;
    else if (arrays.has(key)) out[key].push(v);
    else { out[key] = [out[key], v]; arrays.add(key); }
  }
  return out;
}

// JSON.stringify chokes on BigInt: keep safe integers as numbers, stringify the rest.
function jsonNum(v) {
  if (typeof v !== "bigint") return v;
  return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
}

function fieldJsonValue(f, def, depth) {
  if (f.wireType === 0) {
    const u = f.varint;
    const t = def ? def.type : 0;
    if (t === PB_TYPE.BOOL) return Number(u) !== 0;
    if (t === PB_TYPE.ENUM) {
      const enumDef = schema && schema.enums.get(def.typeName);
      const vDef = enumDef && enumDef.values.find((v) => v.number === Number(u));
      return vDef ? vDef.name : jsonNum(u);
    }
    if (t === PB_TYPE.SINT32 || t === PB_TYPE.SINT64) return jsonNum(zigzag(u));
    if (t === PB_TYPE.INT32 || t === PB_TYPE.INT64) return jsonNum(s64ToSigned(u));
    return jsonNum(u);
  }
  if (f.wireType === 1 || f.wireType === 5) {
    const i = f.wireType === 1 ? fixed64Interp(f.fixed) : fixed32Interp(f.fixed);
    if (def) {
      if (def.type === PB_TYPE.DOUBLE) return i.f64;
      if (def.type === PB_TYPE.FLOAT) return i.f32;
      if (def.type === PB_TYPE.SFIXED64) return i.i64;
      if (def.type === PB_TYPE.FIXED64) return i.u64;
      if (def.type === PB_TYPE.SFIXED32) return i.i32;
      if (def.type === PB_TYPE.FIXED32) return i.u32;
    }
    return i; // schema-less: all four interpretations
  }
  if (def) {
    if (def.type === PB_TYPE.STRING) return new TextDecoder("utf-8").decode(f.bytes);
    if (def.type === PB_TYPE.BYTES) return bytesToHex(f.bytes);
    if (def.type === PB_TYPE.MESSAGE || def.type === PB_TYPE.GROUP) {
      const subDef = schema && schema.messages.get(def.typeName);
      return fieldsToJson(subFields(f), subDef, depth + 1);
    }
    return bytesToHex(f.bytes);
  }
  classifyField(f);
  if (f._nested) return fieldsToJson(f._nested, null, depth + 1);
  if (f._stringVal !== null) return f._stringVal;
  return bytesToHex(f.bytes);
}

// `toggle` does not bubble — listen in the capture phase to delegate.
detailEl.addEventListener("toggle", (e) => {
  const el = e.target;
  if (!el || el.tagName !== "DETAILS") return;
  const k = el.getAttribute("data-key");
  if (!k) return;
  const defaultClosed = el.getAttribute("data-default") === "closed";
  if (defaultClosed) {
    if (el.open) userExpanded.add(k); else userExpanded.delete(k);
  } else {
    if (el.open) userCollapsed.delete(k); else userCollapsed.add(k);
  }

  // First expand of a deferred node (frame or deep nested message): decode and
  // build its body now and inject it.
  if (el.open) injectLazy(el);
}, true);

function decodedFields(frame) {
  if (frame._fields === undefined) {
    try { frame._fields = decodeMessage(frame.payload, false) || []; }
    catch { frame._fields = []; }
  }
  return frame._fields;
}

// Frames page like fields do: a streaming response can carry thousands of
// data frames, and rendering every summary — let alone every matching body —
// froze the panel. Matching frames beyond the page stay visible while the
// per-render hit budget lasts.
const FRAME_PAGE = 100;

function renderFrames(frames, kind, messageDef) {
  if (frames == null) return '<div class="placeholder" style="padding:8px">(no body captured)</div>';
  if (frames.length === 0) return '<div class="placeholder" style="padding:8px">(empty)</div>';
  const which = kind.slice(kind.lastIndexOf(".") + 1); // "req" | "res"
  const pageKey = `${kind}:frames`;
  const shown = Math.min(frames.length, FRAME_PAGE * (pageShown[pageKey] || 1));
  const parts = [];
  let gap = 0;
  for (let idx = 0; idx < frames.length; idx++) {
    const f = frames[idx];
    const hit = nodeHit(f) && spendHit();
    if (idx >= shown && !hit) { gap++; continue; }
    if (gap) { parts.push(`<div class="placeholder frame-gap">… ${gap} frames skipped</div>`); gap = 0; }
    parts.push(renderFrame(f, idx, kind, which, messageDef, hit));
  }
  if (gap) {
    parts.push(`<div class="placeholder frame-gap"><button class="toggle" data-page="${escapeHtml(pageKey)}">` +
               `[show ${Math.min(FRAME_PAGE, gap)} more of ${gap} hidden]</button></div>`);
  }
  return parts.join("");
}

function renderFrame(f, idx, kind, which, messageDef, hit) {
  const frameKey = `${kind}-${idx}-frame`;
    const flagHex = f.flag.toString(16).padStart(2, "0");
    const summary =
      `<summary class="frame-hdr" title="flag 0x${flagHex}">data frame #${idx} · ${formatBytes(f.payload.length)}` +
      `${messageDef ? ` · <span class="field-name">${hl(messageDef.name)}</span>` : ""}` +
      `<button class="copy-json" data-frame="${which}" data-idx="${idx}" title="Copy the decoded frame as JSON">copy JSON</button></summary>`;
    // Decode the wire format and build the field tree only when actually shown.
    const renderBody = () =>
      `<div class="frame-body"><ul class="fields">` +
      `${renderFields(decodedFields(f), `${kind}-${idx}`, [], messageDef)}</ul></div>`;

  if (detailsOpen(frameKey, false) === "open" || hit) {
    return `<details class="frame" open data-key="${escapeHtml(frameKey)}" data-default="closed">` +
           summary + renderBody() + `</details>`;
  }
  // Collapsed: emit only the summary and defer the body until expanded. This
  // is what keeps a burst of large calls cheap — nothing under a closed frame
  // is decoded or turned into DOM.
  lazyBodies.set(frameKey, renderBody);
  return `<details class="frame" data-key="${escapeHtml(frameKey)}" data-default="closed" data-lazy="${escapeHtml(frameKey)}">` +
         summary + `</details>`;
}

// FieldDescriptorProto.Type values
const PB_TYPE = {
  DOUBLE: 1, FLOAT: 2, INT64: 3, UINT64: 4, INT32: 5, FIXED64: 6, FIXED32: 7,
  BOOL: 8, STRING: 9, GROUP: 10, MESSAGE: 11, BYTES: 12, UINT32: 13, ENUM: 14,
  SFIXED32: 15, SFIXED64: 16, SINT32: 17, SINT64: 18,
};

function typeLabel(t) {
  for (const k in PB_TYPE) if (PB_TYPE[k] === t) return k.toLowerCase();
  return "unknown";
}

function s64ToSigned(u) { // unsigned 64 -> signed; plain numbers are < 2^49 so already fine
  if (typeof u !== "bigint") return u;
  return u >= (1n << 63n) ? u - (1n << 64n) : u;
}

const defByNumCache = new WeakMap();
function defByNumFor(messageDef) {
  if (!messageDef) return null;
  let m = defByNumCache.get(messageDef);
  if (!m) {
    m = new Map(messageDef.fields.map((d) => [d.number, d]));
    defByNumCache.set(messageDef, m);
  }
  return m;
}

// How many children of one node render before the rest hide behind a
// "show more" stub. Opening a frame with tens of thousands of repeated items
// used to materialize all of them in one go — tens of MB of HTML and seconds
// of freeze, worse on every search keystroke. Paging bounds every level.
// Fields that match the query always render, so search can surface an item on
// page 40 without paging to it.
const CHILD_PAGE = 200;
let pageShown = {}; // pageKey -> pages requested via [show more]

// A broad query can match thousands of nodes at once; force-showing or
// auto-opening every one of them re-creates the freeze that paging fixed.
// Each render gets a budget of search-driven extras — matches past it render
// as ordinary gaps and closed summaries, and the counter still shows the
// real total from the index.
const HIT_BUDGET = 25;
let hitBudget = 0;
function spendHit() { return hitBudget-- > 0; }

function renderFields(fields, path, crumbs, messageDef, depth = 0) {
  if (!fields || fields.length === 0) return '<li class="field-type">(empty)</li>';
  const defByNum = defByNumFor(messageDef);
  const pageKey = `${path}:${crumbs.join(".")}`;
  const shown = Math.min(fields.length, CHILD_PAGE * (pageShown[pageKey] || 1));
  const parts = [];
  let gap = 0;
  for (let idx = 0; idx < fields.length; idx++) {
    const f = fields[idx];
    if (idx >= shown && !(nodeHit(f) && spendHit())) { gap++; continue; }
    if (gap) { parts.push(`<li class="field-type">… ${gap} fields skipped</li>`); gap = 0; }
    parts.push(renderField(f, idx, path, crumbs, defByNum, depth));
  }
  if (gap) {
    parts.push(`<li class="field-type"><button class="toggle" data-page="${escapeHtml(pageKey)}">` +
               `[show ${Math.min(CHILD_PAGE, gap)} more of ${gap} hidden]</button></li>`);
  }
  return parts.join("");
}

function renderField(f, idx, path, crumbs, defByNum, depth) {
  const myCrumbs = crumbs.concat(idx);
  const key = `${path}.${myCrumbs.join(".")}`;
  const def = defByNum ? defByNum.get(f.fieldNumber) : null;

  const tagHtml = def
    ? `<span class="field-name">${hl(def.name)}</span> <span class="field-type">${hl("#" + f.fieldNumber)}</span>`
    : `<span class="field-tag">${hl("#" + f.fieldNumber)}</span>`;

  if (f.wireType === 0) return leafCopy(renderVarint(tagHtml, f, def));
  if (f.wireType === 1) return leafCopy(renderFixed(tagHtml, f, def, 64));
  if (f.wireType === 5) return leafCopy(renderFixed(tagHtml, f, def, 32));

  // wireType 2 — length-delimited
  return renderLengthDelimited(tagHtml, f, def, key, path, myCrumbs, depth);
}

// Render a collapsible nested-message node. Its children are produced by
// childThunk() only when the node is open — collapsed deep nodes register the
// thunk in lazyBodies and emit just the summary, so the toggle handler can
// build the subtree on first expand (mirrors the frame-level laziness).
function renderMessageNode(tagHtml, summaryRest, key, childThunk, depth, matchHit) {
  const autoOpen = depth < AUTO_OPEN_DEPTH;
  const dataDefault = autoOpen ? "open" : "closed";
  const summary = `<summary>${tagHtml} ${summaryRest}</summary>`;
  if (detailsOpen(key, autoOpen) === "open" || matchHit) {
    return `<li><details open data-key="${escapeHtml(key)}" data-default="${dataDefault}">` +
           `${summary}<ul>${childThunk()}</ul></details></li>`;
  }
  lazyBodies.set(key, () => `<ul>${childThunk()}</ul>`);
  return `<li><details data-key="${escapeHtml(key)}" data-default="${dataDefault}" data-lazy="${escapeHtml(key)}">` +
         `${summary}</details></li>`;
}

function renderVarint(tagHtml, f, def) {
  const u = f.varint;
  if (def) {
    const t = def.type;
    if (t === PB_TYPE.BOOL) {
      const v = Number(u) === 0 ? "false" : "true";
      return `<li>${tagHtml} <span class="field-type">(bool)</span> = <span class="field-val-num">${hl(v)}</span></li>`;
    }
    if (t === PB_TYPE.ENUM) {
      const enumDef = schema && schema.enums.get(def.typeName);
      const vDef = enumDef && enumDef.values.find((v) => v.number === Number(u));
      const name = vDef ? vDef.name : null;
      const display = name ? `<span class="enum-name">${hl(name)}</span> <span class="field-type">(${hl(u.toString())})</span>` : `<span class="field-val-num">${hl(u.toString())}</span>`;
      const enumLabel = enumDef ? hl(enumDef.name) : "enum";
      return `<li>${tagHtml} <span class="field-type">(${enumLabel})</span> = ${display}</li>`;
    }
    if (t === PB_TYPE.SINT32 || t === PB_TYPE.SINT64) {
      const z = zigzag(u);
      return `<li>${tagHtml} <span class="field-type">(${typeLabel(t)})</span> = <span class="field-val-num">${hl(z.toString())}</span></li>`;
    }
    if (t === PB_TYPE.INT32 || t === PB_TYPE.INT64) {
      const signed = s64ToSigned(u);
      return `<li>${tagHtml} <span class="field-type">(${typeLabel(t)})</span> = <span class="field-val-num">${hl(signed.toString())}</span></li>`;
    }
    // UINT32, UINT64, or unknown
    return `<li>${tagHtml} <span class="field-type">(${typeLabel(t)})</span> = <span class="field-val-num">${hl(u.toString())}</span></li>`;
  }
  // schema-less
  const z = zigzag(u);
  return `<li>${tagHtml} <span class="field-type">(varint)</span> = <span class="field-val-num">${hl(u.toString())}</span> <span class="field-type">zigzag=${hl(z.toString())}</span></li>`;
}

function renderFixed(tagHtml, f, def, bits) {
  if (bits === 64) {
    const i = fixed64Interp(f.fixed);
    if (def) {
      if (def.type === PB_TYPE.DOUBLE) return `<li>${tagHtml} <span class="field-type">(double)</span> = <span class="field-val-num">${hl(String(i.f64))}</span></li>`;
      if (def.type === PB_TYPE.SFIXED64) return `<li>${tagHtml} <span class="field-type">(sfixed64)</span> = <span class="field-val-num">${hl(i.i64)}</span></li>`;
      if (def.type === PB_TYPE.FIXED64) return `<li>${tagHtml} <span class="field-type">(fixed64)</span> = <span class="field-val-num">${hl(i.u64)}</span></li>`;
    }
    return `<li>${tagHtml} <span class="field-type">(fixed64)</span> = <span class="field-val-num">u64=${hl(i.u64)}</span> <span class="field-type">i64=${hl(i.i64)} f64=${hl(String(i.f64))} hex=${hl(i.hex)}</span></li>`;
  } else {
    const i = fixed32Interp(f.fixed);
    if (def) {
      if (def.type === PB_TYPE.FLOAT) return `<li>${tagHtml} <span class="field-type">(float)</span> = <span class="field-val-num">${hl(String(i.f32))}</span></li>`;
      if (def.type === PB_TYPE.SFIXED32) return `<li>${tagHtml} <span class="field-type">(sfixed32)</span> = <span class="field-val-num">${hl(i.i32)}</span></li>`;
      if (def.type === PB_TYPE.FIXED32) return `<li>${tagHtml} <span class="field-type">(fixed32)</span> = <span class="field-val-num">${hl(i.u32)}</span></li>`;
    }
    return `<li>${tagHtml} <span class="field-type">(fixed32)</span> = <span class="field-val-num">u32=${hl(i.u32)}</span> <span class="field-type">i32=${hl(i.i32)} f32=${hl(String(i.f32))} hex=${hl(i.hex)}</span></li>`;
  }
}

function detailsOpen(key, defaultOpen = true) {
  // While a query is active the tree renders search-focused: defaults plus
  // matching branches (nodeHit), nothing more. Honoring a full expand-all here
  // meant rebuilding the entire open tree on every keystroke; the expanded
  // state is kept and comes back as soon as the query clears.
  if (searchQuery) return defaultOpen && !userCollapsed.has(key) ? "open" : "";
  if (defaultOpen) return userCollapsed.has(key) ? "" : "open";
  return userExpanded.has(key) ? "open" : "";
}

// Long strings render as a small window with a [full] toggle instead of
// megabytes of text per row; the window re-centers on the first search match
// so its mark stays visible. The whole string stays searchable (the index
// holds all of it) and copyable (fullValues feeds the copy button).
const STR_PREVIEW = 256;
const fullValues = new Map(); // data-fk -> full string, rebuilt per render

function strDisplay(s, key) {
  const tKey = key + ":str";
  const long = s.length > STR_PREVIEW;
  if (!long || detailToggles[tKey] === "full") {
    const toggle = long ? `<button class="toggle" data-key="${escapeHtml(tKey)}" data-to="">[trim]</button>` : "";
    return { attr: "", html: hl(JSON.stringify(s)), toggle };
  }
  let start = 0;
  if (searchQuery) {
    const at = s.toLowerCase().indexOf(searchQuery.toLowerCase());
    if (at > STR_PREVIEW - 60) start = Math.max(0, at - 60);
  }
  const win = (start ? "…" : "") + s.slice(start, start + STR_PREVIEW) + "…";
  fullValues.set(tKey, s);
  return {
    attr: ` data-fk="${escapeHtml(tKey)}"`,
    html: hl(JSON.stringify(win)),
    toggle: `<button class="toggle" data-key="${escapeHtml(tKey)}" data-to="full">[full]</button>`,
  };
}

function renderLengthDelimited(tagHtml, f, def, key, path, myCrumbs, depth) {
  // Schema knows what this is
  if (def) {
    if (def.type === PB_TYPE.STRING) {
      const s = (() => { try { return new TextDecoder("utf-8", { fatal: false }).decode(f.bytes); } catch { return null; } })();
      const sd = strDisplay(s ?? "", key);
      return leafCopy(`<li>${tagHtml} <span class="field-type">(string, ${formatBytes(f.bytes.length)})</span>${sd.toggle} = <span class="field-val-str"${sd.attr}>${sd.html}</span></li>`);
    }
    if (def.type === PB_TYPE.BYTES) {
      return leafCopy(`<li>${tagHtml} <span class="field-type">(bytes, ${formatBytes(f.bytes.length)})</span> = <span class="field-val-hex">${hl(bytesToHex(f.bytes, 64))}</span></li>`);
    }
    if (def.type === PB_TYPE.MESSAGE || def.type === PB_TYPE.GROUP) {
      const subDef = schema && schema.messages.get(def.typeName);
      const typeName = subDef ? subDef.name : (def.typeName || "message").replace(/^\./, "");
      const label = `<span class="field-type">(${hl(typeName)}, ${formatBytes(f.bytes.length)})</span>`;
      // Decode the sub-message only when this node is actually shown.
      return renderMessageNode(tagHtml, label, key,
        () => renderFields(subFields(f), path, myCrumbs, subDef, depth + 1),
        depth, nodeHit(f) && spendHit());
    }
    return leafCopy(`<li>${tagHtml} <span class="field-type">(${typeLabel(def.type)} packed?, ${formatBytes(f.bytes.length)})</span> = <span class="field-val-hex">${hl(bytesToHex(f.bytes, 64))}</span></li>`);
  }

  // Schema-less fallback (heuristic with toggles)
  classifyField(f);
  const showRaw = detailToggles[key] === "raw";
  const showStr = detailToggles[key] === "str";

  if (f._nested && !showRaw && !showStr) {
    const label = `<span class="field-type">(message, ${formatBytes(f.bytes.length)})</span>`;
    const toggles = toggleLinks(key, ["str", "raw"]);
    return renderMessageNode(tagHtml, label + toggles, key,
      () => renderFields(f._nested, path, myCrumbs, null, depth + 1),
      depth, nodeHit(f) && spendHit());
  }

  let label, body, toggles;
  if (f._stringVal !== null && !showRaw) {
    const sd = strDisplay(f._stringVal, key);
    label = `<span class="field-type">(string, ${formatBytes(f.bytes.length)})</span>`;
    body = ` = <span class="field-val-str"${sd.attr}>${sd.html}</span>`;
    toggles = toggleLinks(key, f._nested ? ["msg", "raw"] : ["raw"]) + sd.toggle;
  } else {
    label = `<span class="field-type">(bytes, ${formatBytes(f.bytes.length)})</span>`;
    body = ` = <span class="field-val-hex">${hl(bytesToHex(f.bytes, 48))}</span>`;
    const alts = [];
    if (f._nested) alts.push("msg");
    if (f._stringVal !== null) alts.push("str");
    toggles = toggleLinks(key, alts);
  }
  return leafCopy(`<li>${tagHtml} ${label}${toggles}${body}</li>`);
}

const TOGGLE_TITLES = {
  msg: "decode as a nested message",
  str: "interpret bytes as a UTF-8 string",
  raw: "show raw bytes as hex",
};

function toggleLinks(key, alts) {
  if (alts.length === 0) return "";
  return alts.map((a) =>
    `<button class="toggle" title="${escapeHtml(TOGGLE_TITLES[a] || "")}" data-key="${escapeHtml(key)}" data-to="${a === "msg" ? "" : a}">[${a}]</button>`
  ).join("");
}

renderDetail();

chrome.storage.local.get(["schemaB64", "schemaName"], (data) => {
  if (!data || !data.schemaB64) return;
  try {
    const bytes = base64ToBytes(data.schemaB64);
    const fileSet = parseFileDescriptorSet(bytes);
    schema = buildSchemaIndex(fileSet);
    invalidateSearch();
    const name = data.schemaName || "schema";
    setSchemaStatus(name, "loaded",
      `${name} — ${schema.messages.size} messages, ${schema.methods.size} RPCs. Click to replace.`);
    renderDetail();
  } catch (e) {
    setSchemaStatus("schema error", "error", "load failed: " + e.message);
  }
});
