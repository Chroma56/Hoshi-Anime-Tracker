
# Hoshi streaming metadata backend V2


This does not fetch commercial anime videos, parse embeds, bypass DRM, or relay media. Only register video URLs that you may distribute. Keep your Anikoto embed as fallback.

## What's new

- Parses `#EXT-X-STREAM-INF` from an authorised HLS master playlist to return quality variants.
- Parses HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` entries with direct `.vtt` URLs, including quoted labels.
- Merges explicit `subtitles` entries from `STREAM_CATALOG` with discovered `.vtt` tracks.
- Updated Cloudflare bridge passes `qualities` metadata from Render to Hoshi while retaining the existing embed fallback.
- Rejects discovered media URLs outside the configured HTTPS `MEDIA_HOSTS` allowlist.
- Does not proxy video bytes or bypass browser CORS.

## Update your existing deployment

1. GitHub: In your existing Hoshi-Anime-Tracker/backend/ folder replace server.mjs, test.mjs and README.md with files from this package. Optionally update package.json (version bump only). Commit the changes.

2. Render: Keep the same Root Directory: backend, npm install, npm start, BACKEND_TOKEN and MEDIA_HOSTS. Keep STREAM_CATALOG={} now that you removed Big Buck Bunny.

3. Visit your Render /health URL and confirm version: "2.0".

4. Cloudflare: For the optional metadata-forwarding improvement, replace the hoshi-stream Worker only with worker-bridge.js. Keep NODE_BACKEND_URL, BACKEND_TOKEN and STREAM_CATALOG={}. Visit the Worker /health endpoint and confirm version: "2.1".

5. GitHub Pages: No changes to your current Hoshi index.html needed.

6. Test: cd backend && npm test (Node 20+).

## Expected behaviour

With both catalogs set to {}, requesting:

/resolve?series=8989&episode=1&lang=sub

on your Worker returns:

{"type":"embed","available":false}

Once you have an authorised playable stream, add it to Render STREAM_CATALOG:

{
  "demo:1:sub": {
    "type": "hls",
    "url": "https://your-authorised-media.example/series/episode/master.m3u8",
    "subtitles": [
      {
        "lang": "en",
        "label": "English",
        "url": "https://your-authorised-media.example/series/episode/en.vtt"
      }
    ]
  }
}

Add the actual media and subtitle hosts to Render MEDIA_HOSTS.

Playback and subtitle files must be browser-accessible from https://chroma56.github.io and the provider must allow direct playback.

## Notes

- HLS subtitle renditions whose URI points to .m3u8 are not advertised as direct WebVTT tracks.
- Render free instances can sleep. The Cloudflare bridge has a 5.5-second backend timeout.
- Keep BACKEND_TOKEN private and identical in Render and Cloudflare.
- The Hoshi V3 frontend may need additional changes to display every quality option.
- worker-bridge.js is deployed in Cloudflare, not executed by Render.
- No external npm dependencies are needed.
