use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_project_save(app_data_root: State<'_, AppDataRoot>, id: String, expected_revision: i64, document: serde_json::Value) -> Result<serde_json::Value, String> {
  with_store(database_path(&app_data_root), move |store| store.save(&id, expected_revision, document)).await
}
