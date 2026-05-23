# Protopeek

A Chrome DevTools extension that decodes gRPC-Web request and response payloads inline. Works on any gRPC-Web transport.

Adds a **Protopeek** tab to DevTools that shows every captured call with:
- Decoded request and response frames, one entry per streamed message.
- Schema-less protobuf wire-format decoding by default (field numbers, inferred types, nested-message detection).
- Optional schema-aware decoding when you load a `FileDescriptorSet` — replaces `#N` with field names, decodes enums, and uses the declared `.proto` type for varints / fixed / message fields.
- Collapsible frames and nested messages, with state that persists across re-renders.
- Search box that filters the call list and highlights matches inline.
- Trailer block with `grpc-status` / `grpc-message`.

## Install

```bash
git clone git@github.com:tituscarl/protopeek.git
```

Then in Chrome:
1. `chrome://extensions`
2. Toggle **Developer mode** (top-right).
3. **Load unpacked** → select the cloned `protopeek` folder.
4. Open DevTools on any page that talks gRPC-Web → click the **Protopeek** tab.

Updates: `git pull`, then click the reload icon on the extension card at `chrome://extensions`.

## Loading a schema (for field names)

Without a schema you only see field numbers (`#1`, `#2`, …). To get field names, enum names, and proper type decoding, load a `FileDescriptorSet`.

Generate one once from your `.proto` sources:

```bash
# Recommended — buf handles the imports for google.protobuf.* automatically
cd /path/to/your/proto/repo
buf build -o schema.binpb

# Or with protoc — must use --include_imports for well-known types
protoc --descriptor_set_out=schema.binpb \
  --include_imports \
  -I . \
  $(find . -name '*.proto')
```

In the DevTools panel:
1. Click **load schema** in the sidebar.
2. Pick the generated `.binpb` file.
3. The status line shows `<N> msgs · <M> RPCs · loaded`.

The schema persists in `chrome.storage.local` across DevTools sessions. Click **forget** to clear it. Regenerate the file whenever your `.proto` definitions change and re-load.

## How it works

- Listens on `chrome.devtools.network.onRequestFinished`, filters for `application/grpc-web*` content types.
- Reads request bytes from `request.postData.text` (Chrome serves binary POST bodies as a Latin-1 string).
- Reads response bytes via `request.getContent` (base64-encoded for binary).
- Parses gRPC-Web frames (5-byte header: 1 flag + 4-byte BE length; flag `0x80` marks the trailer).
- Decodes protobuf wire format inline — varints, fixed32/64, length-delimited. Length-delimited fields try a strict nested-message decode first; if that doesn't consume the whole slice, falls back to printable string, then hex.
- When a `FileDescriptorSet` is loaded, looks up the input/output message type by request path `/<package>.<Service>/<Method>` and walks the message definition to replace field numbers with names, decode enums, and pick the correct interpretation for varint / fixed types (e.g. `sint32` zigzag, `double` vs `uint64`).

## Limitations

- Calls fired **before** the Protopeek panel is opened in DevTools are missed.
- Streaming RPCs: only frames present when the request finishes are shown; long-running streams may appear truncated until the connection closes.
- `getContent` exposes the full response body only after the response is complete. There's no per-frame live streaming.
- Schema-less varint values are ambiguous between signed / unsigned / zigzag — both interpretations are shown.

