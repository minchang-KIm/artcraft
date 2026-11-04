use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use super::worker_settings::configured;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

#[tauri::command]
pub async fn total_recall_rig_generate(app_data_root: State<'_, AppDataRoot>, input_id: String, beams: u32) -> Result<serde_json::Value, String> {
  if !(1..=10).contains(&beams) { return Err("Rigging beams must be between 1 and 10".into()); }
  let python = configured(&app_data_root, "TOTAL_RECALL_RIG_PYTHON")?;
  let worker = configured(&app_data_root, "TOTAL_RECALL_RIG_WORKER")?;
  let workspace = configured(&app_data_root, "TOTAL_RECALL_RIG_WORKSPACE")?;
  let path = database_path(&app_data_root);
  let source_id = input_id.clone();
  let input = with_store(path.clone(), move |store| store.get_glb(&source_id)).await?;
  let (bytes, provenance) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join("input.glb");
    let output_path = temp.path().join("rigged.glb");
    let log_path = temp.path().join("worker.log");
    std::fs::write(&input_path, input).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let mut child = Command::new(python).arg(worker).arg("--workspace").arg(workspace).arg("--input").arg(input_path).arg("--output").arg(&output_path).arg("--beams").arg(beams.to_string()).stdout(Stdio::from(log)).stderr(Stdio::from(stderr)).spawn().map_err(|e| format!("Rigging worker could not start: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(630);
    let status = loop { match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
      Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("Rigging worker timed out".into()); },
      Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
    }};
    if std::fs::metadata(&log_path).map_err(|e| e.to_string())?.len() > 10 * 1024 * 1024 { return Err("Rigging worker log is too large".into()); }
    let log = std::fs::read_to_string(log_path).map_err(|e| e.to_string())?;
    if !status.success() { return Err(format!("Rigging worker failed: {}", log.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>())); }
    let provenance: serde_json::Value = log.lines().rev().find_map(|line| serde_json::from_str(line).ok()).ok_or("Rigging worker did not return provenance")?;
    if provenance["schemaVersion"] != 1 || provenance["providerId"] != "skintokens" || provenance["numBeams"] != beams || provenance["inputSha256"].as_str() != input_id.strip_prefix("local-glb:") { return Err("Rigging worker returned invalid provenance".into()); }
    if std::fs::metadata(&output_path).map_err(|e| e.to_string())?.len() > 50 * 1024 * 1024 { return Err("Rigged GLB exceeds 50 MiB".into()); }
    Ok((std::fs::read(output_path).map_err(|e| e.to_string())?, provenance))
  }).await.map_err(|e| e.to_string())??;
  let id = with_store(path, move |store| store.put_glb(&bytes)).await?;
  if provenance["outputSha256"].as_str() != id.strip_prefix("local-glb:") { return Err("Rigging output hash does not match provenance".into()); }
  Ok(serde_json::json!({"assetId":id,"provenance":provenance}))
}
