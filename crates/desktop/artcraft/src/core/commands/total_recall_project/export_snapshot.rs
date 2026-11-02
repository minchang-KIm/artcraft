use std::io::Write;
use tauri_plugin_dialog::DialogExt;

/// Only a native save dialog may supply the destination path.
#[tauri::command]
pub async fn total_recall_export_snapshot(app: tauri::AppHandle, content: String) -> Result<bool, String> {
  if content.len() > 150 * 1024 * 1024 { return Err("Render snapshot exceeds 150 MiB".into()); }
  let document: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
  if document.get("format").and_then(|v| v.as_str()) != Some("total-recall-webtoon-import") || document.get("version").and_then(|v| v.as_u64()) != Some(1) {
    return Err("Invalid render snapshot".into());
  }
  tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
    let Some(destination) = app.dialog().file().add_filter("JSON", &["json"]).set_file_name("webtoon-render.json").blocking_save_file() else { return Ok(false); };
    let destination = destination.into_path().map_err(|e| e.to_string())?;
    if !destination.extension().and_then(|x| x.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("json")) { return Err("Choose a .json file name.".into()); }
    let directory = destination.parent().ok_or_else(|| "Invalid destination".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temp.write_all(content.as_bytes()).and_then(|_| temp.as_file().sync_all()).map_err(|e| e.to_string())?;
    temp.persist_noclobber(&destination).map_err(|e| e.error.to_string())?;
    Ok(true)
  }).await.map_err(|e| e.to_string())?
}
