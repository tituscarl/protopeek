"use strict";

const calls = [];
const liById = new Map();
let nextId = 1;
let selectedId = null;
let detailToggles = {};
const userCollapsed = new Set(); // overrides default-open
const userExpanded = new Set();  // overrides default-closed
let searchQuery = "";
let schema = null; // { messages: Map<fqn, MessageDef>, enums: Map<fqn, EnumDef>, methods: Map<path, {inputType, outputType}> }

// Render-time registry of frame bodies whose decode + HTML build is deferred
// until the frame is expanded. Rebuilt on every renderDetail().
const lazyBodies = new Map();

// Cap on how much payload text we index for search, per call. Decoding whole
// multi-MB payloads to a searchable string on capture is what made bursts of
// large calls crawl, so we bound it and build it lazily (see payloadSearchText).
const SEARCH_TEXT_CAP = 256 * 1024;

// Nested messages up to this depth render expanded; deeper levels render
// collapsed and decode on expand, so opening one frame can't cascade an
// arbitrarily deep tree into the DOM at once.
const AUTO_OPEN_DEPTH = 2;

// Keep only the most recent N calls. Past this, the oldest are evicted so a
// long-running session under heavy traffic doesn't grow memory/DOM unbounded.
const MAX_CALLS = 500;

const callsEl = document.getElementById("calls");
const detailEl = document.getElementById("detail");
const schemaStatusEl = document.getElementById("schema-status");
const schemaFileEl = document.getElementById("schema-file");

document.getElementById("clear").addEventListener("click", () => {
  calls.length = 0;
  liById.clear();
  selectedId = null;
  detailToggles = {};
  userCollapsed.clear();
  userExpanded.clear();
  callsEl.textContent = "";
  renderDetail();
});

const searchEl = document.getElementById("search");
let searchDebounce = 0;
searchEl.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = searchEl.value;
    applySearch();
    renderDetail();
  }, 50);
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
});

document.getElementById("load-schema").addEventListener("click", () => {
  schemaFileEl.click();
});

document.getElementById("clear-schema").addEventListener("click", () => {
  schema = null;
  chrome.storage.local.remove("schemaB64", () => {
    setSchemaStatus("no schema");
    renderDetail();
  });
});

schemaFileEl.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result);
    try {
      const fileSet = parseFileDescriptorSet(bytes);
      schema = buildSchemaIndex(fileSet);
      const b64 = bytesToBase64(bytes);
      chrome.storage.local.set({ schemaB64: b64 }, () => {
        setSchemaStatus(`${schema.messages.size} msgs · ${schema.methods.size} RPCs`, "loaded");
        renderDetail();
      });
    } catch (err) {
      setSchemaStatus("parse failed: " + err.message, "error");
    }
  };
  reader.readAsArrayBuffer(file);
  schemaFileEl.value = "";
});

function setSchemaStatus(text, cls) {
  schemaStatusEl.textContent = text;
  schemaStatusEl.className = cls || "";
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
    try {
      if (content == null) return;
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
    } catch (e) {
      entry.error = (entry.error ? entry.error + "; " : "") + "response decode: " + e.message;
    }
    refreshEntryVisibility(entry);
    if (selectedId === entry.id) renderDetail();
  });
}

// Build (once) the searchable payload text for a call, capped at SEARCH_TEXT_CAP.
// Only called when there's an actual query, so calls that are never searched
// never pay the decode cost. Invalidated by setting entry._payloadText = null.
function payloadSearchText(entry) {
  if (entry._payloadText != null) return entry._payloadText;
  const dec = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  for (const frames of [entry.reqFrames, entry.resFrames]) {
    if (!frames) continue;
    for (const f of frames) {
      const remaining = SEARCH_TEXT_CAP - text.length;
      if (remaining <= 0) break;
      const slice = f.payload.length > remaining ? f.payload.subarray(0, remaining) : f.payload;
      try { text += dec.decode(slice) + "\n"; } catch {}
    }
    if (text.length >= SEARCH_TEXT_CAP) break;
  }
  entry._payloadText = text.toLowerCase();
  return entry._payloadText;
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

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  const end = Math.min(buf.length, pos + 10);
  while (i < end) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, next: i };
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
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
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
  f._stringVal = f._nested ? null : tryString(f.bytes);
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
  return (n >> 1n) ^ -(n & 1n);
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
function hl(text) {
  if (text == null) return "";
  const s = String(text);
  const q = searchQuery;
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
  const httpClass = entry.status >= 200 && entry.status < 400 ? "status-ok" : "status-bad";
  // A 200 with grpc-status != 0 is a failed RPC — surface it so the row doesn't
  // read as green/OK. grpc-status is only known once the trailer is parsed.
  const grpcBad = entry.grpcStatus != null && entry.grpcStatus !== "0";
  const grpcBadge = grpcBad ? ` · <span class="status-bad">gRPC ${hl(entry.grpcStatus)}</span>` : "";
  const time = entry.startedLabel ? `${entry.startedLabel} · ` : "";
  return `<div class="method">${hl(entry.method)}</div>` +
         `<div class="meta"><span class="seq">#${entry.id}</span> · ${time}` +
         `<span class="${httpClass}">HTTP ${entry.status}</span>${grpcBadge} · ${formatDuration(entry.timeMs)}</div>`;
}

function appendListItem(entry) {
  const li = document.createElement("li");
  li.dataset.id = String(entry.id);
  if (entry.id === selectedId) li.classList.add("selected");
  li.innerHTML = listItemHtml(entry);
  if (searchQuery && !entryMatches(entry, searchQuery)) li.hidden = true;
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

function applySearch() {
  for (const entry of calls) {
    const li = liById.get(entry.id);
    if (!li) continue;
    const matches = !searchQuery || entryMatches(entry, searchQuery);
    li.hidden = !matches;
    if (matches) li.innerHTML = listItemHtml(entry);
  }
}

function refreshEntryVisibility(entry) {
  const li = liById.get(entry.id);
  if (!li) return;
  // The response just arrived, so grpc-status / duration may now be known.
  li.innerHTML = listItemHtml(entry);
  li.hidden = searchQuery ? !entryMatches(entry, searchQuery) : false;
}

function setSelection(id) {
  if (selectedId === id) return;
  const prev = liById.get(selectedId);
  if (prev) prev.classList.remove("selected");
  selectedId = id;
  const next = liById.get(id);
  if (next) next.classList.add("selected");
}

function renderDetail() {
  lazyBodies.clear();
  const entry = calls.find((c) => c.id === selectedId);
  if (!entry) {
    detailEl.innerHTML = '<div class="placeholder">Select a call to inspect.</div>';
    return;
  }

  const methodDef = schema ? schema.methods.get(entry.method) : null;
  const inputDef = methodDef ? schema.messages.get(methodDef.inputType) : null;
  const outputDef = methodDef ? schema.messages.get(methodDef.outputType) : null;

  const parts = [];
  parts.push(`<h1>${hl(entry.method)}</h1>`);
  parts.push(`<div class="url">${hl(entry.url)}</div>`);
  if (methodDef) {
    parts.push(`<div class="url"><span class="field-name">${hl(methodDef.inputType || "?")}</span> &rarr; <span class="field-name">${hl(methodDef.outputType || "?")}</span></div>`);
  } else if (schema) {
    parts.push(`<div class="url"><em>no schema entry for this method</em></div>`);
  }

  if (entry.error) {
    parts.push(`<section><h3>Errors</h3><div class="frame trailer bad"><div class="frame-body">${escapeHtml(entry.error)}</div></div></section>`);
  }

  parts.push("<section><h3>Request</h3>" + renderFrames(entry.reqFrames, `${entry.id}.req`, inputDef) + "</section>");
  parts.push("<section><h3>Response</h3>" + renderFrames(entry.resFrames, `${entry.id}.res`, outputDef) + "</section>");

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
}

detailEl.addEventListener("click", (e) => {
  const t = e.target.closest && e.target.closest(".toggle");
  if (!t || !detailEl.contains(t)) return;
  e.stopPropagation();
  e.preventDefault();
  const k = t.getAttribute("data-key");
  const to = t.getAttribute("data-to");
  if (to === "") delete detailToggles[k];
  else detailToggles[k] = to;
  renderDetail();
});

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
  const lazyKey = el.getAttribute("data-lazy");
  if (lazyKey && el.open) {
    const build = lazyBodies.get(lazyKey);
    if (build) {
      el.insertAdjacentHTML("beforeend", build());
      lazyBodies.delete(lazyKey);
    }
  }
}, true);

function decodedFields(frame) {
  if (frame._fields === undefined) {
    try { frame._fields = decodeMessage(frame.payload, false) || []; }
    catch { frame._fields = []; }
  }
  return frame._fields;
}

function renderFrames(frames, kind, messageDef) {
  if (frames == null) return '<div class="placeholder" style="padding:8px">(no body captured)</div>';
  if (frames.length === 0) return '<div class="placeholder" style="padding:8px">(empty)</div>';
  return frames.map((f, idx) => {
    const frameKey = `${kind}-${idx}-frame`;
    const flagHex = f.flag.toString(16).padStart(2, "0");
    const summary =
      `<summary class="frame-hdr">data frame #${idx} · ${f.payload.length} B · flag 0x${flagHex}` +
      `${messageDef ? ` · <span class="field-name">${hl(messageDef.name)}</span>` : ""}</summary>`;
    // Decode the wire format and build the field tree only when actually shown.
    const renderBody = () =>
      `<div class="frame-body"><ul class="fields">` +
      `${renderFields(decodedFields(f), `${kind}-${idx}`, [], messageDef)}</ul></div>`;

    if (detailsOpen(frameKey, false) === "open" || bytesContainQuery(f.payload)) {
      return `<details class="frame" open data-key="${escapeHtml(frameKey)}" data-default="closed">` +
             summary + renderBody() + `</details>`;
    }
    // Collapsed: emit only the summary and defer the body until expanded. This
    // is what keeps a burst of large calls cheap — nothing under a closed frame
    // is decoded or turned into DOM.
    lazyBodies.set(frameKey, renderBody);
    return `<details class="frame" data-key="${escapeHtml(frameKey)}" data-default="closed" data-lazy="${escapeHtml(frameKey)}">` +
           summary + `</details>`;
  }).join("");
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

function s64ToSigned(u) { // BigInt unsigned 64 -> signed
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

function renderFields(fields, path, crumbs, messageDef, depth = 0) {
  if (!fields || fields.length === 0) return '<li class="field-type">(empty)</li>';
  const defByNum = defByNumFor(messageDef);

  return fields.map((f, idx) => {
    const myCrumbs = crumbs.concat(idx);
    const key = `${path}.${myCrumbs.join(".")}`;
    const def = defByNum ? defByNum.get(f.fieldNumber) : null;

    const tagHtml = def
      ? `<span class="field-name">${hl(def.name)}</span> <span class="field-type">#${f.fieldNumber}</span>`
      : `<span class="field-tag">#${f.fieldNumber}</span>`;

    if (f.wireType === 0) return renderVarint(tagHtml, f, def);
    if (f.wireType === 1) return renderFixed(tagHtml, f, def, 64);
    if (f.wireType === 5) return renderFixed(tagHtml, f, def, 32);

    // wireType 2 — length-delimited
    return renderLengthDelimited(tagHtml, f, def, key, path, myCrumbs, depth);
  }).join("");
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
      const v = u === 0n ? "false" : "true";
      return `<li>${tagHtml} <span class="field-type">(bool)</span> = <span class="field-val-num">${v}</span></li>`;
    }
    if (t === PB_TYPE.ENUM) {
      const enumDef = schema && schema.enums.get(def.typeName);
      const vDef = enumDef && enumDef.values.find((v) => v.number === Number(u));
      const name = vDef ? vDef.name : null;
      const display = name ? `<span class="enum-name">${hl(name)}</span> <span class="field-type">(${u.toString()})</span>` : `<span class="field-val-num">${u.toString()}</span>`;
      const enumLabel = enumDef ? hl(enumDef.name) : "enum";
      return `<li>${tagHtml} <span class="field-type">(${enumLabel})</span> = ${display}</li>`;
    }
    if (t === PB_TYPE.SINT32 || t === PB_TYPE.SINT64) {
      const z = zigzag(u);
      return `<li>${tagHtml} <span class="field-type">(${typeLabel(t)})</span> = <span class="field-val-num">${z.toString()}</span></li>`;
    }
    if (t === PB_TYPE.INT32 || t === PB_TYPE.INT64) {
      const signed = s64ToSigned(u);
      return `<li>${tagHtml} <span class="field-type">(${typeLabel(t)})</span> = <span class="field-val-num">${signed.toString()}</span></li>`;
    }
    // UINT32, UINT64, or unknown
    return `<li>${tagHtml} <span class="field-type">(${typeLabel(t)})</span> = <span class="field-val-num">${u.toString()}</span></li>`;
  }
  // schema-less
  const z = zigzag(u);
  return `<li>${tagHtml} <span class="field-type">(varint)</span> = <span class="field-val-num">${u.toString()}</span> <span class="field-type">zigzag=${z.toString()}</span></li>`;
}

function renderFixed(tagHtml, f, def, bits) {
  if (bits === 64) {
    const i = fixed64Interp(f.fixed);
    if (def) {
      if (def.type === PB_TYPE.DOUBLE) return `<li>${tagHtml} <span class="field-type">(double)</span> = <span class="field-val-num">${escapeHtml(String(i.f64))}</span></li>`;
      if (def.type === PB_TYPE.SFIXED64) return `<li>${tagHtml} <span class="field-type">(sfixed64)</span> = <span class="field-val-num">${i.i64}</span></li>`;
      if (def.type === PB_TYPE.FIXED64) return `<li>${tagHtml} <span class="field-type">(fixed64)</span> = <span class="field-val-num">${i.u64}</span></li>`;
    }
    return `<li>${tagHtml} <span class="field-type">(fixed64)</span> = <span class="field-val-num">u64=${i.u64}</span> <span class="field-type">i64=${i.i64} f64=${escapeHtml(String(i.f64))} hex=${i.hex}</span></li>`;
  } else {
    const i = fixed32Interp(f.fixed);
    if (def) {
      if (def.type === PB_TYPE.FLOAT) return `<li>${tagHtml} <span class="field-type">(float)</span> = <span class="field-val-num">${escapeHtml(String(i.f32))}</span></li>`;
      if (def.type === PB_TYPE.SFIXED32) return `<li>${tagHtml} <span class="field-type">(sfixed32)</span> = <span class="field-val-num">${i.i32}</span></li>`;
      if (def.type === PB_TYPE.FIXED32) return `<li>${tagHtml} <span class="field-type">(fixed32)</span> = <span class="field-val-num">${i.u32}</span></li>`;
    }
    return `<li>${tagHtml} <span class="field-type">(fixed32)</span> = <span class="field-val-num">u32=${i.u32}</span> <span class="field-type">i32=${i.i32} f32=${escapeHtml(String(i.f32))} hex=${i.hex}</span></li>`;
  }
}

function detailsOpen(key, defaultOpen = true) {
  if (defaultOpen) return userCollapsed.has(key) ? "" : "open";
  return userExpanded.has(key) ? "open" : "";
}

// During search we no longer blindly force every node open (that re-materialized
// the whole tree on each keystroke and defeated lazy rendering). Instead a node
// auto-opens only when its own bytes contain the query, so just the matching
// branches — plus their siblings at each open level — get decoded and rendered.
function bytesContainQuery(bytes) {
  if (!searchQuery || !bytes || bytes.length === 0) return false;
  const cap = 64 * 1024;
  const slice = bytes.length > cap ? bytes.subarray(0, cap) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(slice).toLowerCase()
      .includes(searchQuery.toLowerCase());
  } catch {
    return false;
  }
}

function renderLengthDelimited(tagHtml, f, def, key, path, myCrumbs, depth) {
  // Schema knows what this is
  if (def) {
    if (def.type === PB_TYPE.STRING) {
      const s = (() => { try { return new TextDecoder("utf-8", { fatal: false }).decode(f.bytes); } catch { return null; } })();
      return `<li>${tagHtml} <span class="field-type">(string, ${f.bytes.length} B)</span> = <span class="field-val-str">${hl(JSON.stringify(s ?? ""))}</span></li>`;
    }
    if (def.type === PB_TYPE.BYTES) {
      return `<li>${tagHtml} <span class="field-type">(bytes, ${f.bytes.length} B)</span> = <span class="field-val-hex">${bytesToHex(f.bytes, 64)}</span></li>`;
    }
    if (def.type === PB_TYPE.MESSAGE || def.type === PB_TYPE.GROUP) {
      const subDef = schema && schema.messages.get(def.typeName);
      const typeName = subDef ? subDef.name : (def.typeName || "message").replace(/^\./, "");
      const label = `<span class="field-type">(${hl(typeName)}, ${f.bytes.length} B)</span>`;
      // Decode the sub-message only when this node is actually shown.
      return renderMessageNode(tagHtml, label, key,
        () => renderFields(decodeMessage(f.bytes, false) || [], path, myCrumbs, subDef, depth + 1),
        depth, bytesContainQuery(f.bytes));
    }
    return `<li>${tagHtml} <span class="field-type">(${typeLabel(def.type)} packed?, ${f.bytes.length} B)</span> = <span class="field-val-hex">${bytesToHex(f.bytes, 64)}</span></li>`;
  }

  // Schema-less fallback (heuristic with toggles)
  classifyField(f);
  const showRaw = detailToggles[key] === "raw";
  const showStr = detailToggles[key] === "str";

  if (f._nested && !showRaw && !showStr) {
    const label = `<span class="field-type">(message, ${f.bytes.length} B)</span>`;
    const toggles = toggleLinks(key, ["str", "raw"]);
    return renderMessageNode(tagHtml, label + toggles, key,
      () => renderFields(f._nested, path, myCrumbs, null, depth + 1),
      depth, bytesContainQuery(f.bytes));
  }

  let label, body, toggles;
  if (f._stringVal !== null && !showRaw) {
    label = `<span class="field-type">(string, ${f.bytes.length} B)</span>`;
    body = ` = <span class="field-val-str">${hl(JSON.stringify(f._stringVal))}</span>`;
    toggles = toggleLinks(key, f._nested ? ["msg", "raw"] : ["raw"]);
  } else {
    label = `<span class="field-type">(bytes, ${f.bytes.length} B)</span>`;
    body = ` = <span class="field-val-hex">${bytesToHex(f.bytes, 48)}</span>`;
    const alts = [];
    if (f._nested) alts.push("msg");
    if (f._stringVal !== null) alts.push("str");
    toggles = toggleLinks(key, alts);
  }
  return `<li>${tagHtml} ${label}${toggles}${body}</li>`;
}

const TOGGLE_TITLES = {
  msg: "decode as a nested message",
  str: "interpret bytes as a UTF-8 string",
  raw: "show raw bytes as hex",
};

function toggleLinks(key, alts) {
  if (alts.length === 0) return "";
  return alts.map((a) =>
    `<span class="toggle" title="${escapeHtml(TOGGLE_TITLES[a] || "")}" data-key="${escapeHtml(key)}" data-to="${a === "msg" ? "" : a}">[${a}]</span>`
  ).join("");
}

renderDetail();

chrome.storage.local.get("schemaB64", (data) => {
  if (!data || !data.schemaB64) return;
  try {
    const bytes = base64ToBytes(data.schemaB64);
    const fileSet = parseFileDescriptorSet(bytes);
    schema = buildSchemaIndex(fileSet);
    setSchemaStatus(`${schema.messages.size} msgs · ${schema.methods.size} RPCs`, "loaded");
    renderDetail();
  } catch (e) {
    setSchemaStatus("load failed: " + e.message, "error");
  }
});
