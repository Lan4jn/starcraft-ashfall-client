fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "save_snapshot",
            "flush_failed",
            "close_ready",
            "close_failed",
            "toggle_fullscreen",
        ]),
    ))
    .expect("Tauri permission build failed");
}
