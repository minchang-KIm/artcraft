use std::io::Write;
use tauri_plugin_dialog::DialogExt;

/// The destination comes exclusively from a native save dialog, never IPC arguments.
#[tauri::command]
pub async fn total_recall_export_glb(app: tauri::AppHandle, content: Vec<u8>) -> Result<bool, String> {
  total_recall_project_store::validate_glb(&content).map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
    let Some(destination) = app.dialog().file().add_filter("GLB", &["glb"]).set_file_name("character.glb").blocking_save_file() else {
      return Ok(false);
    };
    let destination = destination.into_path().map_err(|e| e.to_string())?;
    if !destination.extension().and_then(|x| x.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("glb")) {
      return Err("Choose a .glb file name.".into());
    }
    let directory = destination.parent().ok_or_else(|| "Invalid destination".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temp.write_all(&content).and_then(|_| temp.as_file().sync_all()).map_err(|e| e.to_string())?;
    temp.persist(&destination).map_err(|e| e.error.to_string())?;
    Ok(true)
  }).await.map_err(|e| e.to_string())?
}
