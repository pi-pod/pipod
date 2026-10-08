# Derived images

`POST /v1/images/derive` makes an image the host has no builder for: `base` plus one layer
holding whatever `script` leaves on disk. A self-hosted server uses it for the variants of the
pod base image that carry a template's Pi packages and bake script, so only the first launch
of a recipe runs them; later launches boot with both already installed.

```json
{ "base": "127.0.0.1:5000/pipod/pi-pod-base:<tag>", "ref": "127.0.0.1:5000/pipod/pi-pod-base:<tag>-pkg…-bake…", "script": "…", "resources": { "cpu": 2, "memoryGB": 4, "diskGB": 20 } }
```

## Where it publishes

Only beside its base, in a loopback registry (`127.0.0.0/8` or `localhost`, the one the host
already pulls from over plain HTTP): in `selfhost/compose.yml`, the bundled registry that
shares the sandbox's network namespace. Anything else is refused at once with
`409 derive_unavailable`, and the caller prepares the image another way; a hosted host,
whose mirror is a private remote registry, never publishes. No registry credential is sent.
The result is published before it is pulled, so restarts, layer repair and garbage
collection re-pull it like any other image.

## How

1. `ref` already cached locally, or already in the registry: return it (pulling if needed).
2. Create a disposable sandbox from the base, pinned by digest, labelled
   `pi-pod-sandbox/purpose=image-build`, with the requested ceiling (admission applies),
   no env, no owner and open egress (private addresses stay blocked, as for every sandbox).
   Its overlay is mounted with `redirect_dir=off`, so a renamed image directory is copied
   rather than recorded as a redirect no OCI layer can express.
3. Run the script as root in `/root`, read from stdin into a file (no argument-size limit),
   with a 30-minute limit. A non-zero exit fails the derive with the end of its output.
4. Stop the sandbox and turn its upper directory into an OCI layer: 0/0 character devices
   become `.wh.<name>`, opaque directories gain `.wh..wh..opq`, other xattrs are kept,
   `trusted.overlay.*` is dropped, and the runtime's `/.pps-init` stub is excluded. An upper
   with a redirect or metacopy xattr is refused rather than published wrong.
5. Push the zstd layer, a config extending the base's, and an OCI manifest naming the
   base's layers plus the new one; pull `ref` through the verified path; delete the sandbox.

Concurrent calls for one `ref` share a derivation. The response is newline-delimited JSON
(`{"log"}`, `{"heartbeat"}` every 30 s, then `{"done"}` or `{"error"}`), because a build
outlasts any reasonable header deadline; a refused request is still a plain 4xx. A
derivation finishes even if its client leaves. Build sandboxes left by a restart are deleted
at boot.

## Costs

Every cached image is re-verified at boot before the service listens, so each variant adds
to restart time (about 90 s for a 3 GB variant on a workstation disk), and each keeps its
blobs in both the image store and the registry.
