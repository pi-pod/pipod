# Security Policy

## Reporting a vulnerability

Report privately through GitHub. Do not open a public issue and do not post details in a pull
request or discussion.

1. Open a draft advisory at
   [`pi-pod/pipod/security/advisories/new`](https://github.com/pi-pod/pipod/security/advisories/new).
2. Include the affected component and version or commit, what an attacker gains, and the
   smallest reproduction you have.
3. Redact credentials, tokens, and any real user data from your report.

The advisory thread is the channel; there is no security email address.

## What to expect

This is a small project with no paid on-call rotation. We aim to acknowledge a report within a
few days and will keep you updated in the advisory thread. Please give us a reasonable chance to
ship a fix before disclosing publicly.

## Scope

In scope: the code in this repository, and the hosted deployment at `pipod.dev`,
`api.pipod.dev`, and `auth.pipod.dev`.

Out of scope: third-party services we depend on (report those upstream, for example to
Zitadel); volumetric denial of service; and findings that already assume a compromised host or a
stolen credential.

A pod is a sandbox that intentionally runs untrusted, agent-authored code. A pod's owner running
arbitrary code inside their own pod is the product, not a finding. Escaping a pod's isolation,
reaching another tenant's pod or data, reaching the host or the control plane, or bypassing a
pod's egress policy **is** a vulnerability.
