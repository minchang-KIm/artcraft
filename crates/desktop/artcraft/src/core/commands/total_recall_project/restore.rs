use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_project_restore(app_data_root: State<'_, AppDataRoot>, id: String, expected_revision: i64, target_revision: i64) -> Result<serde_json::Value, String> {
  with_store(database_path(&app_data_root), move |store| store.restore(&id, expected_revision, target_revision)).await
}
