# Hoshi Anikoto connector — safe staged integration

This archive is **stage 1**, a drop-in, read-only catalogue and episode connector. It is NOT an already-wired video player integration. Hoshi's production `provider-adapter.mjs` V4.4 has not been supplied in full; replacing it with an older copy would be unsafe.

## Installation

1. In `Chroma56/Hoshi-Anime-Tracker` upload all three `.mjs` files into `backend/`.
2. On Render, ensure `anime-sdk` is present in dependencies, and set `ANIKOTO_DIRECT_ENABLED=false`.
3. Run the offline test: `node anikoto-selftest.mjs`.
4. To test catalogue metadata once, run `node anikoto-diagnostic.mjs`. It does not call `resolveStream`.
5. Restore normal build command after diagnostic.

## Explicit title mapping

`ANIKOTO_TITLE_MAP={"al195539":"Exact Anikoto catalogue title"}`

Use the precise title returned by the SDK; don't blindly match the first search result to an AniList ID. The mapping is used only if you call `findAnikotoEpisodes(series)`.

## Production integration

Keep `server.mjs` and `provider-adapter.mjs` unchanged until the actual V4.4 adapter is merged. Hoshi will continue to use its existing playback and MegaPlay fallback. The exported `resolvePermittedUnit(unitId, language)` is disabled unless `ANIKOTO_DIRECT_ENABLED=true`; enabling it is not a grant of media distribution or ad-free playback rights. Confirm rights and browser compatibility before allowing public direct playback.

The SDK provider uses upstream embed extraction; successful catalogue/episode metadata is **not proof** of playable direct media, stable CORS support, or permission to omit advertisements. No playback proxy or DRM/advertisement circumvention is included.
