use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_project_load(app_data_root: State<'_, AppDataRoot>, id: String) -> Result<Option<serde_json::Value>, String> {
  with_store(database_path(&app_data_root), move |store| match store.load(&id) {
    Ok(value) => Ok(Some(value)),
    Err(total_recall_project_store::StoreError::NotFound) => Ok(None),
    Err(error) => Err(error),
  })
  .await
}
