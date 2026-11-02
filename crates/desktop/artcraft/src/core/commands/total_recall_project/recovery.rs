use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_recovery_projects(root: State<'_, AppDataRoot>) -> Result<Vec<serde_json::Value>, String> {
  with_store(database_path(&root), |store| store.recoverable_projects()).await
}

#[tauri::command]
pub async fn total_recall_project_history(root: State<'_, AppDataRoot>, id: String, before: Option<i64>, limit: u32) -> Result<Vec<serde_json::Value>, String> {
  with_store(database_path(&root), move |store| store.history(&id, before, limit)).await
}

#[tauri::command]
pub async fn total_recall_project_revision(root: State<'_, AppDataRoot>, id: String, revision: i64) -> Result<serde_json::Value, String> {
  with_store(database_path(&root), move |store| store.recovery_revision(&id, revision)).await
}
