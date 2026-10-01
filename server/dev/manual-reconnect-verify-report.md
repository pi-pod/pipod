# Manual reconnect verification

## Run

From this checkout, with model credentials available to Pi:

```sh
PI_POD_TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  node --import tsx dev/manual-reconnect-verify.mts
```

Use a disposable, migrated PostgreSQL database. Fixtures have unique IDs and
are deleted afterward. Without a database, the harness verifies readiness but
cannot verify client hello/durable replay. Defaults: `EXPECT=post`, `SLEEP_SEC=90`,
`OUTAGE_MS=15000`. `EXPECT=pre` checks the original failure signature on an
unpatched checkout.

## Baseline

On unpatched commit `2f4ff9e`, both the disconnected attach and reconnect during
an outstanding `get_state` selected `endSession("transport_lost",
{retireSupervisor:true})`. The latter reported "connection to the pi session was
replaced", then "Pi RPC stayed unresponsive; replacing its supervisor".

The baseline used a recording teardown spy: it demonstrated the destructive
recovery decision, not an actual process kill. Independently, an ordinary
hot-reconnect preserved a real Pi tool and its subsequent model response.

## Final verification — 2026-09-04

**17/17 checks passed**, real Pi 0.84.4, generated agentd, local WebSocket
transport, actual gateway readiness/attach code, and PostgreSQL 15. Total wall
time: 95 seconds. The Pi agent ran `sleep 90 && echo SLEEP-90-DONE-MARKER`.

| Scenario | Observed result |
| --- | --- |
| Disconnected attach | Waited for reconnect; no supervisor retirement |
| Retry after reconnect | Successful client hello |
| Rebind during pending `get_state` | Pending request demonstrably struck; no session teardown; retry returned hello |
| 15-second outage: existing-session attach | 12-second wait expired; ended gateway session **without** retiring supervisor |
| 15-second outage: disconnected-supervisor recovery | Actual `recoverDisconnectedSupervisor` waited on the real registry, confirmed daemon PID alive, returned retryable conflict; **zero replacement calls** |
| Attach after long outage | Successful client hello |
| Durable replay | Seeded events `[1,2]` and unanswered interaction delivered |
| Tool and model continuation | Tool completed at ~90 seconds; `agent_end`; assistant replied `FINISHED-90` |
| Process continuity | Same supervisor PID alive throughout every fault and completion |

Final console summary:

```text
[PASS] real/outage-supervisor-recovery
[PASS] real/outage-adopted
[PASS] real/survival
      actual: toolOk=true modelOk=true text="FINISHED-90"
[PASS] real/survival/supervisor-pid
===== verdicts: 17/17 match EXPECT=post (0 UNTESTED) =====
RESULT: fix verified across 17 checks (0 UNTESTED)
```

Also passed: `npm run check` with PostgreSQL enabled (**871 tests**, zero skipped),
`npm run build`, and the **17** focused regressions in
`test/gateway-reconnect.test.ts`.

## Scope

- Local fault injection, not a deployed cloud-provider pod test; no production
  connections were interrupted.
- Gateway `endSession` is a recording spy in the manual harness. Assertions prove
  the gateway does not request supervisor retirement; they do not execute a kill.
  Separate unit tests exercise real teardown with a recording provider-exec seam.
- Outage adoption uses the production helper called by `attach()`, a real
  registry wait, and an OS check of the test daemon. Provider provisioning and
  provider-exec transport are not exercised.
- Harness sessions do not register the production lifecycle listener; reconnect
  reproduces its synchronous `transportRebinding` guard and journal replay.
- Test daemons and database fixture rows are cleaned up after each run.
