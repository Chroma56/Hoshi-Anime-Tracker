
# Hoshi Backend V3 — Provider adapter

This backend does **not** extract from embedded commercial players.

## Installation

Replace `backend/server.mjs`, `backend/package.json` and `backend/test.mjs`; add `backend/provider-adapter.mjs`.

No Cloudflare change needed: Worker V2.1 already forwards the supported metadata.

Keep `BACKEND_TOKEN`, `MEDIA_HOSTS`, and `STREAM_CATALOG={}` as they are.

The provider adapter is disabled by default.

## Provider configuration

When you have a compatible, authorised provider, set these variables in Render:

- `PROVIDER_API_URL` — complete HTTPS resolver endpoint
- `PROVIDER_HOSTS` — exact allowed hostname for the metadata endpoint
- `PROVIDER_API_TOKEN` — optional private access credential
- `MEDIA_HOSTS` — exact hostnames for playable media URLs and caption files

The provider endpoint receives `series`, `episode` and `lang` query parameters.

Example response:

```json
{
  "available": true,
  "type": "direct",
  "format": "hls",
  "url": "https://your-cdn.example/ep1/master.m3u8",
  "subtitles": [
    {
      "lang": "en",
      "label": "English",
      "url": "https://your-cdn.example/ep1/en.vtt"
    }
  ]
}
```

The backend validates the returned stream URL against `MEDIA_HOSTS` and parses the master playlist for quality and direct VTT tracks.

It does not relay video bytes or bypass DRM. Both the media provider and the browser must allow playback from GitHub Pages.

## Tests

Run `npm test` from the backend directory.

`GET /health` returns version 3.0 once deployed.

## Fallback

If no configured provider returns usable direct video, the existing `STREAM_CATALOG` and embed fallback still apply.

Keep the existing Hoshi V3 frontend and Cloudflare Stream Worker V2.1 unchanged.
