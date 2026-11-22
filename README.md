# ZipLink

ZipLink turns an uploaded `.zip` archive into an unlisted, expiring web share page containing a browsable file tree, individual file downloads, a machine-readable `manifest.json`, and a deterministic `context.md` file built from readable UTF-8 text files.

> **Honest AI compatibility note:** Sharing a ZipLink URL does **not** guarantee an AI model can open it. URL-based prompts only work in AI tools that support fetching external web pages. ZipLink provides one-click Copy and Download buttons for `context.md` so you can always use your AI provider's approved file-upload or paste input method.

---

## Features

- **Real Server-Side Upload & Streaming Extraction:** Uses `multer` + `yauzl` to validate and extract archives inside isolated temporary directories.
- **Deterministic `context.md` & `manifest.json`:** Combines readable UTF-8 text files under relative path headings within a configurable byte budget, escapes markdown code fences, excludes binaries and nested archives, and lists every omitted file with its reason.
- **Pre-Publish Sensitive Filename Warning:** Inspects ZIP central-directory filenames in the browser before upload and warns about likely sensitive files (`.env`, private keys, credentials). *(Filename check only — not a complete secrets scan.)*
- **Unlisted, Expiring Shares:** Generates 192-bit random `shareId` URLs with `X-Robots-Tag: noindex, nofollow, noarchive`, selectable `24h`, `7d` (default), or `30d` expiration, and a scheduled background cleanup job that permanently deletes expired data.
- **One-Time Delete Link & Token:** Issues a 256-bit delete token shown once after upload (stored only as a SHA-256 hash) for immediate deletion.
- **ZIP & Web Security Defenses:**
  - Enforces configurable limits (`50 MB` compressed upload, `200 MB` extracted total, `500` entries, `512 KB` `context.md` budget).
  - Enforces extracted size mid-stream to stop ZIP bombs even when central-directory headers lie.
  - Rejects malformed ZIPs, encrypted ZIPs, Unix/Windows symlinks, absolute paths, path traversal (`../`), null bytes, and duplicate entries.
  - Does not recursively extract nested `.zip` archives.
  - Stores blobs under generated UUIDs (never archive paths).
  - Renders all previews strictly as escaped plain text; serves downloads with `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`.
  - Applies rate limiting on upload and share endpoints and never logs uploaded file contents.

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

Runs unit and integration tests covering valid ZIP extraction, malformed archives, path traversal, symlinks, encryption, size/entry-count limits, expiry cleanup, token-protected deletion, and safe headers/rendering.

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `APP_URL` | inferred from request | Public base URL used in generated share/context/delete URLs |
| `STORAGE_DRIVER` | `local` | `local` (default disk storage) or `gcs` (Google Cloud Storage + Firestore) |
| `ZIPLINK_DATA_DIR` | `./data` | Local storage root for metadata and file blobs when `STORAGE_DRIVER=local` |
| `GCS_BUCKET` | *(empty)* | Private Google Cloud Storage bucket name when `STORAGE_DRIVER=gcs` |
| `GOOGLE_CLOUD_PROJECT` | *(empty)* | GCP project ID when using GCS + Firestore |
| `FIRESTORE_COLLECTION` | `ziplink_shares` | Firestore collection name for share metadata |
| `ZIPLINK_MAX_COMPRESSED_BYTES` | `52428800` (50 MB) | Max compressed `.zip` upload size |
| `ZIPLINK_MAX_EXTRACTED_BYTES` | `209715200` (200 MB) | Max total extracted bytes |
| `ZIPLINK_MAX_ENTRY_COUNT` | `500` | Max ZIP entries |
| `ZIPLINK_MAX_CONTEXT_MD_BYTES` | `524288` (512 KB) | Max generated `context.md` size |
| `ZIPLINK_MAX_TEXT_PREVIEW_BYTES` | `524288` (512 KB) | Max individual text file size for preview & inclusion |
| `ZIPLINK_CLEANUP_INTERVAL_MS` | `60000` | Expired-share purge interval in milliseconds |
| `ZIPLINK_UPLOAD_RATE_LIMIT` | `20` | Max uploads per IP per 15-minute window |

---

## Storage Setup & Cloud Run Deployment (Google Cloud Storage + Firestore)

By default, ZipLink runs with `STORAGE_DRIVER=local`, storing extracted blobs under generated UUIDs in `ZIPLINK_DATA_DIR` so it works immediately in any single-container environment without external credentials.

For multi-instance production deployment on **Google Cloud Run** with **private Google Cloud Storage** and **Firestore**:

1. **Create a private GCS bucket** (uniform bucket-level access, public access prevention enforced):
   ```bash
   gcloud storage buckets create gs://YOUR_ZIPLINK_BUCKET \
     --location=us-central1 \
     --uniform-bucket-level-access \
     --public-access-prevention
   ```
   *(Optional defense-in-depth: add a 31-day GCS object lifecycle rule on `shares/` in case a Cloud Run instance is idle.)*

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
   Also set `APP_URL` to your Cloud Run service URL once deployed. Ensure Cloud Run's request timeout and body limit accommodate up to 50 MB uploads (note: Cloud Run HTTP/1 request body limit is 32 MB unless HTTP/2 end-to-end is enabled; for >32 MB uploads on Cloud Run, enable `--use-http2`).

---

## Retention & Privacy Behavior

- **Unlisted, not private:** Anyone with the share URL can view and download all files in that share. Do not treat unlisted links as access control.
- **No indexing:** Share routes return `X-Robots-Tag: noindex, nofollow, noarchive` and `<meta name="robots" content="noindex, nofollow, noarchive">`.
- **Expiration:** Uploaders choose `24h`, `7d` (default), or `30d`. Expired shares are rejected immediately on access (`410 Gone`) and purged from storage by the background cleanup job.
- **No content logging:** Server logs record startup and error status without logging uploaded file contents or delete tokens.

## Known Limitations

- **No malware/antivirus scanning:** Archives are structurally validated and safely sandboxed for download, not scanned for malware.
- **Filename-only sensitive warning:** Pre-publish warnings check common filenames (`.env`, `*.pem`, `*.key`, `credentials.json`, etc.) and do not scan file contents for secrets or API keys.
- **In-memory rate limiting:** Default `express-rate-limit` store is per-instance; for multi-instance Cloud Run scaling, configure Cloud Armor or a shared Redis store.
- **Cloud Run HTTP/1 32 MB limit:** Standard Cloud Run HTTP/1 buffers request bodies above 32 MB; enable Cloud Run HTTP/2 (`--use-http2`) or signed direct-to-GCS uploads if serving 32–50 MB archives there.
