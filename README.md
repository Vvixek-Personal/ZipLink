# ZipLink

ZipLink provides two clear, separated workflows:

1. **Unlisted ZIP Sharing & `context.md` Conversion:** Turn any uploaded `.zip` archive into an unlisted, expiring web share page containing a browsable file tree, individual sandboxed file downloads, `manifest.json`, and a deterministic `context.md` file built from readable UTF-8 text files.
2. **Private GitHub Workspaces & Safe ZIP-to-GitHub Import:** Connect an authorized GitHub App account to import authorized repositories & branches via the Git Trees API, edit text files or replace binary files byte-for-byte, pull upstream updates with explicit 3-way conflict & deletion review, push diffs to a new branch + Pull Request, and stage `.zip` uploads for explainable destination suggestions without modifying your default branch silently.

> **Honest AI compatibility note:** Sharing a ZipLink URL does **not** guarantee an AI model can open it. URL-based prompts only work in AI tools that support fetching external web pages. ZipLink provides one-click Copy and Download buttons for `context.md` so you can always use your AI provider's approved file-upload or paste input method.

---

## Features

### Unlisted ZIP Sharing (`/`)
- **Real Server-Side Upload & Streaming Extraction:** Uses `multer` + `yauzl` to validate and extract archives inside isolated temporary directories.
- **Deterministic `context.md` & `manifest.json`:** Combines readable UTF-8 text files under relative path headings within a configurable byte budget, escapes markdown code fences, excludes binaries and nested archives, and lists every omitted file with its reason.
- **Pre-Publish Sensitive Filename Warning:** Inspects ZIP central-directory filenames in the browser before upload and warns about likely sensitive files (`.env`, private keys, credentials). *(Filename check only — not a complete secrets scan.)*
- **Unlisted, Expiring Shares:** Generates 192-bit random `shareId` URLs with `X-Robots-Tag: noindex, nofollow, noarchive`, selectable `24h`, `7d` (default), or `30d` expiration, and a scheduled background cleanup job.
- **One-Time Delete Link & Token:** Issues a 256-bit delete token shown once after upload (stored only as a SHA-256 hash) for immediate deletion.

### GitHub Repository Workspaces (`/workspaces`)
- **Google Sign-In & Per-User Data Isolation:** Private workspaces and GitHub connections require signing in with Google via Firebase Authentication. The backend cryptographically verifies the caller's Firebase ID token (`Authorization: Bearer <idToken>`) on every private request and enforces `ownerUid === verifiedUser.uid` on every workspace, staged ZIP, GitHub connection, and action. Signing in with Google never grants GitHub access on its own.
- **Official GitHub App Authorization:** Uses least-privilege GitHub App user OAuth and `/user/installations` so ZipLink sees only repositories the signed-in user explicitly authorized for their account. OAuth `state` is cryptographically bound (HMAC + single-use server nonce) to the signed-in Firebase `uid`. Access and refresh tokens stay encrypted at rest server-side (AES-256-GCM) keyed by user UID and are never sent to browser code or URLs.
- **Persistent Private Workspaces:** Imports real Git trees and blobs (no ZIP substitute), recording `repoId`, `branch`, `baseCommitSha`, `baseTreeSha`, file paths, SHA-256 hashes, and Git blob SHA-1 hashes. Workspaces remain private per account by default and are never auto-published as share links.
- **Safe Text Editor & Binary Replacement:** Create, rename, delete, or edit UTF-8 text files as escaped plain text (never executing HTML, scripts, or SVG), and replace or upload binary files preserving exact bytes.
- **3-Way Pull & Conflict Review:** Compares saved base, workspace, and remote branch. Applies safe upstream changes automatically; surfaces text and binary conflicts without overwriting either copy or auto-merging binaries; lists upstream deletions and requires explicit confirmation; stops with `409 Conflict` if the remote branch moves during pull or push.
- **New Branch + Pull Request Push (No Auto-Merge):** Shows line-by-line and file-level diffs before pushing and creates a new Git branch + Pull Request by default (never silently pushing to the default/base branch). Pull Requests are never merged automatically; an optional explicit-confirmation merge control appears only if the user's GitHub repository permissions report write, maintain, or admin access.

### Safe ZIP-to-GitHub Import (`/zip-to-github`)
- **Separate Private Staging:** Extracts ZIPs with full server-side path-traversal, symlink, encryption, and ZIP-bomb protections into temporary private user-owned staging (never exposed as a public `/s/:shareId` share).
- **Explainable Destination Matching:** Scans only the current user's authorized repositories using exact Git blob SHA-1 matches, distinctive relative file paths, directory structure, and weak name/metadata hints. Flags common-filename-only or closely tied matches as ambiguous requiring manual selection.
- **Manual Override & Collision Plan:** Lets users pick or override repository, branch, and optional target folder, inspects additions, path collisions/overwrites, and unchanged files before pushing, defaults to `Add or update files` (no deletions), and requires separate confirmation if `Mirror ZIP exactly` lists deletions.

---

## Account Management & Data Deletion

1. **Sign out:** Click **Sign out** in the top bar or inside the account bar on private routes (`/workspaces`, `/zip-to-github`). This ends your Firebase client session immediately.
2. **Disconnect GitHub (keep ZipLink workspaces):** Click **Disconnect GitHub** inside the GitHub connection banner. This removes your server-side encrypted GitHub token for your ZipLink account. To revoke the GitHub App completely on GitHub, visit `GitHub -> Settings -> Applications -> Installed GitHub Apps`.
3. **Delete all private ZipLink account data:** Sign in and click **Delete account data** in the account bar, type `DELETE`, and confirm (`DELETE /api/account/data`). ZipLink permanently deletes:
   - Your server-side encrypted GitHub OAuth connection
   - All private GitHub workspaces and stored workspace file blobs owned by your UID
   - All private temporary ZIP-to-GitHub staged archives owned by your UID
   - Your `/users/{uid}` Firestore profile document (and signs you out)
   Public unlisted ZIP shares (`/s/:shareId`) are separate from private accounts: they automatically expire (`24h`/`7d`/`30d`) or can be deleted immediately via their one-time delete link/token.
4. **Deployment owner deletion requests:** If a user cannot sign in and requests data removal out-of-band, a project administrator can delete the user's record in Firebase Authentication, delete `/users/{uid}` in Firestore, and remove any matching server records where `ownerUid == uid` (plus the corresponding hashed GitHub connection file `ghconn_<sha256(uid)>.json`).

---

## Firebase Auth & GitHub App Setup Guide

### 1. Firebase Authentication (Google Sign-In)
1. Provisioned Firebase configuration is stored in `/firebase-applet-config.json` (project `steel-scanner-8xfhk`, database `ai-studio-ziplink-b71eaa68-db82-4ccf-a502-f37a35e65c23`).
2. In the **Firebase Console -> Authentication -> Sign-in method**, enable **Google**.
3. Under **Authentication -> Settings -> Authorized domains**, add your app hostnames:
   - Development URL host: `ais-dev-cc6noi2gpk4ek4qx2n7mqj-264405870890.asia-east1.run.app`
   - Shared URL host: `ais-pre-cc6noi2gpk4ek4qx2n7mqj-264405870890.asia-east1.run.app`
   - Localhost (`localhost`) for local development.

### 2. GitHub App Setup
1. Create a GitHub App in your GitHub account/organization settings (`Settings -> Developer settings -> GitHub Apps -> New GitHub App`).
2. Configure **least-privilege Repository permissions**:
   - **Metadata:** Read-only
   - **Contents:** Read and write
   - **Pull requests:** Read and write
3. Enable **Request user authorization (OAuth) during installation** and register these **Callback URLs**:
   - Development App URL: `https://ais-dev-cc6noi2gpk4ek4qx2n7mqj-264405870890.asia-east1.run.app/api/github/callback`
   - Shared App URL: `https://ais-pre-cc6noi2gpk4ek4qx2n7mqj-264405870890.asia-east1.run.app/api/github/callback`
   - Local development URL (if running locally): `http://localhost:3000/api/github/callback`
4. Add the generated credentials to your server environment (`.env` or Cloud Run secrets):
   ```bash
   GITHUB_CLIENT_ID=Iv1...
   GITHUB_CLIENT_SECRET=...
   GITHUB_APP_SLUG=your-app-slug
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
   ZIPLINK_SESSION_SECRET=a-long-random-32-plus-byte-secret
   ```

---

## Local Run Instructions

### Prerequisites

- Node.js 22+ (or 20+ with `tsx`)

### Setup & Development

```bash
npm install
cp .env.example .env
npm run dev
```

The app runs on `http://localhost:3000`.

### Production Build & Run

```bash
npm run build
NODE_ENV=production npm start
```

### Run Automated Tests

```bash
npm test
```

Runs unit and integration tests covering ZIP security & extraction, public share lifecycle, Google/Firebase token authentication & strict per-user isolation, GitHub OAuth state binding & replay protection, three-way pull/conflict resolution, repository suggestion ranking, encrypted server-side GitHub token storage, workspace edits & binary preservation, new-branch/PR pushing, permission-gated manual PR merging, ZIP-to-GitHub collision/mirror safety, and account data deletion.

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `APP_URL` | inferred from request | Public base URL used in share links and OAuth callback URLs |
| `FIREBASE_PROJECT_ID` | from `firebase-applet-config.json` | Optional Firebase Project ID override for server-side ID token verification |
| `STORAGE_DRIVER` | `local` | `local` (default disk storage) or `gcs` (Google Cloud Storage + Firestore) |
| `ZIPLINK_DATA_DIR` | `./data` | Local storage root for shares, workspaces, per-user GitHub connections, and ZIP stages |
| `GCS_BUCKET` | *(empty)* | Private Google Cloud Storage bucket name when `STORAGE_DRIVER=gcs` |
| `GOOGLE_CLOUD_PROJECT` | *(empty)* | GCP project ID when using GCS + Firestore |
| `FIRESTORE_COLLECTION` | `ziplink_shares` | Firestore collection prefix for shares, workspaces, connections, and stages |
| `GITHUB_CLIENT_ID` | *(empty)* | GitHub App OAuth Client ID |
| `GITHUB_CLIENT_SECRET` | *(empty)* | GitHub App OAuth Client Secret (server-only) |
| `GITHUB_APP_SLUG` | *(empty)* | GitHub App URL slug used for installation/repo-authorization links |
| `GITHUB_APP_ID` | *(empty)* | Optional GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | *(empty)* | Optional GitHub App PEM private key (server-only) |
| `ZIPLINK_SESSION_SECRET` | ephemeral random | Server key material for AES-256-GCM token encryption & OAuth state HMAC |
| `ZIPLINK_MAX_COMPRESSED_BYTES` | `52428800` (50 MB) | Max compressed `.zip` upload size |
| `ZIPLINK_MAX_EXTRACTED_BYTES` | `209715200` (200 MB) | Max total extracted bytes |
| `ZIPLINK_MAX_ENTRY_COUNT` | `500` | Max ZIP entries and workspace files |
| `ZIPLINK_MAX_CONTEXT_MD_BYTES` | `524288` (512 KB) | Max generated `context.md` size |
| `ZIPLINK_MAX_TEXT_PREVIEW_BYTES` | `524288` (512 KB) | Max individual text file size for preview, `context.md`, and inline editor |
| `ZIPLINK_CLEANUP_INTERVAL_MS` | `60000` | Expired-share/state/stage purge interval in milliseconds |
| `ZIPLINK_UPLOAD_RATE_LIMIT` | `20` | Max uploads per IP per 15-minute window |

---

## Known Limitations

- **No malware/antivirus scanning:** Archives and workspace files are structurally validated and safely sandboxed for download, not scanned for malware.
- **Filename-only sensitive warning:** Pre-publish warnings check common filenames (`.env`, `*.pem`, `*.key`, `credentials.json`, etc.) and do not scan file contents for secrets or API keys.
- **User-to-server repository creation limits:** Creating brand-new GitHub repositories directly from a GitHub App OAuth token depends on the App's account permissions (`Administration: Read & write` on repositories) and may be declined by GitHub if only least-privilege `Metadata`, `Contents`, and `Pull requests` permissions are granted.
- **Submodules & symlinks:** Git tree symlinks (`120000`) and submodule entries (`commit`) are skipped/rejected for safety rather than dereferenced.
- **Cloud Run HTTP/1 32 MB limit:** Standard Cloud Run HTTP/1 buffers request bodies above 32 MB; enable Cloud Run HTTP/2 (`--use-http2`) if serving 32–50 MB uploads there.
