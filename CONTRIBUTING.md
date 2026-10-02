# Contributing

## Before you start

The hosted service at pipod.dev is built on this code, so every contribution has to be licensed
to us under terms that let us use it there as well as under the AGPL. That takes the
[contributor license agreement](CLA.md): you keep your copyright and grant Billzo, LLC a broad
license to your contributions. Sign it once by commenting on your first pull request:

> I have read the CLA Document and I hereby sign the CLA

The `cla` check on the pull request tells you whether every commit author has signed, and we
cannot merge until it passes. Every commit must be authored with an email linked to a GitHub
account.

To report a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Workflow

1. **Branch** from `main`. Never commit straight to `main`.
2. **Keep it small.** One purpose per pull request. A reviewable diff beats a complete one.
3. **Check it.** Run the checks for every component you changed:
   - `cli/`, `server/`, `sandbox/`: `npm ci && npm run check && npm run build`
   - `ios/`: `xcodegen generate`, then `xcodebuild build -project PiPod.xcodeproj -scheme PiPod
     -destination 'generic/platform=iOS Simulator' CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO
     CODE_SIGNING_ALLOWED=YES`
   - `android/`: `./gradlew :app:assembleDebug`
   - the pi pin: `make check-pi-pins`
4. **Run what you changed.** Checks do not replace running it, especially anything that touches
   pod provisioning, the PTY, or session lifecycle. For the apps, use a simulator or emulator and
   look at the screens. Say in the pull request what you ran and what you did not cover.
5. **Open a pull request** against `main`. CI runs the checks for the components you touched.

## Rules that matter

- **No secrets in git**: no tokens, API keys, `.env` files, JWTs, or real user data, in code,
  tests, fixtures, or commit messages. If you leak one, rotate it first.
- **Least complexity.** Prefer the change that removes complexity. New options, configuration
  keys, and layers each need a reason.
- **Don't hand-edit synced code.** Files marked `[shared]` in `server/scripts/core-manifest.txt`
  are copied from `cli/`. Change them there and run `server/scripts/sync-core.sh ../cli`.
- **Don't hand-edit the pi pin.** Use `make bump-pi VERSION=x.y.z`.
- **Schema changes are new migrations** in `server/migrations/`. Never edit `000_baseline.sql`.
- **Follow the nearest `AGENTS.md`.** Those notes are narrower and win over this file.

## Commits

A short imperative subject; the body explains why. In the pull request, say what changed, how you
verified it, and what you deliberately left out.

By participating you agree to the [code of conduct](CODE_OF_CONDUCT.md).
