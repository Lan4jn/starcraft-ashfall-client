#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    {
        if let Err(err) = ashfall_desktop::app::run() {
            ashfall_desktop::native::show_error("星际争霸：余烬 - 启动错误", &err);
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("星际争霸：余烬 客户端仅支持 Windows 平台");
        std::process::exit(1);
    }
}
