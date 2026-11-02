use crate::core::commands::total_recall_project::{database_path, with_store};
use crate::core::state::data_dir::app_data_root::AppDataRoot;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::State;

struct Sequence { dir: tempfile::TempDir, fps: u32, count: u32, width: u32, height: u32, bytes: u64, created: Instant }
struct Entry { sequence: Option<Sequence>, cancelled: Arc<AtomicBool>, running: bool }
static SEQUENCES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
fn sequences() -> &'static Mutex<HashMap<String, Entry>> { SEQUENCES.get_or_init(|| Mutex::new(HashMap::new())) }

struct ActiveSequence { id: String, cancelled: Arc<AtomicBool> }
impl Drop for ActiveSequence {
  fn drop(&mut self) {
    self.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut jobs) = sequences().lock() {
      if jobs.get(&self.id).is_some_and(|entry| Arc::ptr_eq(&entry.cancelled, &self.cancelled)) { jobs.remove(&self.id); }
    }
  }
}

#[tauri::command]
pub fn total_recall_scene_sequence_begin(job_id: String, fps: u32) -> Result<(), String> {
  if job_id.len() != 36 || !job_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') || !(1..=30).contains(&fps) { return Err("Invalid sequence job or FPS".into()); }
  let mut jobs = sequences().lock().map_err(|_| "Sequence registry unavailable")?;
  jobs.retain(|_, entry| entry.running || entry.sequence.as_ref().is_some_and(|job| job.created.elapsed() < Duration::from_secs(1800)));
  if jobs.len() >= 4 || jobs.contains_key(&job_id) { return Err("Sequence registry full or job already exists".into()); }
  jobs.insert(job_id, Entry { sequence: Some(Sequence { dir: tempfile::Builder::new().prefix("total-recall-sequence-").tempdir().map_err(|e| e.to_string())?, fps, count: 0, width: 0, height: 0, bytes: 0, created: Instant::now() }), cancelled: Arc::new(AtomicBool::new(false)), running: false });
  Ok(())
}

#[tauri::command]
pub async fn total_recall_scene_sequence_append(job_id: String, content: Vec<u8>) -> Result<u32, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if content.len() < 24 || content.len() > 10 * 1024 * 1024 || &content[..8] != b"\x89PNG\r\n\x1a\n" || &content[12..16] != b"IHDR" { return Err("Invalid PNG frame".into()); }
    let width = u32::from_be_bytes(content[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(content[20..24].try_into().unwrap());
    if width < 2 || height < 2 || width > 1536 || height > 1536 || width % 2 != 0 || height % 2 != 0 { return Err("Unsupported frame dimensions".into()); }
    let mut jobs = sequences().lock().map_err(|_| "Sequence registry unavailable")?;
    let entry = jobs.get_mut(&job_id).ok_or("Sequence not found")?;
    if entry.cancelled.load(Ordering::SeqCst) { return Err("3D sequence cancelled".into()); }
    let job = entry.sequence.as_mut().ok_or("Sequence is encoding")?;
    if job.count >= 1800 || job.bytes + content.len() as u64 > 2 * 1024 * 1024 * 1024 { return Err("Sequence exceeds capture limits".into()); }
    if job.count > 0 && (job.width != width || job.height != height) { return Err("Frame dimensions changed".into()); }
    std::fs::write(job.dir.path().join(format!("frame-{:06}.png", job.count)), &content).map_err(|e| e.to_string())?;
    job.count += 1; job.width = width; job.height = height; job.bytes += content.len() as u64;
    Ok(job.count)
  }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn total_recall_scene_sequence_abort(job_id: String) -> Result<(), String> {
  let mut jobs = sequences().lock().map_err(|_| "Sequence registry unavailable")?;
  if let Some(entry) = jobs.get(&job_id) {
    entry.cancelled.store(true, Ordering::SeqCst);
    if !entry.running { jobs.remove(&job_id); }
  }
  Ok(())
}

#[tauri::command]
pub async fn total_recall_scene_sequence_finish(app_data_root: State<'_, AppDataRoot>, job_id: String) -> Result<serde_json::Value, String> {
  let ffmpeg = std::env::var_os("TOTAL_RECALL_RENDER_FFMPEG").filter(|v| !v.is_empty()).map(PathBuf::from).ok_or("Local render is not configured: TOTAL_RECALL_RENDER_FFMPEG is missing")?;
  let (job, cancelled) = {
    let mut jobs = sequences().lock().map_err(|_| "Sequence registry unavailable")?;
    let entry = jobs.get_mut(&job_id).ok_or("Sequence not found")?;
    if entry.cancelled.load(Ordering::SeqCst) { return Err("3D sequence cancelled".into()); }
    let job = entry.sequence.take().ok_or("Sequence is encoding")?;
    entry.running = true;
    (job, Arc::clone(&entry.cancelled))
  };
  let active = ActiveSequence { id: job_id, cancelled: Arc::clone(&cancelled) };
  if job.count == 0 { return Err("Sequence is empty".into()); }
  let path = database_path(&app_data_root);
  let encode_cancelled = Arc::clone(&cancelled);
  let (bytes, width, height, duration) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
    if encode_cancelled.load(Ordering::SeqCst) { return Err("3D sequence cancelled".into()); }
    let output = job.dir.path().join("scene.mp4");
    let log_path = job.dir.path().join("ffmpeg.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = Command::new(ffmpeg).args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate"]).arg(job.fps.to_string()).arg("-i").arg(job.dir.path().join("frame-%06d.png"))
      .args(["-frames:v", &job.count.to_string(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]).arg(&output)
      .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::from(log)).spawn().map_err(|e| format!("FFmpeg could not start: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(180);
    let status = loop {
      if encode_cancelled.load(Ordering::SeqCst) { let _ = child.kill(); let _ = child.wait(); return Err("3D sequence cancelled".into()); }
      match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
      Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("3D sequence encoding timed out".into()); },
      Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
    }};
    if encode_cancelled.load(Ordering::SeqCst) { return Err("3D sequence cancelled".into()); }
    if !status.success() { let log = std::fs::read_to_string(log_path).unwrap_or_default(); let tail: String = log.chars().rev().take(2000).collect::<String>().chars().rev().collect(); return Err(format!("3D sequence encoding failed: {tail}")); }
    let size = std::fs::metadata(&output).map_err(|e| e.to_string())?.len();
    if !(12..=50 * 1024 * 1024).contains(&size) { return Err("Invalid encoded 3D sequence size".into()); }
    let bytes = std::fs::read(output).map_err(|e| e.to_string())?;
    if &bytes[4..8] != b"ftyp" { return Err("Encoded sequence is not MP4".into()); }
    Ok((bytes, job.width, job.height, job.count as f64 / job.fps as f64))
  }).await.map_err(|e| e.to_string())??;
  if cancelled.load(Ordering::SeqCst) { return Err("3D sequence cancelled".into()); }
  let save_cancelled = Arc::clone(&cancelled);
  let id = with_store(path, move |store| {
    if save_cancelled.load(Ordering::SeqCst) { return Err(total_recall_project_store::StoreError::InvalidDocument("3D sequence cancelled")); }
    store.put_media(&bytes, "video/mp4")
  }).await?;
  if cancelled.load(Ordering::SeqCst) { return Err("3D sequence cancelled".into()); }
  drop(active);
  Ok(serde_json::json!({ "mediaId": id, "width": width, "height": height, "duration": duration }))
}
