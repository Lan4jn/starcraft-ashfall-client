pub mod app;
pub mod commands;
pub mod initialization;
pub mod instance;
pub mod lifecycle;
pub mod native;

pub fn capability_json(origin: &str) -> serde_json::Value {
    serde_json::json!({
        "identifier": "game-runtime",
        "windows": ["main"],
        "local": false,
        "remote": { "urls": [format!("{origin}/*")] },
        "permissions": [
            "allow-save-snapshot", "allow-flush-failed", "allow-close-ready", "allow-close-failed",
            "allow-toggle-fullscreen"
        ]
    })
}
