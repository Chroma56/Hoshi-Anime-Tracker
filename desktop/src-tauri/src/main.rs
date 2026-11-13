// Hoshi for the desktop, built with Tauri (Rust).
//
// A small native window around the Hoshi site. It uses the web engine that ships with
// Windows (WebView2) instead of bundling a whole browser, which is why the installer is a
// few megabytes and the app starts quickly and uses little memory.
//
// The app IS the site: whatever is uploaded to GitHub Pages shows up the next time the app
// starts. This shell only needs rebuilding when something in this folder changes.
//
// What the shell adds over a browser tab:
//   - its own window, taskbar icon and Start menu entry
//   - storage no browser privacy setting clears (Continue watching, library, profile)
//   - pop-up windows from embedded players are refused
//   - if the window is ever taken somewhere else, it comes straight back to Hoshi

// No console window behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    webview::{NewWindowResponse, WebviewWindowBuilder},
    WebviewUrl,
};

/// Runs at the start of every top-level page, before the page's own scripts.
///
/// The window should only ever show Hoshi or the bundled start page. If a click inside an
/// embedded player manages to navigate the whole window somewhere else, this sends it back.
/// The site gets no access to this computer either way: no Tauri commands are exposed to it.
const STAY_ON_HOSHI: &str = r#"
(function () {
  var APP = "https://chroma56.github.io/Hoshi-Anime-Tracker/";
  if (window.top !== window) return;
  var here = String(location.href);
  var local = location.hostname === "tauri.localhost" || location.protocol === "tauri:";
  if (here.indexOf(APP) === 0 || local || here === "about:blank") return;
  location.replace(APP);
})();
"#;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // The window opens on the bundled start page (dist/start.html). It checks the
            // connection and moves on to the site, or says so when there is no internet.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("start.html".into()))
                .title("Hoshi")
                .inner_size(1360.0, 860.0)
                .min_inner_size(480.0, 360.0)
                .center()
                .initialization_script(STAY_ON_HOSHI)
                // window.open and target="_blank": never. Nearly all of these come from
                // advertising inside embedded players.
                .on_new_window(|_url, _features| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Hoshi could not start");
}
