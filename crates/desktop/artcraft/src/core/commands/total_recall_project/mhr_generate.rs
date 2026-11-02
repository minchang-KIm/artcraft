use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use super::worker_settings::configured;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

/// Run only the configured local worker; no executable or path comes from the UI.
#[tauri::command]
pub async fn total_recall_mhr_generate(app_data_root: State<'_, AppDataRoot>, identity: Vec<f64>) -> Result<serde_json::Value, String> {
  if identity.len() != 45 || identity.iter().any(|v| !v.is_finite() || !(-3.0..=3.0).contains(v)) {
    return Err("MHR identity must contain 45 finite values between -3 and 3".into());
  }
  let python = configured(&app_data_root, "TOTAL_RECALL_MHR_PYTHON")?;
  let worker = configured(&app_data_root, "TOTAL_RECALL_MHR_WORKER")?;
  let model = configured(&app_data_root, "TOTAL_RECALL_MHR_MODEL")?;
  let root = configured(&app_data_root, "TOTAL_RECALL_MHR_ROOT")?;
  let path = database_path(&app_data_root);
  let (bytes, provenance) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let identity_path = temp.path().join("identity.json");
    let output_path = temp.path().join("character.glb");
    let log_path = temp.path().join("worker.log");
    std::fs::write(&identity_path, serde_json::to_vec(&identity).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let mut child = Command::new(python).arg(worker).arg("--model").arg(model).arg("--mhr-root").arg(root)
      .arg("--identity").arg(identity_path).arg("--output").arg(&output_path)
      .stdout(Stdio::from(log)).stderr(Stdio::from(stderr)).spawn().map_err(|e| format!("MHR worker could not start: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(240);
    let status = loop {
      match child.try_wait() {
        Ok(Some(status)) => break status,
        Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
        Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("MHR worker timed out".into()); },
        Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
      }
    };
    let log = std::fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    if !status.success() {
      let tail: String = log.chars().rev().take(2000).collect::<String>().chars().rev().collect();
      return Err(format!("MHR worker failed: {tail}"));
    }
    let mut provenance = log.lines().rev().find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
      .ok_or_else(|| "MHR worker did not return provenance".to_string())?;
    if let Some(object) = provenance.as_object_mut() { object.remove("path"); }
    let size = std::fs::metadata(&output_path).map_err(|e| e.to_string())?.len();
    if size > 50 * 1024 * 1024 { return Err("MHR GLB exceeds 50 MiB".into()); }
    let bytes = std::fs::read(output_path).map_err(|e| e.to_string())?;
    Ok((bytes, provenance))
  }).await.map_err(|e| e.to_string())??;
  let id = with_store(path, move |store| store.put_glb(&bytes)).await?;
  Ok(serde_json::json!({ "assetId": id, "provenance": provenance }))
}
