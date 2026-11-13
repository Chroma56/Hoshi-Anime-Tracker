<p align="center">
  <a href="https://chroma56.github.io/Hoshi-Anime-Tracker/">
    <img src="https://img.shields.io/badge/HOSHI-ANIME-8157e5?style=for-the-badge" alt="Hoshi Anime" height="40" />
  </a>
</p><h1 align="center">✦ Hoshi Anime</h1><p align="center">
  <strong>Discover anime. Watch episodes. Read manga. All in one place.</strong><br />
  A modern, browser-based anime and manga experience.
</p><p align="center">
  <a href="https://chroma56.github.io/Hoshi-Anime-Tracker/">Open Web App</a> ·
  <a href="https://github.com/Chroma56/Hoshi-Anime-Tracker">Source Code</a> ·
  <a href="https://github.com/Chroma56/Hoshi-Anime-Tracker/issues">Report an Issue</a> ·
  <a href="LEGAL.md">Legal &amp; Copyright</a>
</p><p align="center">
  <a href="https://github.com/Chroma56/Hoshi-Anime-Tracker/stargazers">
    <img src="https://img.shields.io/github/stars/Chroma56/Hoshi-Anime-Tracker?style=flat-square" alt="GitHub stars" />
  </a>
  <a href="https://chroma56.github.io/Hoshi-Anime-Tracker/">
    <img src="https://img.shields.io/badge/Platform-Web-457bfa?style=flat-square" alt="Web platform" />
  </a>
  <img src="https://img.shields.io/badge/Frontend-HTML%20%7C%20CSS%20%7C%20JavaScript-f59e0b?style=flat-square" alt="Frontend technologies" />
  <img src="https://img.shields.io/badge/Status-Under%20Development-8b5cf6?style=flat-square" alt="Development status" />
</p><h5 align="center">If you enjoy Hoshi Anime, consider leaving a ⭐ on the repository.</h5>About
Hoshi Anime is an independent, browser-based anime discovery and viewing interface and manga reader. It brings together anime metadata, episode browsing, external playback options, manga chapters, and local progress tracking in one UI.

The frontend is a lightweight HTML/CSS/JavaScript site deployed with GitHub Pages. It uses AniList for anime information and connects to external providers through Cloudflare Workers and a separate Node.js backend for supported functionality.
[!IMPORTANT]
Hoshi Anime does not claim ownership of anime videos, manga pages, or artwork provided by third parties. Episodes and chapters may be displayed using external sources or processed through configured proxy/relay services. Rights and availability depend on the provider and location. Read [Legal & Copyright](LEGAL.md) before using or deploying the project.

[!NOTE]
Work in progress: External embedded playback is currently the more reliable option. Custom direct HLS playback and some manga source integrations depend on their respective upstream services and backend configuration. Features may vary by title.

Preview
<p align="center">
  <a href="https://chroma56.github.io/Hoshi-Anime-Tracker/"><strong>▶ Open Hoshi Anime in your browser</strong></a>
</p><!-- When real screenshots are available, add the files to .github/readme/ and uncomment:
<p align="center"><img src=".github/readme/home.png" alt="Hoshi Anime home page" width="100%" /></p>
<table>
  <tr>
    <td width="50%"><img src=".github/readme/anime.png" alt="Anime details and playback" /></td>
    <td width="50%"><img src=".github/readme/manga.png" alt="Manga reader" /></td>
  </tr>
</table>
-->Features
- Anime discovery: Browse trending and seasonal anime, explore details, and search titles using AniList data.
- Anime information: Cover artwork, banners, synopses, genres, and episode-related details where available.
- Sub & Dub selection: Choose supported subtitle or dub playback options; actual availability depends on the source.
- Embedded video playback: Watch through supported third-party players, including the MegaPlay integration used by Hoshi.
- Custom Hoshi player (experimental): HTML5/HLS playback powered by hls.js, with subtitle-related controls when direct media sources are properly configured.
- Manga reader: Open available chapters from integrated providers and browse pages without leaving the Hoshi interface.
- Multiple manga sources: Worker-based integrations for MangaDex, ComicK, and WeebCentral, subject to upstream availability.
- Chapter language selection: Filter/select available manga chapter languages in supported source responses.
- Personal library and progress: Browser-local features for saving titles and continuing anime playback.
- Schedule and navigation: Browse anime releases and navigate between supported episodes.
- Responsive web interface: Layouts intended for desktop and mobile browsers, with continued refinements in progress.
Some listed features require configured backends. A title appearing in the catalogue does not guarantee a playable video or readable chapter.

Get started
Open the hosted web app:
<p align="center">
  <a href="https://chroma56.github.io/Hoshi-Anime-Tracker/"><strong>Launch Hoshi Anime →</strong></a>
</p>
No installation is required to visit the website. For local development, see below.
Technology stack
Component	Technology	Purpose
Frontend	HTML, CSS, vanilla JavaScript	Site, navigation, player UI, and manga reader
Frontend hosting	GitHub Pages	Static web hosting
Anime metadata	AniList GraphQL API	Anime catalogue, artwork, and details
Playback	hls.js, HTML5 video, external embeds	Experimental direct playback and embedded fallback
API gateway	Cloudflare Workers	Proxy and source-integration endpoints
Stream metadata backend	Node.js on Render	Optional direct stream metadata/resolution where configured
Manga data	MangaDex, ComicK, WeebCentral integrations	Manga details, chapters, and pages
Client storage	Browser localStorage	Local settings, saved titles, and progress where supported


How Hoshi works
                       ┌─────────────────────┐
                       │    Hoshi Anime      │
                       │  GitHub Pages site  │
                       └──────────┬──────────┘
                                  │
                ┌─────────────────┼────────────────┐
                │                 │                │
                ▼                 ▼                ▼
          AniList API      Cloudflare Workers   Browser storage
         anime metadata     API/source proxies  library & progress
                                  │
                          ┌───────┴────────┐
                          │                │
                          ▼                ▼
                    Manga providers   Episode metadata /
                                      configured backend
                                           │
                                           ▼
                                     External embed or
                                     supported HLS player
GitHub Pages hosts the frontend only. Cloudflare Workers and the Render backend are deployed and configured separately; the static site does not run a Node.js server by itself.
Development & local preview
1. Get the project
git clone https://github.com/Chroma56/Hoshi-Anime-Tracker.git
cd Hoshi-Anime-Tracker
2. Run a local web server
The current web frontend can be served as static files. You do not need to install React, Vite, or Electron to preview the HTML frontend.
python -m http.server 8000
Open http://localhost:8000 in your browser.

If Python is unavailable, use another static file server (such as VS Code Live Server). Some API/browser features may not work when opening index.html directly via file://.
3. Configure your APIs
The frontend references external endpoints in index.html. The current Hoshi setup includes variables such as:
var API_BASE = "https://anime-proxy.tasinsadman302.workers.dev";
var STREAM_API_BASE = "https://hoshi-stream.tasinsadman302.workers.dev";
var RPC_BASE = "https://hoshi-manga-api.tasinsadman302.workers.dev";
var MD_BASE = "https://hoshi-mangadex.tasinsadman302.workers.dev";
These are example endpoints from the Hoshi frontend and may change. If you are deploying your own instance, replace them with Workers you control and configure any required backend settings, CORS allowlists, and provider credentials in the respective hosting services. Never place secret API keys or backend signing secrets in public frontend code.
Deploy to GitHub Pages
1. Push the frontend files, including index.html, to your GitHub repository.
2. Open Settings → Pages in the repository.
3. Under Build and deployment, choose Deploy from a branch.
4. Choose your publishing branch (usually main) and /(root), then save.
5. Visit https://chroma56.github.io/Hoshi-Anime-Tracker/ once GitHub Pages has published the site.
[!IMPORTANT]
GitHub Pages does not deploy Cloudflare Workers or the Render backend. Deploy and secure those separately, then connect their endpoints from the frontend. Some playback and manga features will remain unavailable until the upstream integrations work.

Current development notes
Area	State
AniList browsing and anime details	Integrated in the frontend
Sub/Dub external embeds	Implemented; availability varies by title
Manga source and language controls	Implemented; source reliability varies
Custom HLS/direct player	Experimental; requires a valid authorised stream source
GitHub Pages frontend	Static deployment supported
Node/Cloudflare integrations	Separate deployment and configuration required


Troubleshooting
A video works in an embed but not in the Hoshi player. An embedded website does not automatically expose a direct HLS or MP4 URL. The custom player needs a playable, authorised media URL from a configured source/backend; use the embed fallback if one is not available.

A manga has no chapters. Chapter availability differs between providers and languages. Try another source or language and check the relevant Worker logs.

The website opens but API features fail. Check the Worker URLs, CORS configuration, provider status, and browser developer console.
Contributing & feedback
Found a bug or want to suggest a feature? Open a GitHub issue with the affected title/page, the problem, and any useful error details. Contributions should respect applicable copyright and the terms of connected services.
Legal & copyright
Hoshi Anime is an independent project and is not affiliated with AniList, MangaDex, ComicK, streaming providers, publishers, studios, or rights holders. Third-party names and artwork belong to their respective owners.

For copyright-related concerns and takedown requests, see [LEGAL.md](LEGAL.md). Copyright holders can also use GitHub Issues to report a specific URL or source. Please do not post private personal details in public issues.
License
Review the repository for an applicable license before copying, modifying, or redistributing its code. This README does not grant a separate license.
<p align="center">
  Made for anime and manga fans. <strong>✦ Hoshi Anime</strong><br />
  <a href="https://chroma56.github.io/Hoshi-Anime-Tracker/">Web App</a> ·
  <a href="https://github.com/Chroma56/Hoshi-Anime-Tracker">GitHub</a> ·
  <a href="LEGAL.md">Legal</a>
</p>
