use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_asset_get(app_data_root: State<'_, AppDataRoot>, id: String) -> Result<Vec<u8>, String> {
  with_store(database_path(&app_data_root), move |store| store.get_glb(&id)).await
}
