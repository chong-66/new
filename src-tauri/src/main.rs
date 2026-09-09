// 打包为 Windows GUI 程序（不弹控制台）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    strip_dwm_frame(&window);
                    // Win11 在窗口移动/缩放/聚焦后可能重新绘制原生边框，持续兜底
                    let w = window.clone();
                    window.on_window_event(move |event| {
                        match event {
                            tauri::WindowEvent::Resized(_)
                            | tauri::WindowEvent::Moved(_)
                            | tauri::WindowEvent::Focused(_)
                            | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                                strip_dwm_frame(&w);
                            }
                            _ => {}
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 去掉 Windows 11 给无边框透明窗口强制绘制的 1px 原生边框与圆角。
/// 边框/圆角由网页层 CSS 自己控制；窗口完全透明后，DWM 这层描边会暴露出来。
#[cfg(target_os = "windows")]
fn strip_dwm_frame(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd: HWND = hwnd.0 as HWND;
    unsafe {
        let corner: u32 = DWMWCP_DONOTROUND as u32;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &corner as *const u32 as *const core::ffi::c_void,
            size_of_val(&corner) as u32,
        );
        let border: u32 = DWMWA_COLOR_NONE as u32;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            &border as *const u32 as *const core::ffi::c_void,
            size_of_val(&border) as u32,
        );
    }
}
