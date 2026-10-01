# Local image attachments

The TUI runs on your machine; the agent runs in the pod. When your prompt names an
image file that exists **on your machine**, pi-pod reads it locally, processes it with
pi's own image pipeline, and sends it inline with the prompt — the pod never needs the
file. Anything that does not resolve locally is left byte-identical, so pod-side `@`
references and pod paths keep working exactly as before.

## What gets attached

- Clipboard pastes (pi saves the clipboard image under your `/tmp` and inserts the
  bare path), drag-dropped files, `@screenshot.png` mentions, and typed paths —
  absolute, `~/…`, `./…`, `../…`, quoted, or `file://…`. Bare absolute paths stay
  eligible on purpose: that is exactly what pastes and drag-drops insert.
- Detection is by content sniff, not suffix: PNG, JPEG, GIF, and WebP go through pi's
  resize to inline limits (2000px, ~4.5MB); BMP, animated PNG, and anything else gets
  one PNG conversion attempt first.
- The sent text keeps your words and gains one marker line per image:
  `<file name="shot.png"></file>` (or an `[Image omitted: …]` note when a real local
  file could not be attached). The marker carries only the **basename**, XML-escaped —
  the pod can never open the host path, so the full path would only leak your
  directory layout into the persisted transcript. The marker is what you see echoed
  in your own message.

## Bounds

These mirror what the gateway enforces on `prompt` / `steer` / `follow_up`, so a
prompt built here is never rejected server-side (a rejected prompt sends nothing at
all — degrading an over-budget image to a text reference is strictly more useful):

- At most **8 images per prompt, including images already attached** (e.g. by an
  extension). Extras stay plain text and you get a warning.
- At most **8 MiB decoded per image** and **32 MiB of base64 total** across the turn
  (~24 MiB decoded). Over-budget images are omitted with a note, never sent.
- Reads are bounded (one open, one stat, one capped 24 MB read), regular files only —
  never directories, devices, or sockets. A file that grows mid-read is detected, not
  loaded. Only paths your prompt text actually names are read; nothing is scanned
  speculatively.
- Extension-supplied message parts are forwarded verbatim and never scanned: only text
  you typed (or pasted) names files on purpose. A bare word like `a.png` in prose
  does **not** attach (only `@a.png` does), and URLs and `data:` URIs never attach.

## What the pod sees

Images ride the existing `prompt` / `steer` / `follow_up` RPC `images` field — the
same shape pi's own `@file` CLI attachments produce. No new protocol, no server
change. One-shot prompts (`pipod attach <pod> -- "look at ./shot.png"`) attach the
same way; attach failures are reported on stderr there, as a TUI notice here.

## Limits

- The image bytes travel **inline** with the turn; the file itself is not copied into
  the pod. If the agent later tries to `read` the host path inside the pod, that read
  fails — but the model already has the image, so it does not need to. (Copying the
  file into the pod workspace would need a server-side upload channel; that is
  intentionally out of scope.)
- Pod-side images need no help: `@` completion already resolves against the pod
  workspace, and the pod-side `read` tool returns those images itself.
