pub fn authorized_source(label: &str, url: &str, origin: &str) -> bool {
    label == "main"
        && tauri::Url::parse(url)
            .map(|url| url.origin().ascii_serialization() == origin)
            .unwrap_or(false)
}
