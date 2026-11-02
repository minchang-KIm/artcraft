use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

struct RenderJob { cancelled: AtomicBool, started: AtomicBool, progress: AtomicU32, created: Instant }
static JOBS: OnceLock<Mutex<HashMap<String, Arc<RenderJob>>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, Arc<RenderJob>>> { JOBS.get_or_init(|| Mutex::new(HashMap::new())) }

#[tauri::command]
pub fn total_recall_render_begin(job_id: String) -> Result<(), String> {
  if job_id.len() != 36 || !job_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') { return Err("Invalid render job ID".into()); }
  let mut entries = jobs().lock().map_err(|_| "Render job registry unavailable")?;
  entries.retain(|_, job| job.started.load(Ordering::SeqCst) || (!job.cancelled.load(Ordering::SeqCst) && job.created.elapsed() < Duration::from_secs(1800)));
  if entries.len() >= 16 || entries.contains_key(&job_id) { return Err("Render job already exists or registry is full".into()); }
  entries.insert(job_id, Arc::new(RenderJob { cancelled: AtomicBool::new(false), started: AtomicBool::new(false), progress: AtomicU32::new(0), created: Instant::now() }));
  Ok(())
}

#[tauri::command]
pub fn total_recall_render_cancel(job_id: String) -> Result<bool, String> {
  let entries = jobs().lock().map_err(|_| "Render job registry unavailable")?;
  if let Some(job) = entries.get(&job_id) { job.cancelled.store(true, Ordering::SeqCst); return Ok(true); }
  Ok(false)
}

/// Percent of the output timeline encoded so far, capped until completion.
#[tauri::command]
pub fn total_recall_render_progress(job_id: String) -> Result<Option<u32>, String> {
  let entries = jobs().lock().map_err(|_| "Render job registry unavailable")?;
  Ok(entries.get(&job_id).map(|job| job.progress.load(Ordering::Relaxed)))
}

#[tauri::command]
pub fn total_recall_render_finish(job_id: String) -> Result<(), String> {
  let mut entries = jobs().lock().map_err(|_| "Render job registry unavailable")?;
  if entries.get(&job_id).is_some_and(|job| job.started.load(Ordering::SeqCst)) { return Err("Render job is still active".into()); }
  entries.remove(&job_id);
  Ok(())
}

struct ActiveJob { id: Option<String>, job: Option<Arc<RenderJob>> }
impl Drop for ActiveJob {
  fn drop(&mut self) {
    if let Some(job) = &self.job {
      job.started.store(false, Ordering::SeqCst);
      if let (Some(id), Ok(mut entries)) = (&self.id, jobs().lock()) {
        if entries.get(id).is_some_and(|entry| Arc::ptr_eq(entry, job)) { entries.remove(id); }
      }
    }
  }
}

fn configured(key: &str) -> Result<PathBuf, String> {
  std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
    .ok_or_else(|| format!("Local render is not configured: {key} is missing"))
}

/// Execute the configured local renderer only; paths never originate in IPC.
#[tauri::command]
pub async fn total_recall_render_video(content: String, job_id: Option<String>) -> Result<Vec<u8>, String> {
  if content.len() > 150 * 1024 * 1024 { return Err("Render snapshot exceeds 150 MiB".into()); }
  let snapshot: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
  if snapshot.get("format").and_then(|v| v.as_str()) != Some("total-recall-webtoon-import") || snapshot.get("version").and_then(|v| v.as_u64()) != Some(1) {
    return Err("Invalid render snapshot".into());
  }
  let mut duration: f64 = 0.0;
  for section in ["scenes", "audio"] {
    if let Some(items) = snapshot.get(section).and_then(|v| v.as_array()) {
      for item in items {
        let start = item.get("start").and_then(|v| v.as_f64()).ok_or("Invalid timeline time")?;
        let length = item.get("duration").and_then(|v| v.as_f64()).ok_or("Invalid timeline duration")?;
        if !start.is_finite() || !length.is_finite() || start < 0.0 || length <= 0.0 || start + length > 86400.0 { return Err("Invalid timeline timing".into()); }
        duration = duration.max(start + length);
      }
    }
  }
  if duration <= 0.0 { return Err("The render timeline is empty".into()); }
  let python = configured("TOTAL_RECALL_RENDER_PYTHON")?;
  let worker = configured("TOTAL_RECALL_RENDER_WORKER")?;
  let ffmpeg = configured("TOTAL_RECALL_RENDER_FFMPEG")?;
  let job = if let Some(id) = job_id.as_ref() {
    let entries = jobs().lock().map_err(|_| "Render job registry unavailable")?;
    let job = entries.get(id).cloned().ok_or_else(|| "Render job does not exist".to_string())?;
    if job.started.swap(true, Ordering::SeqCst) { return Err("Render job is already running".into()); }
    Some(job)
  } else { None };
  tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
    let active = ActiveJob { id: job_id, job };
    if active.job.as_ref().is_some_and(|job| job.cancelled.load(Ordering::SeqCst)) { return Err("Local render cancelled".into()); }
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = dir.path().join("timeline.json");
    let output = dir.path().join("output.mp4");
    let log_path = dir.path().join("render.log");
    let cancel_path = dir.path().join("cancel");
    let progress_path = dir.path().join("progress");
    std::fs::write(&input, content).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let mut child = Command::new(python).arg(worker).arg(&input).arg(&output).arg("--ffmpeg").arg(ffmpeg).arg("--cancel-file").arg(&cancel_path).arg("--progress-file").arg(&progress_path)
      .stdout(Stdio::from(log)).stderr(Stdio::from(stderr)).spawn().map_err(|e| format!("Local render could not start: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut cancel_sent: Option<Instant> = None;
    let status = loop {
      if let Some(job) = &active.job {
        if std::fs::metadata(&progress_path).is_ok_and(|metadata| metadata.len() <= 1024 * 1024) {
          if let Ok(progress) = std::fs::read_to_string(&progress_path) {
            if let Some(micros) = progress.lines().rev().find_map(|line| line.strip_prefix("out_time_us=").and_then(|value| value.parse::<u64>().ok())) {
              let percent = ((micros as f64 / 1_000_000.0 / duration * 100.0).floor() as u32).min(99);
              job.progress.fetch_max(percent, Ordering::Relaxed);
            }
          }
        }
      }
      if active.job.as_ref().is_some_and(|job| job.cancelled.load(Ordering::SeqCst)) && cancel_sent.is_none() {
        if let Err(error) = std::fs::write(&cancel_path, b"cancel") { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
        cancel_sent = Some(Instant::now());
      }
      if cancel_sent.is_some_and(|sent| sent.elapsed() > Duration::from_secs(5)) { let _ = child.kill(); let _ = child.wait(); return Err("Local render cancelled".into()); }
      match child.try_wait() {
        Ok(Some(status)) => break status,
        Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
        Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("Local render timed out".into()); },
        Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
      }
    };
    if active.job.as_ref().is_some_and(|job| job.cancelled.load(Ordering::SeqCst)) { return Err("Local render cancelled".into()); }
    if !status.success() {
      let log = std::fs::read_to_string(log_path).unwrap_or_default();
      let tail: String = log.chars().rev().take(2000).collect::<String>().chars().rev().collect();
      return Err(format!("Local render failed: {tail}"));
    }
    let size = std::fs::metadata(&output).map_err(|e| e.to_string())?.len();
    if !(12..=256 * 1024 * 1024).contains(&size) { return Err("Rendered video has invalid size".into()); }
    let bytes = std::fs::read(output).map_err(|e| e.to_string())?;
    if &bytes[4..8] != b"ftyp" { return Err("Rendered output is not an MP4".into()); }
    Ok(bytes)
  }).await.map_err(|e| e.to_string())?
}

/// Destination is chosen exclusively in the native dialog.
#[tauri::command]
pub async fn total_recall_save_video(app: tauri::AppHandle, content: Vec<u8>) -> Result<bool, String> {
  if content.len() < 12 || content.len() > 256 * 1024 * 1024 || &content[4..8] != b"ftyp" { return Err("Invalid MP4".into()); }
  tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
    let Some(destination) = app.dialog().file().add_filter("MP4", &["mp4"]).set_file_name("webtoon.mp4").blocking_save_file() else { return Ok(false); };
    let destination = destination.into_path().map_err(|e| e.to_string())?;
    if !destination.extension().and_then(|x| x.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("mp4")) { return Err("Choose an .mp4 file name.".into()); }
    let directory = destination.parent().ok_or_else(|| "Invalid destination".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temp.write_all(&content).and_then(|_| temp.as_file().sync_all()).map_err(|e| e.to_string())?;
    temp.persist_noclobber(&destination).map_err(|e| e.error.to_string())?;
    Ok(true)
  }).await.map_err(|e| e.to_string())?
}
