# ZipLink Firestore Security Specification

## 1. Data Invariants

1. **Default-Deny Catch-All:** Every Firestore path not explicitly allowed by a hardened rule block is denied (`allow read, write: if false;`).
2. **Strict Owner & PII Isolation (`/users/{userId}`):** User profile documents contain PII (`email`, `displayName`, `photoURL`). Only the authenticated user whose `request.auth.uid == userId` and `request.auth.token.email_verified == true` may `get`, `create`, `update`, or `delete` their own `/users/{userId}` document. `list` queries on `/users` are strictly denied so no user can enumerate other accounts.
3. **Immutable Identity & Temporal Integrity:** On `create`, `uid == userId == request.auth.uid`, `createdAt == request.time`, and `updatedAt == request.time`. On `update`, `uid` and `createdAt` are immutable and `updatedAt == request.time`.
4. **No Shadow Fields & Bounded Strings:** `keys().hasAll(...)` and `keys().hasOnly(...)` reject unapproved fields (`isAdmin`, `role`, `githubAccessToken`, etc.), and every string enforces `minLength`/`maxLength` from `firebase-blueprint.json`.
5. **No Client Secrets or GitHub Tokens:** GitHub OAuth tokens, GitHub workspaces, staged ZIP files, and public share tokens are never stored in client-readable Firestore collections.

## 2. Dirty Dozen Adversarial Payloads

| # | Attack Vector | Expected Result |
| --- | --- | --- |
| 1 | Unauthenticated `get` on `/users/userA` | `PERMISSION_DENIED` |
| 2 | Cross-user `get` by `userB` on `/users/userA` | `PERMISSION_DENIED` |
| 3 | Cross-user `list` query on `/users` collection | `PERMISSION_DENIED` |
| 4 | Unverified email (`email_verified: false`) attempting `create` on `/users/userA` | `PERMISSION_DENIED` |
| 5 | Identity spoofing: `userA` writing `uid: "userB"` inside `/users/userA` | `PERMISSION_DENIED` |
| 6 | Shadow field injection: `create` on `/users/userA` with `isAdmin: true` or `role: "admin"` | `PERMISSION_DENIED` |
| 7 | Client timestamp spoofing: `create` with client-supplied `createdAt` != `request.time` | `PERMISSION_DENIED` |
| 8 | Immutable field tampering: `update` changing `uid` or `createdAt` | `PERMISSION_DENIED` |
| 9 | Missing `request.time` on `update` (`updatedAt` forged or omitted) | `PERMISSION_DENIED` |
| 10 | Oversized string poisoning: `displayName` > 120 chars or `photoURL` > 512 chars or `email` > 320 chars | `PERMISSION_DENIED` |
| 11 | Path ID poisoning: invalid characters in `userId` (`../etc`, spaces, > 128 chars) | `PERMISSION_DENIED` |
| 12 | Cross-user `delete` or unauthorized collection write (e.g. `/workspaces/ws1` or `/test/connection`) | `PERMISSION_DENIED` |
