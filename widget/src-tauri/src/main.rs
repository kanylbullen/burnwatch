// Frameless always-on-top shell for the burnwatch widget.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

const WINDOW_LABEL: &str = "widget";

#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    /// Base address of the burnwatch daemon, without a trailing slash.
    url: String,
    /// Shared secret matching the daemon's BURNWATCH_TOKEN.
    token: String,
    x: Option<i32>,
    y: Option<i32>,
    width: u32,
    height: u32,
    always_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            url: "http://127.0.0.1:8787".into(),
            token: String::new(),
            x: None,
            y: None,
            width: 260,
            height: 260,
            always_on_top: true,
        }
    }
}

impl Settings {
    /// File first, then environment. Env wins so a machine can be pointed at a
    /// different daemon without editing a file that the app rewrites on move.
    fn load(path: &PathBuf) -> Self {
        let mut s = fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .unwrap_or_default();

        if let Ok(url) = std::env::var("BURNWATCH_URL") {
            if !url.trim().is_empty() {
                s.url = url.trim_end_matches('/').to_string();
            }
        }
        if let Ok(token) = std::env::var("BURNWATCH_TOKEN") {
            if !token.is_empty() {
                s.token = token;
            }
        }
        s
    }

    fn save(&self, path: &PathBuf) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = fs::write(path, text);
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let cfg_path = config_path(app.handle());
            let settings = Settings::load(&cfg_path);

            // Injected before any page script, so app.js finds its endpoint on
            // first paint rather than racing an eval() sent after load.
            let boot = format!(
                "globalThis.__BURNWATCH__ = {};",
                serde_json::json!({ "url": settings.url, "token": settings.token })
            );

            let window =
                WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::default())
                    .title("burnwatch")
                    .min_inner_size(180.0, 180.0)
                    .resizable(true)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(settings.always_on_top)
                    .skip_taskbar(true)
                    .shadow(false)
                    .visible(false)
                    .initialization_script(&boot)
                    .build()?;

            // Geometry is applied in physical pixels because that is how it was
            // measured on the way out. The builder's inner_size/position take
            // logical pixels, so on any scaled display the saved physical value
            // was re-read as logical and multiplied by the scale factor again —
            // the window grew, and walked further off-screen, on every launch.
            window.set_size(PhysicalSize::new(settings.width, settings.height))?;
            if let (Some(x), Some(y)) = (settings.x, settings.y) {
                window.set_position(PhysicalPosition::new(x, y))?;
            }
            window.show()?;

            let pin = CheckMenuItem::with_id(
                app,
                "pin",
                "Always on top",
                true,
                settings.always_on_top,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&pin, &quit])?;

            // A frameless, taskbar-less window has no other way to be closed or
            // unpinned once it is on screen.
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("burnwatch")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    "pin" => {
                        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                            let path = config_path(app);
                            let mut s = Settings::load(&path);
                            s.always_on_top = !s.always_on_top;
                            let _ = w.set_always_on_top(s.always_on_top);
                            s.save(&path);
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Remember where the widget was parked, and its size.
            let persist = matches!(
                event,
                WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Destroyed
            );
            if !persist {
                return;
            }

            let path = config_path(window.app_handle());
            let mut s = Settings::load(&path);

            if let Ok(PhysicalPosition { x, y }) = window.outer_position() {
                s.x = Some(x);
                s.y = Some(y);
            }
            if let Ok(size) = window.inner_size() {
                s.width = size.width;
                s.height = size.height;
            }
            s.save(&path);
        })
        .run(tauri::generate_context!())
        .expect("failed to start burnwatch widget");
}
