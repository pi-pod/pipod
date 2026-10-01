Never write or run unit tests.

Simulator work uses the maintainer workspace's `ios-simulator-testing` skill when it is present. Shared native notes are `../docs/native-mobile-testing.md`. Tailnet connectivity is not Mac SSH approval. If that skill stops on a browser check, an enrollment key, or a GUI login, stop that path. Do not mint a key or re-register the node.

Native manual testing connects with `tailscale ssh agent@mac-mini-m4` as the standard `agent` account. Follow the maintainer workspace's `native-app-manual-testing` skill when it is present for auth-key-only Tailscale SSH enrollment and host verification, and this repository's `docs/manual-testing.md` for the platform workflow.
