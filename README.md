# ZipLink

ZipLink turns an uploaded `.zip` archive into an unlisted, expiring web share page containing a browsable file tree, syntax-highlighted code viewer, owner-authorized code editor with diff & restore, individual and full edited ZIP downloads, a machine-readable `manifest.json`, and a deterministic `context.md` file built from readable UTF-8 text files.

> **Honest AI compatibility note:** Sharing a ZipLink URL does **not** guarantee an AI model can open it. URL-based prompts only work in AI tools that support fetching external web pages. ZipLink provides one-click Copy and Download buttons for `context.md` so you can always use your AI provider's approved file-upload or paste input method.

---

## Features

- **Real Server-Side Upload & Streaming Extraction:** Uses `multer` + `yauzl` to validate and extract archives inside isolated temporary directories.
- **Syntax-Highlighted Code Viewer & Editor (CodeMirror 6):**
  - Automatic language detection for JavaScript, TypeScript, JSX/TSX, JSON, HTML, CSS/SCSS, Python, Markdown, YAML, XML/SVG, Shell scripts, TOML, and SQL, with plain-text fallback.
  - Line numbers, readable indentation, horizontal scrolling / word-wrap toggle, and Light / Dark / System theme support persisted across refreshes.
  - Files open in read-only **Preview** mode by default. Owners with the edit token can switch to **Edit** mode with undo/redo, `Ctrl/Cmd+S` save shortcut, unsaved-changes indicators, and navigation/download prompts.
- **Persistent Server-Side Saves, Conflict Detection, Diff & Restore:**
  - Saves persist to ZipLink's configured server storage (`local` or `gcs` + Firestore) and automatically rebuild `context.md` and `manifest.json` from the current saved files.
  - Optimistic concurrency checks (`expectedSha256` and `expectedVersion`) protect against overwriting newer changes (`409 Conflict` with comparison & reload/overwrite options).
  - Unified and Side-by-Side **Diff** view with line numbers comparing unsaved drafts against the last saved file, or the last saved file against the original upload.
  - Separate **Discard unsaved changes** and **Restore original file** (with diff confirmation modal) actions. Original uploads are preserved until the share expires or is deleted.
  - Download individual saved files or **Download edited ZIP** containing all current saved files.
- **Owner-Only Edit Authorization:**
  - Public share URLs (`/s/:shareId`) are strictly **read-only**.
  - On upload, ZipLink generates a separate 256-bit **owner edit token** (`#edit=...` in the private edit URL, stored only as a SHA-256 hash on the server). Every save and restore request is verified on the server.
- **Deterministic `context.md` & `manifest.json`:** Combines readable UTF-8 text files under relative path headings within a configurable byte budget, escapes markdown code fences, excludes binaries and nested archives, and lists every omitted file with its reason.
- **Pre-Publish Sensitive Filename Warning:** Inspects ZIP central-directory filenames in the browser before upload and warns about likely sensitive files (`.env`, private keys, credentials). *(Filename check only — not a complete secrets scan.)*
- **Unlisted, Expiring Shares & One-Time Delete:** Generates 192-bit random `shareId` URLs with `X-Robots-Tag: noindex, nofollow, noarchive`, selectable `24h`, `7d` (default), or `30d` expiration, a 256-bit delete token, and scheduled background cleanup that permanently deletes all blobs, edits, and original backups.
- **ZIP & Web Security Defenses:**
  - Enforces configurable limits (`50 MB` compressed upload, `200 MB` extracted total, `500` entries, `512 KB` `context.md` budget, `512 KB` inline preview/edit per-file limit).
  - Enforces extracted size mid-stream to stop ZIP bombs even when central-directory headers lie.
  - Rejects malformed ZIPs, encrypted ZIPs, Unix/Windows symlinks, absolute paths, path traversal (`../`), null bytes, and duplicate entries.
  - Does not recursively extract nested `.zip` archives.
  - Renders all uploaded files (including HTML, JS, and SVG) strictly as escaped, syntax-highlighted source text — never executed or rendered as live HTML. Serves downloads with `Content-Type: application/octet-stream` (or `application/zip` for full archive downloads), `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`.

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

Runs unit and integration tests covering language detection, line-level diff accuracy, valid ZIP extraction, malformed archives, path traversal, symlinks, encryption, size/entry-count limits, owner edit authorization, persistent saves, conflict detection (`409`), edited file/ZIP downloads, original restoration, expiry cleanup, token-protected deletion, and safe headers/rendering.

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `APP_URL` | inferred from request | Public base URL used in generated share/edit/context/delete URLs |
| `STORAGE_DRIVER` | `local` | `local` (default disk storage) or `gcs` (Google Cloud Storage + Firestore) |
| `ZIPLINK_DATA_DIR` | `./data` | Local storage root for metadata, file blobs, and original snapshots when `STORAGE_DRIVER=local` |
| `GCS_BUCKET` | *(empty)* | Private Google Cloud Storage bucket name when `STORAGE_DRIVER=gcs` |
| `GOOGLE_CLOUD_PROJECT` | *(empty)* | GCP project ID when using GCS + Firestore |
| `FIRESTORE_COLLECTION` | `ziplink_shares` | Firestore collection name for share metadata |
| `ZIPLINK_MAX_COMPRESSED_BYTES` | `52428800` (50 MB) | Max compressed `.zip` upload size |
| `ZIPLINK_MAX_EXTRACTED_BYTES` | `209715200` (200 MB) | Max total extracted bytes |
| `ZIPLINK_MAX_ENTRY_COUNT` | `500` | Max ZIP entries |
| `ZIPLINK_MAX_CONTEXT_MD_BYTES` | `524288` (512 KB) | Max generated `context.md` size |
| `ZIPLINK_MAX_TEXT_PREVIEW_BYTES` | `524288` (512 KB) | Max individual text file size for preview, inline editing & inclusion |
| `ZIPLINK_CLEANUP_INTERVAL_MS` | `60000` | Expired-share purge interval in milliseconds |
| `ZIPLINK_UPLOAD_RATE_LIMIT` | `20` | Max uploads per IP per 15-minute window |

---

## Storage Setup & Cloud Run Deployment (Google Cloud Storage + Firestore)

By default, ZipLink runs with `STORAGE_DRIVER=local`, storing extracted blobs and original backups under generated UUIDs in `ZIPLINK_DATA_DIR` so it works immediately in any single-container environment without external credentials. Note that in ephemeral container platforms (such as Cloud Run without a mounted persistent volume), local `./data` files persist only for the lifetime of the container instance; configure `STORAGE_DRIVER=gcs` with `GCS_BUCKET` and Firestore for durable multi-instance persistence.

For multi-instance production deployment on **Google Cloud Run** with **private Google Cloud Storage** and **Firestore**:

1. **Create a private GCS bucket** (uniform bucket-level access, public access prevention enforced):
   ```bash
   gcloud storage buckets create gs://YOUR_ZIPLINK_BUCKET \
     --location=us-central1 \
     --uniform-bucket-level-access \
     --public-access-prevention
   ```

2. **Enable Firestore (Native mode)** in your GCP project and optionally configure a Firestore TTL policy on field `expireAtDate` in collection `ziplink_shares`.

3. **Grant the Cloud Run service account** only:
   - `roles/storage.objectAdmin` scoped to `gs://YOUR_ZIPLINK_BUCKET`
   - `roles/datastore.user` for Firestore

4. **Deploy to Cloud Run** with environment variables:
   ```bash
   gcloud run deploy ziplink \
     --source . \
     --port 3000 \
     --set-env-vars "NODE_ENV=production,STORAGE_DRIVER=gcs,GCS_BUCKET=YOUR_ZIPLINK_BUCKET,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID"
   ```
   Also set `APP_URL` to your Cloud Run service URL once deployed. Ensure Cloud Run's request timeout and body limit accommodate up to 50 MB uploads (for >32 MB uploads on Cloud Run, enable `--use-http2`).

---

## Retention & Privacy Behavior

- **Read-only public shares:** Anyone with the `/s/:shareId` URL can view and download all files in that share. Editing requires the separate owner edit token (`#edit=...`).
- **No indexing:** Share routes return `X-Robots-Tag: noindex, nofollow, noarchive` and `<meta name="robots" content="noindex, nofollow, noarchive">`.
- **Expiration:** Uploaders choose `24h`, `7d` (default), or `30d`. Expired shares are rejected immediately on access (`410 Gone`) and purged (including edited blobs and `originals/`) from storage by the background cleanup job.
- **No content logging:** Server logs record startup and error status without logging uploaded file contents, edit tokens, or delete tokens.

## Known Limitations

- **Per-process write lock:** Concurrent edits within a single Node server process are serialized by an in-memory per-share lock, and `expectedSha256`/`expectedVersion` checks prevent blind overwrites (`409 Conflict`). Across multiple independent Cloud Run instances using `STORAGE_DRIVER=gcs`, `409 Conflict` checks still prevent stale client overwrites, though simultaneous sub-second writes on two different instances are not wrapped in a Firestore transaction.
- **Per-file inline editor limit:** Binary files and text files larger than `ZIPLINK_MAX_TEXT_PREVIEW_BYTES` (default `512 KB`) are read-only with a download button.
- **Ephemeral local disk on stateless hosts:** If deployed to Cloud Run or another ephemeral filesystem without `STORAGE_DRIVER=gcs` (`GCS_BUCKET` + `GOOGLE_CLOUD_PROJECT`), local `./data` storage resets on container restart.
- **No malware/antivirus scanning:** Archives are structurally validated and safely sandboxed for download, not scanned for malware.
- **Filename-only sensitive warning:** Pre-publish warnings check common filenames (`.env`, `*.pem`, `*.key`, `credentials.json`, etc.) and do not scan file contents for secrets or API keys.
- **In-memory rate limiting:** Default `express-rate-limit` store is per-instance; for multi-instance Cloud Run scaling, configure Cloud Armor or a shared Redis store.
