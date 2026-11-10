# Hoshi Node stream metadata backend (v1)

Based on the server/player separation used by PlayzAnime, **not a copy of its proprietary stream-extraction implementation**. This service only serves streams that you have rights to distribute and that you explicitly configure. No DRM decryption, iframe interception, or CDN circumvention. Hoshi Player V3 continues to use the existing embed for missing streams.

## Deploy on Render (Node web service)

1. Create a new GitHub repository containing `server.mjs`, `package.json`, and `test.mjs` in its root. Connect it to Render as a **Web Service** with Node runtime.
2. Build command: `npm install`; start command: `npm start`.
3. Set environment variables:
   - `BACKEND_TOKEN`: long, randomly generated secret. Do **not** put this in the Hoshi HTML.
   - `MEDIA_HOSTS`: comma-separated exact HTTPS hostnames that you own or have permission to embed video from. Example for the public test: `test-streams.mux.dev`.
   - `STREAM_CATALOG`: see below. This is for test/authorised videos only.
4. Open your Render URL `/health` — expected `{"ok":true,"service":"hoshi-node",...}`.
5. Do not expose the token in GitHub, browser code or screenshots.

Example test catalog (this temporarily maps anime ID 8989 ep 1 to **Big Buck Bunny**, not to the real anime):

```json
{"8989:1:sub":{"type":"hls","url":"https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8","subtitles":[]}}
```

## Worker bridge

Paste `worker-bridge.js` into the existing `hoshi-stream` Worker (not `anime-proxy`). The bridge preserves your current `STREAM_CATALOG` response when the Node backend is unavailable and forwards only validated `/resolve` calls when it is configured. Add two **secrets** to the Worker: `NODE_BACKEND_URL` (the Render HTTPS root URL) and `BACKEND_TOKEN` (same value as Render). Keep the existing `STREAM_CATALOG` during testing or clear it later to avoid the Big Buck Bunny episode override.

The Hoshi Player V3 GitHub HTML calls `https://hoshi-stream.tasinsadman302.workers.dev/resolve` already: **no HTML change is needed.**

## Notes

- The Node backend returns `qualities` read from the HLS master manifest. Your current V3 frontend will ignore this extra field for now; hls.js still handles adaptive quality.
- Subtitle entries must be HTTPS `.vtt` files on approved hosts and allow browser CORS. The V3 player can load them.
- Render may spin down free web services, so the Worker uses a short timeout and keeps the embed fallback.
- `MEDIA_HOSTS` checks exact hosts and prevents caller-supplied arbitrary URLs. Never set it to `*`.
- Run `npm test` to check the manifest parser and `npm start` to run locally.
