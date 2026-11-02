use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use tauri::State;

#[tauri::command]
pub async fn total_recall_media_put(app_data_root: State<'_, AppDataRoot>, content: Vec<u8>, mime: String) -> Result<String, String> {
  with_store(database_path(&app_data_root), move |store| store.put_media(&content, &mime)).await
}

#[tauri::command]
pub async fn total_recall_media_get(app_data_root: State<'_, AppDataRoot>, id: String) -> Result<(String, Vec<u8>), String> {
  with_store(database_path(&app_data_root), move |store| store.get_media(&id)).await
}
