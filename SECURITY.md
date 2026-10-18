# Security Policy

NameInsight makes outbound network requests (DNS, ping, WHOIS/RDAP) on behalf of its callers, so we take
reports about request forgery, input validation and resource exhaustion seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:
**[Security → Report a vulnerability](https://github.com/himan-patel/name-insight/security/advisories/new)**.

Include, where you can:

- what the issue is and its impact
- steps to reproduce (requests, inputs, configuration)
- the affected version or commit

You can expect an acknowledgement within 7 days. Once the issue is confirmed, we'll agree on a fix and a
disclosure timeline with you, and credit you in the advisory unless you prefer otherwise.

## Supported versions

Security fixes are made on the latest release on `main`.

## Scope

In scope, for example:

- reaching private, loopback or link-local addresses (SSRF), including through DNS or WHOIS referrals
- command or argument injection into `ping` or other subprocesses
- bypassing input validation, body/upload size limits, rate limits or the lookup budget
- denial of service through a single request (memory, sockets, processes)
- leaking secrets, internal addresses or stack traces in responses or logs

Out of scope: volumetric DDoS, findings that require a compromised host or deliberately unsafe
configuration, and the accuracy of third-party WHOIS/RDAP data.

## Operational notes

- NameInsight is a public tool with no authentication by design; abuse is limited per client IP.
- Rate limits and lookup budgets are per process; multiple instances multiply them.
- Behind a load balancer, set `TRUST_PROXY_HOPS` so limits apply to real client IPs.

## Secrets

This repository must never contain secrets. If you find a committed key or token, report it privately as
above so it can be revoked.
