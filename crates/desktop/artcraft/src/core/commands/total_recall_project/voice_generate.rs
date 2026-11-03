use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use super::worker_settings::configured;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

#[tauri::command]
pub async fn total_recall_voice_generate(app_data_root: State<'_, AppDataRoot>, text: String, voice: String, words_per_minute: u32) -> Result<serde_json::Value, String> {
  if text.trim().is_empty() || text.chars().count() > 5000 || text.contains('\0') || voice.is_empty() || voice.len() > 64 || !voice.bytes().all(|b| b.is_ascii_alphanumeric() || b"_+.-".contains(&b)) || !voice.as_bytes()[0].is_ascii_alphanumeric() || !(80..=450).contains(&words_per_minute) { return Err("Invalid local speech request".into()); }
  let python = configured(&app_data_root, "TOTAL_RECALL_VOICE_PYTHON")?;
  let worker = configured(&app_data_root, "TOTAL_RECALL_VOICE_WORKER")?;
  let executable = configured(&app_data_root, "TOTAL_RECALL_VOICE_ESPEAK")?;
  let path = database_path(&app_data_root);
  let (bytes, provenance) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let output = temp.path().join("speech.wav");
    let log_path = temp.path().join("worker.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let mut child = Command::new(python).arg(worker).arg("--executable").arg(executable).arg("--output").arg(&output).stdin(Stdio::piped()).stdout(Stdio::from(log)).stderr(Stdio::from(stderr)).spawn().map_err(|e| format!("Voice worker could not start: {e}"))?;
    let request = serde_json::json!({"text":text,"voice":voice,"wordsPerMinute":words_per_minute});
    if let Err(error) = child.stdin.take().ok_or("Voice worker stdin unavailable")?.write_all(request.to_string().as_bytes()) { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
    let deadline = Instant::now() + Duration::from_secs(140);
    let status = loop { match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
      Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("Voice worker timed out".into()); },
      Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
    }};
    let log = std::fs::read_to_string(log_path).map_err(|e| e.to_string())?;
    if !status.success() { return Err(format!("Voice worker failed: {}", log.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>())); }
    let provenance = log.lines().rev().find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok()).ok_or("Voice worker did not return provenance")?;
    if std::fs::metadata(&output).map_err(|e| e.to_string())?.len() > 50 * 1024 * 1024 { return Err("Speech WAV exceeds 50 MiB".into()); }
    Ok((std::fs::read(output).map_err(|e| e.to_string())?, provenance))
  }).await.map_err(|e| e.to_string())??;
  let id = with_store(path, move |store| store.put_media(&bytes, "audio/wav")).await?;
  Ok(serde_json::json!({"assetId":id,"provenance":provenance}))
}
