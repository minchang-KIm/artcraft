use crate::core::state::data_dir::app_data_root::AppDataRoot;
use crate::core::state::data_dir::trait_data_subdir::DataSubdir;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

const KEYS: [&str; 15] = [
  "TOTAL_RECALL_IMPORT_PYTHON", "TOTAL_RECALL_IMPORT_WORKER",
  "TOTAL_RECALL_RENDER_PYTHON", "TOTAL_RECALL_RENDER_WORKER", "TOTAL_RECALL_RENDER_FFMPEG",
  "TOTAL_RECALL_RIG_PYTHON", "TOTAL_RECALL_RIG_WORKER", "TOTAL_RECALL_RIG_WORKSPACE",
  "TOTAL_RECALL_VOICE_PYTHON", "TOTAL_RECALL_VOICE_WORKER", "TOTAL_RECALL_VOICE_ESPEAK",
  "TOTAL_RECALL_MHR_PYTHON", "TOTAL_RECALL_MHR_WORKER", "TOTAL_RECALL_MHR_MODEL", "TOTAL_RECALL_MHR_ROOT",
];
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings { version: u32, paths: BTreeMap<String, PathBuf> }

fn settings_path(root: &AppDataRoot) -> PathBuf {
  root.settings_dir().path().join("total_recall_workers.json")
}
fn validate_key(key: &str) -> Result<(), String> {
  if KEYS.contains(&key) { Ok(()) } else { Err("Unknown local worker setting".into()) }
}
fn read(path: &Path) -> Result<Settings, String> {
  let bytes = match std::fs::read(path) {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Settings { version: 1, paths: BTreeMap::new() }),
    Err(error) => return Err(format!("Cannot read local worker settings: {error}")),
  };
  if bytes.len() > 65536 { return Err("Local worker settings are too large".into()); }
  let settings: Settings = serde_json::from_slice(&bytes).map_err(|error| format!("Invalid local worker settings: {error}"))?;
  if settings.version != 1 || settings.paths.keys().any(|key| validate_key(key).is_err()) || settings.paths.values().any(|path| !path.is_absolute()) {
    return Err("Unsupported local worker settings".into());
  }
  Ok(settings)
}
fn update(path: &Path, key: &str, value: Option<PathBuf>) -> Result<(), String> {
  validate_key(key)?;
  let _guard = SETTINGS_LOCK.lock().map_err(|_| "Worker settings unavailable")?;
  let mut settings = read(path)?;
  if let Some(value) = value {
    let valid = value.is_absolute() && if (key == "TOTAL_RECALL_MHR_ROOT" || key == "TOTAL_RECALL_RIG_WORKSPACE") { value.is_dir() } else { value.is_file() };
    if !valid { return Err("Choose an existing local file or directory".into()); }
    settings.paths.insert(key.to_owned(), value);
  } else { settings.paths.remove(key); }
  let directory = path.parent().ok_or("Invalid settings path")?;
  let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
  serde_json::to_writer(&mut temp, &settings).map_err(|error| error.to_string())?;
  temp.flush().and_then(|_| temp.as_file().sync_all()).map_err(|error| error.to_string())?;
  temp.persist(path).map_err(|error| error.error.to_string())?;
  Ok(())
}

pub fn configured(root: &AppDataRoot, key: &str) -> Result<PathBuf, String> {
  validate_key(key)?;
  if let Some(value) = std::env::var_os(key).filter(|value| !value.is_empty()) { return Ok(PathBuf::from(value)); }
  let _guard = SETTINGS_LOCK.lock().map_err(|_| "Worker settings unavailable")?;
  read(&settings_path(root))?.paths.remove(key).ok_or_else(|| format!("Local worker is not configured: {key}. Choose it in Local worker settings."))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSetting { key: String, path: Option<PathBuf>, source: &'static str }

#[tauri::command]
pub fn total_recall_worker_settings(root: State<'_, AppDataRoot>) -> Result<Vec<WorkerSetting>, String> {
  let _guard = SETTINGS_LOCK.lock().map_err(|_| "Worker settings unavailable")?;
  let settings = read(&settings_path(&root))?;
  Ok(KEYS.iter().map(|key| {
    if let Some(value) = std::env::var_os(key).filter(|value| !value.is_empty()) {
      WorkerSetting { key: (*key).into(), path: Some(value.into()), source: "environment" }
    } else if let Some(path) = settings.paths.get(*key) {
      WorkerSetting { key: (*key).into(), path: Some(path.clone()), source: "saved" }
    } else { WorkerSetting { key: (*key).into(), path: None, source: "missing" } }
  }).collect())
}

/// Executable and model paths can only be selected through the native dialog.
#[tauri::command]
pub async fn total_recall_choose_worker_setting(app: tauri::AppHandle, root: State<'_, AppDataRoot>, key: String) -> Result<bool, String> {
  validate_key(&key)?;
  let path = settings_path(&root);
  tauri::async_runtime::spawn_blocking(move || {
    let dialog = app.dialog().file().set_title(format!("Choose {key}"));
    let choice = if (key == "TOTAL_RECALL_MHR_ROOT" || key == "TOTAL_RECALL_RIG_WORKSPACE") { dialog.blocking_pick_folder() } else { dialog.blocking_pick_file() };
    let Some(choice) = choice else { return Ok(false); };
    let value = choice.into_path().map_err(|error| error.to_string())?;
    update(&path, &key, Some(value))?;
    Ok(true)
  }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn total_recall_clear_worker_setting(root: State<'_, AppDataRoot>, key: String) -> Result<(), String> {
  update(&settings_path(&root), &key, None)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn settings_validate_and_preserve_other_paths() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let file = temp.path().join("worker.py");
    std::fs::write(&file, "worker").unwrap();
    update(&settings, "TOTAL_RECALL_RENDER_WORKER", Some(file.clone())).unwrap();
    update(&settings, "TOTAL_RECALL_MHR_ROOT", Some(temp.path().to_path_buf())).unwrap();
    assert_eq!(read(&settings).unwrap().paths.get("TOTAL_RECALL_RENDER_WORKER"), Some(&file));
    assert!(update(&settings, "UNRECOGNIZED", Some(file.clone())).is_err());
    assert!(update(&settings, "TOTAL_RECALL_MHR_ROOT", Some(file)).is_err());
    update(&settings, "TOTAL_RECALL_MHR_ROOT", None).unwrap();
    assert_eq!(read(&settings).unwrap().paths.len(), 1);
    std::fs::write(&settings, br#"{"version":2,"paths":{}}"#).unwrap();
    assert!(read(&settings).is_err());
  }
}
