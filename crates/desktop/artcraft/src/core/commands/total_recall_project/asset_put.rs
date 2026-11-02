use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_asset_put(app_data_root: State<'_, AppDataRoot>, content: Vec<u8>) -> Result<String, String> {
  with_store(database_path(&app_data_root), move |store| store.put_glb(&content)).await
}
