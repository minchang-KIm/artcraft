pub mod voice_generate;
pub mod asset_get;
pub mod asset_put;
pub mod backup;
pub mod create;
pub mod delete;
pub mod exists;
pub mod export_glb;
pub mod export_snapshot;
pub mod list;
pub mod load;
pub mod mhr_generate;
pub mod prepare_webtoon;
pub mod recovery;
pub mod media;
pub mod restore;
pub mod render_video;
pub mod scene_sequence;
pub mod worker_settings;
pub mod save;

use crate::core::state::data_dir::app_data_root::AppDataRoot;
use crate::core::state::data_dir::trait_data_subdir::DataSubdir;
use std::path::PathBuf;
use total_recall_project_store::{ProjectStore, StoreError};

pub fn database_path(root: &AppDataRoot) -> PathBuf {
  root.state_dir().path().join("total_recall_projects.sqlite")
}

pub async fn with_store<T, F>(path: PathBuf, operation: F) -> Result<T, String>
where
  T: Send + 'static,
  F: FnOnce(&mut ProjectStore) -> Result<T, StoreError> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(move || {
    let mut store = ProjectStore::open(path)?;
    operation(&mut store)
  })
  .await
  .map_err(|error| error.to_string())?
  .map_err(|error| error.to_string())
}
