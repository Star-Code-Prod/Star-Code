---
name: workflow-auth
description: Implement or review authentication and authorization: sessions, tokens, roles, tenant boundaries, CSRF, password reset and audit. Use for login, permissions and security-sensitive flows.
---

# Auth and permissions

## Model
- Define identities, sessions, roles, resources and tenant boundaries.
- Decide who can do what, on which object, under which condition.
- Prefer server-side checks on every request; never trust a hidden button.

## Implement
- Hash passwords with a current KDF; never store or log raw credentials.
- Use HttpOnly, Secure, SameSite cookies for browser sessions; rotate on privilege change.
- Validate redirects against an allowlist. Add CSRF protection for cookie-authenticated writes.
- Make authorization checks centralized and deny by default.

## Prove
- Test unauthenticated, wrong user, wrong tenant, expired session, revoked role and privilege escalation.
- Check that errors do not reveal whether an account exists.
- Review logs for secrets and tokens.

## Report
- The threat model, the checks added, the tests and any residual risk. Do not give legal or compliance guarantees.
