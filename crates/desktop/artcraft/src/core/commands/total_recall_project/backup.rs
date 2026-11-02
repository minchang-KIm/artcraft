use crate::core::commands::total_recall_project::database_path;
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use std::io::Write;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use total_recall_project_store::ProjectStore;

/// The native dialog is the only source of the destination path.
#[tauri::command]
pub async fn total_recall_backup_export(app: tauri::AppHandle, root: State<'_, AppDataRoot>) -> Result<bool, String> {
  let database = database_path(&root);
  tauri::async_runtime::spawn_blocking(move || {
    let Some(destination) = app.dialog().file().blocking_save_file() else { return Ok(false); };
    let destination = destination.into_path().map_err(|error| error.to_string())?;
    if !destination.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("trbackup")) { return Err("Choose a .trbackup file name".into()); }
    let directory = destination.parent().ok_or("Invalid backup destination")?;
    let stage = tempfile::tempdir_in(directory).map_err(|error| error.to_string())?;
    let snapshot = stage.path().join("snapshot.sqlite");
    let store = ProjectStore::open(database).map_err(|error| error.to_string())?;
    store.export_backup(&snapshot).map_err(|error| error.to_string())?;
    let mut output = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    let mut input = std::fs::File::open(snapshot).map_err(|error| error.to_string())?;
    std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    output.flush().and_then(|_| output.as_file().sync_all()).map_err(|error| error.to_string())?;
    output.persist_noclobber(destination).map_err(|error| error.error.to_string())?;
    Ok(true)
  }).await.map_err(|error| error.to_string())?
}

/// Imported IDs never overwrite existing projects or tombstones.
#[tauri::command]
pub async fn total_recall_backup_import(app: tauri::AppHandle, root: State<'_, AppDataRoot>) -> Result<Option<serde_json::Value>, String> {
  let database = database_path(&root);
  tauri::async_runtime::spawn_blocking(move || {
    let Some(source) = app.dialog().file().add_filter("Total Recall backup", &["trbackup"]).blocking_pick_file() else { return Ok(None); };
    let source = source.into_path().map_err(|error| error.to_string())?;
    let mut store = ProjectStore::open(database).map_err(|error| error.to_string())?;
    let result = store.import_backup(source).map_err(|error| error.to_string())?;
    Ok(Some(serde_json::json!({"projects":result.projects,"revisions":result.revisions,"assets":result.assets})))
  }).await.map_err(|error| error.to_string())?
}
