use std::path::PathBuf;

/// Returns the fixed default data directory for application saves:
/// `%LOCALAPPDATA%\StarCraftAshfallClient` on Windows.
pub fn default_data_dir() -> Result<PathBuf, std::io::Error> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(windows)]
            {
                std::env::var_os("USERPROFILE")
                    .map(|u| PathBuf::from(u).join("AppData").join("Local"))
            }
            #[cfg(not(windows))]
            {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .or_else(|| {
                        std::env::var_os("HOME")
                            .map(|h| PathBuf::from(h).join(".local").join("share"))
                    })
            }
        })
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "failed to determine LocalAppData directory",
            )
        })?;

    Ok(base.join("StarCraftAshfallClient"))
}
