# Pinned Zitadel release

| Field | Value |
| --- | --- |
| Version | **v4.17.1** |
| Image | `ghcr.io/zitadel/zitadel:v4.17.1` |
| Digest (linux/amd64) | `sha256:dbc32fd988f5725d490a145cdbbbacb4439ff946b6f9f519ae3d8dc1c0c75110` |
| Index digest | `sha256:3ac6910685d48f32481f01f45e3e6215efe5a9df2c069591b481e9a101712db5` |
| Selected | 2026-08-28 |
| Why this release | Latest stable v4 patch at selection time; v4 ships the login v2 UI, stable v2 resource APIs, and PAT-authenticated management API used by the operator scripts. |

Official documentation for this exact release (do not use `latest` in runbooks):

- Self-hosting: https://zitadel.com/docs/self-hosting/deploy/overview
- Management API: https://zitadel.com/docs/apis/resources/mgmt
- OIDC endpoints / reserved scopes and claims: https://zitadel.com/docs/apis/openidoauth/endpoints
- Token claims: https://zitadel.com/docs/apis/openidoauth/claims

Re-run `test/jwt.test.ts` and the operator scripts against a scratch instance after every upgrade.
