# Aeonic

Self-hosted media storage and transformation platform. Upload, transform, and serve images and video from your own infrastructure with just one command:

```bash
docker compose up -d
```

All files stored in your VPS.

---
## Why Aeonic?

Aeonic is a self-hosted media platform built for developers who want direct control over their storage stack.

Most Cloudinary alternatives still depend on S3-compatible storage, which means you’re still relying on an external provider. Aeonic works out of the box with local disk storage instead. Files are stored directly on the machine running the service (`./data/uploads`), with SQLite for metadata and a single Docker container for deployment.

If you later want S3, R2, or another object store, you can enable it through configuration without changing your app architecture.

Aeonic also supports Cloudinary-style transformation URLs like:

`/t/w_800,h_600,c_fill,f_webp/image.png`

so existing projects can migrate with minimal changes.

Everything is API-first. The dashboard exists for convenience, not as the primary way to use the platform.

---

## Features

- Image transformations: Resize, crop, format conversion (WebP, AVIF, JPEG, PNG), quality, blur, rotate
- Smart format selection: Serve AVIF or WebP automatically based on `Accept` headers
- On-disk transform cache: transformed variants cached locally, served in under 50ms on repeat requests
- Video processing: Thumbnail extraction, transcode, clip via FFmpeg
- Folder namespacing: Organize uploads under logical paths (`products/shoes/...`)
- API key auth: Create and revoke keys per project or per team member
- Clean dashboard: Media browser, upload UI, API key management, storage stats
- Pluggable storage: Local disk by default, S3/R2/MinIO as a drop-in upgrade

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/ibsule/aeonic.git
cd aeonic

# 2. Configure
cp .env.example .env
# Edit .env — at minimum, set BETTER_AUTH_SECRET to a random string

# 3. Run
docker compose up -d

# 4. Open the dashboard
open http://localhost:3000
# Create your admin account on first load
```

---

## Uploading a file

```bash
curl -X POST http://localhost:3001/upload \
  -H "Authorization: Bearer mv_your_api_key" \
  -F "file=@photo.jpg" \
  -F "folder=products"
```

```json
{
  "key": "products/1716000000000-a1b2c3.jpg",
  "url": "http://localhost:3001/files/products/1716000000000-a1b2c3.jpg",
  "size": 204800,
  "mime_type": "image/jpeg"
}
```

## Transforming a file

```
# Resize to 800×600, crop to fill, convert to WebP
GET /t/w_800,h_600,c_fill,f_webp/products/1716000000000-a1b2c3.jpg

# Square thumbnail, 200px, auto-format
GET /t/w_200,h_200,c_fill,f_auto/products/1716000000000-a1b2c3.jpg
```

---

## Stack

- **API**: Node.js + Express
- **Image processing**: Sharp (libvips)
- **Video processing**: FFmpeg
- **Database**:  SQLite (better-sqlite3)
- **Auth**:  better-auth
- **Dashboard**: Next.js 15

---

## Roadmap

- [ ] Webhooks on upload / job complete
- [ ] Presigned upload URLs (bypass the server for large files)
- [ ] Multi-user / team support with per-user storage quotas
- [ ] SDK packages (`@aeonic/js`, `@aeonic/react`)
- [ ] ARM64 Docker image (Apple Silicon, Raspberry Pi, cheaper ARM VPS)

---

## License

[MIT](./LICENSE)