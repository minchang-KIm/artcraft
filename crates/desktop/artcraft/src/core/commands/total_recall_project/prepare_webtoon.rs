use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;
use tauri::State;
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use super::worker_settings::configured;

const MAX_IMPORT_BYTES: u64 = 150 * 1024 * 1024;

fn prepare(python: &Path, worker: &Path, source: &Path) -> Result<String, String> {
  let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
  let output = directory.path().join("prepared.json");
  let log_path = directory.path().join("worker.log");
  let log = std::fs::File::create(&log_path).map_err(|error| error.to_string())?;
  let stderr = log.try_clone().map_err(|error| error.to_string())?;
  let mut child = Command::new(python).arg(worker).arg(source).arg(&output)
    .stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(stderr))
    .spawn().map_err(|error| format!("Webtoon import worker could not start: {error}"))?;
  let deadline = Instant::now() + Duration::from_secs(240);
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
      Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("Webtoon import worker timed out".into()); },
      Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
    }
  };
  if !status.success() {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(log_path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(4000))).map_err(|error| error.to_string())?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).map_err(|error| error.to_string())?;
    return Err(format!("Webtoon import worker failed: {}", String::from_utf8_lossy(&tail)));
  }
  let size = std::fs::metadata(&output).map_err(|error| format!("Webtoon import output missing: {error}"))?.len();
  if size > MAX_IMPORT_BYTES { return Err("Webtoon import exceeds 150 MiB".into()); }
  let content = std::fs::read_to_string(output).map_err(|error| error.to_string())?;
  let document: serde_json::Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
  if document.get("format").and_then(|value| value.as_str()) != Some("total-recall-webtoon-import") || document.get("version").and_then(|value| value.as_u64()) != Some(1) {
    return Err("Invalid webtoon import output".into());
  }
  Ok(content)
}

/// The source path comes only from the native file picker, never from the WebView.
#[tauri::command]
pub async fn total_recall_prepare_webtoon(app: tauri::AppHandle, root: State<'_, AppDataRoot>) -> Result<Option<String>, String> {
  let python = configured(&root, "TOTAL_RECALL_IMPORT_PYTHON")?;
  let worker = configured(&root, "TOTAL_RECALL_IMPORT_WORKER")?;
  tauri::async_runtime::spawn_blocking(move || {
    let Some(source) = app.dialog().file().add_filter("Webtoon project", &["json", "wap", "wacx"]).blocking_pick_file() else { return Ok(None); };
    let source = source.into_path().map_err(|error| error.to_string())?;
    prepare(&python, &worker, &source).map(Some)
  }).await.map_err(|error| error.to_string())?
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  #[test]
  fn configured_python_worker_prepares_a_project() {
    let (Ok(python), Ok(worker)) = (std::env::var("TOTAL_RECALL_TEST_IMPORT_PYTHON"), std::env::var("TOTAL_RECALL_TEST_IMPORT_WORKER")) else { return; };
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("project.json");
    std::fs::write(dir.path().join("page.png"), &[137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 10, 73, 68, 65, 84, 8, 29, 99, 0, 2, 0, 0, 4, 0, 1, 13, 59, 164, 185, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]).unwrap();
    std::fs::write(&source, r#"{"scenes":[{"id":"cut","image_path":"page.png","start_time":0,"duration":1}]}"#).unwrap();
    let output = prepare(Path::new(&python), Path::new(&worker), &source).unwrap();
    let result: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(result["scenes"][0]["id"], "cut");
    assert_eq!(result["scenes"][0]["width"], 1);
  }

  #[test]
  fn worker_output_is_validated_and_source_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wap");
    let worker = dir.path().join("worker.sh");
    std::fs::write(&source, "original").unwrap();
    std::fs::write(&worker, "printf '%s' '{\"format\":\"total-recall-webtoon-import\",\"version\":1}' > \"$2\"\n").unwrap();
    assert!(prepare(Path::new("/bin/sh"), &worker, &source).unwrap().contains("total-recall-webtoon-import"));
    assert_eq!(std::fs::read_to_string(&source).unwrap(), "original");
    std::fs::write(&worker, "printf '%s' '{}' > \"$2\"\n").unwrap();
    assert!(prepare(Path::new("/bin/sh"), &worker, &source).unwrap_err().contains("Invalid webtoon import output"));
    std::fs::write(&worker, "echo failed >&2; exit 1\n").unwrap();
    assert!(prepare(Path::new("/bin/sh"), &worker, &source).unwrap_err().contains("failed"));
  }
}
