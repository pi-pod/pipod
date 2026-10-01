# CI

The repository workflow (`../.github/workflows/ci.yml`) runs the server job on every pull
request and push to `main`: a Postgres service, `npm run migrate`, `npm run check` (core drift,
pi pin, typecheck), and `npm run build`. It uses no secrets and no network fixtures.

`test/native-integration.test.ts` checks the direct host contract against a real native sandbox
service and skips unless `PI_POD_TEST_NATIVE_URL` names one.
