# Integration-only CI

CI again runs the existing `test:integration` entrypoint, now selecting eleven
explicit reviewed files rather than every file under `test/integration`.
They exercise actual CLI dispatch, account/project files, HTTP/WebSockets,
Git/tar subprocesses, OIDC signatures, or extension loading. Some collaborators
remain fixtures; passing does not prove production remote connectivity.

`account-billing.test.ts` contains isolated formatting cases and
`plan-change-cli.test.ts` contains a fully mocked timeout case. Both files remain
unchanged and are excluded as a whole. This also omits their genuine HTTP billing
coverage: the selection is not the full prior integration suite. Extracting those
existing cases requires a separate reviewed change. Do not reintroduce a directory
glob, broad name filters, or unit execution to make CI appear complete.

Typecheck, lint and build remain required. Restoring CI does not publish a package
or deploy a server. No production credentials are needed by these fixtures.
