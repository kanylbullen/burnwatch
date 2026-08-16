// Frameless always-on-top shell for the burnwatch widget.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

const WINDOW_LABEL: &str = "widget";
const TRAY_ID: &str = "burnwatch";

/// Draws the weekly allowance as a ring, filled clockwise from twelve o'clock.
///
/// A tray icon that never changes is just a launcher. This one carries the one
/// number worth glancing at, with no text: glyphs at 32px are unreadable, and
/// rendering them would mean bundling a font to say what a filled arc already
/// says. Above 90% the ring turns red, because that is when you want to notice
/// it without hovering.
fn meter_icon(pct: Option<f64>) -> Image<'static> {
    let (buf, size) = meter_rgba(pct);
    Image::new_owned(buf, size, size)
}

fn meter_rgba(pct: Option<f64>) -> (Vec<u8>, u32) {
    const S: usize = 32;
    const OUTER: f64 = 15.0;
    const INNER: f64 = 10.0;
    const TAU: f64 = std::f64::consts::TAU;

    let centre = (S as f64 - 1.0) / 2.0;
    let filled = pct.unwrap_or(0.0).clamp(0.0, 100.0) / 100.0;
    let (fr, fg, fb) = if pct.unwrap_or(0.0) >= 90.0 {
        (255u8, 45u8, 0u8)
    } else {
        (255u8, 75u8, 18u8)
    };

    let mut buf = vec![0u8; S * S * 4];
    for y in 0..S {
        for x in 0..S {
            let dx = x as f64 - centre;
            let dy = y as f64 - centre;
            let dist = dx.hypot(dy);
            if dist > OUTER + 0.5 || dist < INNER - 0.5 {
                continue;
            }

            // Feather the ring's edges so it does not look like a staircase.
            let edge = (OUTER - dist).min(dist - INNER).clamp(0.0, 1.0);

            let angle = (dx.atan2(-dy) + TAU) % TAU;
            let (r, g, b, a) = if pct.is_none() {
                (90u8, 90u8, 100u8, 120u8) // no reading yet
            } else if angle / TAU <= filled {
                (fr, fg, fb, 255u8)
            } else {
                (111u8, 98u8, 216u8, 90u8) // the unspent remainder
            };

            let i = (y * S + x) * 4;
            buf[i] = r;
            buf[i + 1] = g;
            buf[i + 2] = b;
            buf[i + 3] = (a as f64 * edge) as u8;
        }
    }
    (buf, S as u32)
}

#[cfg(test)]
mod tests {
    use super::meter_rgba;

    /// Colour of the ring pixel at a clock position, as (r, g, b).
    fn at_clock(buf: &[u8], size: u32, fraction: f64) -> (u8, u8, u8) {
        let s = size as f64;
        let centre = (s - 1.0) / 2.0;
        let radius = 12.5;
        let angle = fraction * std::f64::consts::TAU;
        let x = (centre + radius * angle.sin()).round() as usize;
        let y = (centre - radius * angle.cos()).round() as usize;
        let i = (y * size as usize + x) * 4;
        (buf[i], buf[i + 1], buf[i + 2])
    }

    const SPENT: (u8, u8, u8) = (255, 75, 18);
    const REMAINDER: (u8, u8, u8) = (111, 98, 216);

    #[test]
    fn fills_clockwise_from_twelve() {
        let (buf, size) = meter_rgba(Some(50.0));
        // Quarter past is inside the first half; quarter to is not.
        assert_eq!(at_clock(&buf, size, 0.25), SPENT);
        assert_eq!(at_clock(&buf, size, 0.75), REMAINDER);
    }

    #[test]
    fn an_almost_empty_ring_is_almost_all_remainder() {
        let (buf, size) = meter_rgba(Some(5.0));
        assert_eq!(at_clock(&buf, size, 0.25), REMAINDER);
        assert_eq!(at_clock(&buf, size, 0.75), REMAINDER);
    }

    #[test]
    fn turns_red_only_once_nearly_exhausted() {
        let (hot, size) = meter_rgba(Some(95.0));
        assert_eq!(at_clock(&hot, size, 0.25), (255, 45, 0));
        let (warm, size) = meter_rgba(Some(89.0));
        assert_eq!(at_clock(&warm, size, 0.25), SPENT);
    }

    #[test]
    fn no_reading_is_neither_spent_nor_remaining() {
        let (buf, size) = meter_rgba(None);
        assert_eq!(at_clock(&buf, size, 0.25), (90, 90, 100));
        assert_eq!(at_clock(&buf, size, 0.75), (90, 90, 100));
    }

    #[test]
    fn the_centre_stays_transparent() {
        let (buf, size) = meter_rgba(Some(100.0));
        let mid = ((size as usize / 2) * size as usize + size as usize / 2) * 4;
        assert_eq!(buf[mid + 3], 0);
    }
}

/// Pushed from the page after each successful reading.
#[tauri::command]
fn set_tray(app: AppHandle, weekly: Option<f64>, tooltip: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(meter_icon(weekly)));
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

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
    /// "dark" or "light".
    theme: String,
    /// Background opacity in percent. 100 is solid, 0 leaves only the text.
    opacity: u8,
    /// Discreet mode: nothing on screen until you ask for it.
    ///
    /// The tray ring already carries the number worth glancing at, so the
    /// window becomes the detail view rather than a permanent fixture. Left
    /// click summons it, moving focus elsewhere dismisses it again.
    discreet: bool,
}

/// The subset the page needs in order to paint itself.
#[derive(Clone, Serialize)]
struct Appearance {
    theme: String,
    opacity: u8,
}

const OPACITY_STEPS: [u8; 5] = [100, 85, 65, 40, 15];

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
            theme: "dark".into(),
            opacity: 100,
            discreet: false,
        }
    }
}

impl Settings {
    fn appearance(&self) -> Appearance {
        Appearance {
            theme: self.theme.clone(),
            opacity: self.opacity,
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

    /// Writes the settings back, without ever *introducing* a secret to disk.
    ///
    /// A token supplied through the environment used to be persisted here the
    /// first time the window moved, so choosing the safer input silently
    /// produced the less safe storage. Now the file keeps a token only if it
    /// already had one, and the file is owner-only on Unix.
    fn save(&self, path: &PathBuf) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }

        let mut out = Settings {
            token: if Self::file_had_token(path) {
                self.token.clone()
            } else {
                String::new()
            },
            ..Settings::default()
        };
        out.url = self.url.clone();
        out.x = self.x;
        out.y = self.y;
        out.width = self.width;
        out.height = self.height;
        out.always_on_top = self.always_on_top;
        out.theme = self.theme.clone();
        out.opacity = self.opacity;
        out.discreet = self.discreet;

        if let Ok(text) = serde_json::to_string_pretty(&out) {
            if fs::write(path, text).is_ok() {
                Self::restrict(path);
            }
        }
    }

    fn file_had_token(path: &PathBuf) -> bool {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .is_some_and(|s| !s.token.is_empty())
    }

    #[cfg(unix)]
    fn restrict(path: &PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    #[cfg(not(unix))]
    fn restrict(_path: &PathBuf) {
        // Windows inherits the user profile's ACL, which is already owner-only.
    }
}

/// Whether this point lies on any attached display.
///
/// Checks the top-left corner with a small margin, so a window nudged slightly
/// off an edge still counts — the case worth catching is a position from an
/// entirely different monitor layout, not a few pixels of overhang.
fn on_some_monitor(window: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    const MARGIN: i32 = 80;
    let Ok(monitors) = window.available_monitors() else {
        return true; // Cannot tell; trust the saved value rather than move it.
    };
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x - MARGIN
            && y >= p.y - MARGIN
            && x < p.x + s.width as i32 + MARGIN
            && y < p.y + s.height as i32 + MARGIN
    })
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_tray])
        .setup(|app| {
            // `skip_taskbar` is a no-op on macOS, where the equivalent is the
            // activation policy: without this the widget takes a Dock slot and
            // a menu bar of its own, which is not what a always-on-top meter
            // should do.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let cfg_path = config_path(app.handle());
            let settings = Settings::load(&cfg_path);

            // Injected before any page script, so app.js finds its endpoint on
            // first paint rather than racing an eval() sent after load.
            let boot = format!(
                "globalThis.__BURNWATCH__ = {};",
                serde_json::json!({
                    "url": settings.url,
                    "token": settings.token,
                    "theme": settings.theme,
                    "opacity": settings.opacity,
                })
            );

            let window =
                WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::default())
                    .title("burnwatch")
                    .min_inner_size(180.0, 180.0)
                    .resizable(true)
                    .decorations(false)
                    // Always transparent at the window level; how much shows
                    // through is the page's business, set by the opacity menu.
                    // Doing it the other way — rebuilding the window on each
                    // change — would lose position, focus and the webview.
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
                // Only if that point is actually on a screen. A config copied
                // from another machine — the obvious way to set up the second
                // one — carries coordinates from its monitor layout, and this
                // window is frameless and absent from the taskbar: put it past
                // the edge and there is nothing left to click.
                if on_some_monitor(&window, x, y) {
                    window.set_position(PhysicalPosition::new(x, y))?;
                } else {
                    let _ = window.center();
                }
            }
            if !settings.discreet {
                window.show()?;
            }

            let pin = CheckMenuItem::with_id(
                app,
                "pin",
                "Always on top",
                true,
                settings.always_on_top,
                None::<&str>,
            )?;

            let dark = CheckMenuItem::with_id(
                app, "theme:dark", "Dark", true, settings.theme == "dark", None::<&str>,
            )?;
            let light = CheckMenuItem::with_id(
                app, "theme:light", "Light", true, settings.theme == "light", None::<&str>,
            )?;
            let theme_menu = Submenu::with_items(app, "Theme", true, &[&dark, &light])?;

            let mut steps = Vec::new();
            for step in OPACITY_STEPS {
                steps.push(CheckMenuItem::with_id(
                    app,
                    format!("opacity:{step}"),
                    if step == 100 { "Solid".into() } else { format!("{step}%") },
                    true,
                    settings.opacity == step,
                    None::<&str>,
                )?);
            }
            let step_refs: Vec<&dyn IsMenuItem<_>> =
                steps.iter().map(|i| i as &dyn IsMenuItem<_>).collect();
            let opacity_menu = Submenu::with_items(app, "Background", true, &step_refs)?;

            let discreet = CheckMenuItem::with_id(
                app,
                "discreet",
                "Discreet (click the tray to peek)",
                true,
                settings.discreet,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&pin, &discreet, &theme_menu, &opacity_menu, &quit],
            )?;

            // The check marks are driven from the saved settings rather than
            // toggled in place, so the menu can never drift out of step with
            // what is actually stored.
            let sync = {
                let pin = pin.clone();
                let dark = dark.clone();
                let light = light.clone();
                let discreet = discreet.clone();
                let steps = steps.clone();
                move |s: &Settings| {
                    let _ = pin.set_checked(s.always_on_top);
                    let _ = dark.set_checked(s.theme == "dark");
                    let _ = light.set_checked(s.theme == "light");
                    let _ = discreet.set_checked(s.discreet);
                    for (item, step) in steps.iter().zip(OPACITY_STEPS) {
                        let _ = item.set_checked(s.opacity == step);
                    }
                }
            };

            // A frameless, taskbar-less window has no other way to be closed or
            // unpinned once it is on screen.
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(meter_icon(None))
                .tooltip("burnwatch — waiting for a reading")
                .menu(&menu)
                // Left click is the peek; the menu moves to right click. On
                // Linux this has no effect: libappindicator exposes a menu and
                // no click events at all, so the menu stays the only way in.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    let TrayIconEvent::Click { button, button_state, .. } = event
                    else {
                        return;
                    };
                    if button != MouseButton::Left || button_state != MouseButtonState::Up {
                        return;
                    }
                    let app = tray.app_handle();
                    let Some(w) = app.get_webview_window(WINDOW_LABEL) else {
                        return;
                    };
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                })
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref().to_string();
                    if id == "quit" {
                        app.exit(0);
                        return;
                    }

                    let path = config_path(app);
                    let mut s = Settings::load(&path);

                    if id == "pin" {
                        s.always_on_top = !s.always_on_top;
                        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                            let _ = w.set_always_on_top(s.always_on_top);
                        }
                    } else if id == "discreet" {
                        s.discreet = !s.discreet;
                        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                            // Turning it on takes effect immediately, so the
                            // setting is a verb rather than a promise about the
                            // next launch.
                            let _ = if s.discreet { w.hide() } else { w.show() };
                        }
                    } else if let Some(theme) = id.strip_prefix("theme:") {
                        s.theme = theme.to_string();
                    } else if let Some(step) = id.strip_prefix("opacity:") {
                        match step.parse::<u8>() {
                            Ok(v) => s.opacity = v,
                            Err(_) => return,
                        }
                    } else {
                        return;
                    }

                    s.save(&path);
                    sync(&s);
                    // The page owns how it looks; Rust only says what changed.
                    let _ = app.emit("appearance", s.appearance());
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // In discreet mode, looking away dismisses it. That is what makes
            // the peek a peek: no second click to put it away, and nothing left
            // on screen because you got distracted.
            if let WindowEvent::Focused(false) = event {
                let path = config_path(window.app_handle());
                if Settings::load(&path).discreet {
                    let _ = window.hide();
                }
                return;
            }

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
