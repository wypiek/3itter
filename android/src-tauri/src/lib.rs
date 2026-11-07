//! 3itter Android client.
//!
//! The app is a thin, fast Rust shell around the system WebView. It starts on a local
//! instance picker (`../src`), which remembers the 3itter instance you use and opens it.
//! Instances are plain web apps, so everything you can do on the site works in the app;
//! the web client notices it runs inside the app (`?client=android`) and offers a
//! "Switch instance" button that returns here.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the 3itter app");
}
