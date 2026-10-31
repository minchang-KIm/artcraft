use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_project_list(app_data_root: State<'_, AppDataRoot>) -> Result<Vec<serde_json::Value>, String> {
  with_store(database_path(&app_data_root), move |store| store.list()).await
}
