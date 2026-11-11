#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use image::{DynamicImage, GrayImage};
use rqrr::PreparedImage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct Account {
    id: String,
    issuer: String,
    label: String,
    secret: String,
    /// SHA1 | SHA256 | SHA512
    algorithm: String,
    digits: u32,
    period: u64,
    color: String,
}

fn new_id() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("acc-{}", n)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn accounts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("accounts.json"))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn file_path_to_buf(fp: FilePath) -> Result<PathBuf, String> {
    match fp {
        FilePath::Path(p) => Ok(p),
        FilePath::Url(u) => Ok(PathBuf::from(u.path())),
        other => Err(format!("Unsupported file path: {:?}", other)),
    }
}

// ---------------------------------------------------------------------------
// QR decoding
// ---------------------------------------------------------------------------

fn decode_qr_image(img: &DynamicImage) -> Vec<String> {
    let mut gray: GrayImage = img.to_luma8();
    let (w, h) = (gray.width(), gray.height());
    if w == 0 || h == 0 {
        return Vec::new();
    }
    // Small images (uploads, tight overlay regions) decode far better when
    // upscaled with a nearest-neighbour filter before binarisation.
    if w < 320 || h < 320 {
        let f = ((320.0 / w.max(h) as f32).ceil() as u32).clamp(2, 8);
        gray = image::imageops::resize(&gray, w * f, h * f, image::imageops::FilterType::Nearest);
    }
    let mut prepared = PreparedImage::prepare(gray);
    let grids = prepared.detect_grids();
    let mut out: Vec<String> = Vec::new();
    for g in grids {
        if let Ok((_, content)) = g.decode() {
            if !out.contains(&content) {
                out.push(content);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn load_accounts(app: AppHandle) -> Result<Vec<Account>, String> {
    let path = accounts_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Accept both a bare array and the backup envelope { "accounts": [...] }.
    if let Ok(list) = serde_json::from_str::<Vec<Account>>(&data) {
        return Ok(list);
    }
    let v: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let list = v
        .get("accounts")
        .cloned()
        .ok_or_else(|| "Corrupt accounts file".to_string())?;
    serde_json::from_value::<Vec<Account>>(list).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_accounts(app: AppHandle, accounts: Vec<Account>) -> Result<(), String> {
    let path = accounts_path(&app)?;
    let data = serde_json::to_string_pretty(&accounts).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

/// Parse an otpauth://totp/... URI (the format every authenticator app and
/// Google Authenticator export QR code uses) into an account.
#[tauri::command]
fn parse_otpauth(uri: String) -> Result<Account, String> {
    let uri = uri.trim();
    if !uri.to_ascii_lowercase().starts_with("otpauth://") {
        return Err("Not an otpauth:// URI".into());
    }
    let rest = &uri["otpauth://".len()..];
    let (otype, after) = rest.split_once('/').ok_or("Missing type in URI")?;
    if !otype.eq_ignore_ascii_case("totp") {
        return Err(format!("Unsupported authenticator type: {}", otype));
    }
    let (label_raw, query_raw) = after.split_once('?').ok_or("No parameters in URI")?;

    let mut issuer = String::new();
    let mut secret = String::new();
    let mut algorithm = "SHA1".to_string();
    let mut digits: u32 = 6;
    let mut period: u64 = 30;

    for pair in query_raw.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let val = percent_decode(v);
        match k.to_ascii_lowercase().as_str() {
            "secret" => {
                secret = val.replace(' ', "").replace('-', "").to_uppercase();
            }
            "issuer" => issuer = val,
            "algorithm" => algorithm = val.to_uppercase(),
            "digits" => digits = val.parse().unwrap_or(6),
            "period" => period = val.parse().unwrap_or(30),
            _ => {}
        }
    }

    if secret.is_empty() {
        return Err("QR code has no secret".into());
    }
    if !matches!(algorithm.as_str(), "SHA256" | "SHA512") {
        algorithm = "SHA1".into();
    }
    if digits != 8 {
        digits = 6;
    }
    if period == 0 {
        period = 30;
    }

    let label = percent_decode(label_raw);
    let (label_issuer, label_name) = match label.split_once(':') {
        Some((i, l)) => (i.trim().to_string(), l.trim().to_string()),
        None => (String::new(), label.trim().to_string()),
    };
    if issuer.is_empty() {
        issuer = label_issuer;
    }

    Ok(Account {
        id: new_id(),
        issuer,
        label: label_name,
        secret,
        algorithm,
        digits,
        period,
        color: String::new(),
    })
}

/// Decode QR codes from an uploaded image (data URL with base64 payload).
#[tauri::command]
fn decode_image_qr(data_url: String) -> Result<Vec<String>, String> {
    let b64 = data_url.splitn(2, ',').last().unwrap_or("").trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Invalid image data: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    Ok(decode_qr_image(&img))
}

/// Capture every connected monitor and decode any QR codes on screen.
#[tauri::command]
fn capture_screen_qr() -> Result<Vec<String>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let mut all: Vec<String> = Vec::new();
    for m in monitors {
        if let Ok(img) = m.capture_image() {
            all.extend(decode_qr_image(&DynamicImage::ImageRgba8(img)));
        }
    }
    all.sort();
    all.dedup();
    Ok(all)
}

/// Capture a physical-pixel screen region (used by the live overlay window)
/// and decode any QR codes inside it.
#[tauri::command]
fn capture_region_qr(x: i32, y: i32, w: u32, h: u32) -> Result<Vec<String>, String> {
    if w == 0 || h == 0 {
        return Ok(Vec::new());
    }
    let monitor = xcap::Monitor::from_point(x, y).map_err(|e| e.to_string())?;
    let mx = monitor.x().map_err(|e| e.to_string())?;
    let my = monitor.y().map_err(|e| e.to_string())?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;

    let rx = (x - mx).max(0).min(img.width() as i32 - 1) as u32;
    let ry = (y - my).max(0).min(img.height() as i32 - 1) as u32;
    let rw = w.min(img.width().saturating_sub(rx)).max(1);
    let rh = h.min(img.height().saturating_sub(ry)).max(1);

    let cropped = image::imageops::crop_imm(&img, rx, ry, rw, rh).to_image();
    Ok(decode_qr_image(&DynamicImage::ImageRgba8(cropped)))
}

/// Save an encrypted-free JSON backup to a user chosen file.
#[tauri::command]
fn export_backup(app: AppHandle, accounts: Vec<Account>) -> Result<String, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("Authenticator backup", &["json"])
        .set_file_name("authenticator-backup.json")
        .blocking_save_file();
    let Some(fp) = file else {
        return Ok("cancelled".into());
    };
    let path = file_path_to_buf(fp)?;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let payload = json!({
        "app": "windows-authenticator",
        "version": 1,
        "exportedAt": secs,
        "accounts": accounts
    });
    let data = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Read a backup file and return its accounts (merging is done in the UI).
#[tauri::command]
fn import_backup(app: AppHandle) -> Result<Vec<Account>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("Authenticator backup", &["json"])
        .blocking_pick_file();
    let Some(fp) = file else {
        return Ok(Vec::new());
    };
    let path = file_path_to_buf(fp)?;
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let list = if v.is_array() {
        v
    } else {
        v.get("accounts")
            .cloned()
            .ok_or_else(|| "No accounts found in backup file".to_string())?
    };
    serde_json::from_value::<Vec<Account>>(list).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_accounts,
            save_accounts,
            parse_otpauth,
            decode_image_qr,
            capture_screen_qr,
            capture_region_qr,
            export_backup,
            import_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running Authenticator");
}
