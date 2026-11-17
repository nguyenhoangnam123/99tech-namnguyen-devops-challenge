# 0005: Auth and abuse controls at the edge of oms

**Status:** accepted (wave 1); auth moves to a managed IdP in wave 2

## Decision

- Passwords: scrypt at OWASP-equivalent cost (N=2^14, r=8, p=5). Unknown emails are
  checked against a decoy hash so timing reveals nothing.
- Tokens: EdDSA JWT, 15 minutes, algorithm, issuer and audience pinned on verify.
- Limits, all Redis-backed with an in-memory fallback:
  - Per IP for register and login (120/min).
  - Per account for login: every attempt counts atomically before the hash is checked;
    a success clears it (10 per 15 min).
  - Per user for orders (20/s).
- Password hashing runs at most 2 at a time per process with a short queue. Anything
  beyond gets an immediate 503, so a login flood cannot starve order placement.
- The edge overwrites `X-Forwarded-For`. Appending let clients choose their own IP and
  bypass every per-IP limit (found by the abuse suite; evidence in `reports/security/`).
- The custody webhook is HMAC-signed over timestamp and raw body, with a 5 minute window.

## Rejected

- **Lockout as a domain rule in `app/`.** These limits are keyed on transport facts (IP,
  attempt rate) like a WAF rule, and move to the IdP in wave 2. They stay in the HTTP adapter.

## Accepted risks (revisited in Problem 5)

- Registration answers 409 for a taken email, which reveals that the account exists.
  Closing it needs an email-verification flow.
- Per-account lockout lets an attacker lock a victim out for 15 minutes.
- Market orders have no price band; a market sell can sweep the book.
