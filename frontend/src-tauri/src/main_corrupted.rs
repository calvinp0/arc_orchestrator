use serde::Serialize;
use std::process::Command as PCommand;
use which::which;
use tauri::Manager; // <-- needed for get_webview_window

#[derive(Serialize)]
struct TmuxWindow {
    index: u32,
    name: String,
    active: bool,
    panes: u32,
}

#[derive(Serialize)]
struct TmuxSession {
    name: String,
    windows: u32,
    attached: bool,
}

#[tauri::command]
fn tmux_list_sessions() -> Result<Vec<TmuxSession>, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    // use tabs in the format string so names with spaces are safe
    let out = PCommand::new(&path)
        .args(["list-sessions", "-F", "#S\t#{session_windows}\t#{?session_attached,1,0}"])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if msg.contains("no server running")
            || msg.contains("failed to connect to server")
            || msg.contains("no sessions")
        {
            return Ok(vec![]);
        }
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let sessions = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let mut it = line.split('\t');
            let name = it.next().unwrap_or("").to_string();
            let windows = it.next().unwrap_or("0").parse().unwrap_or(0);
            let attached = it.next().unwrap_or("0") == "1";
            TmuxSession { name, windows, attached }
        })
        .collect();
    Ok(sessions)
}

#[tauri::command]
fn tmux_start_server() -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["start-server"])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_kill_session(session: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["kill-session", "-t", &session])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_new_session(session: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["new-session", "-d", "-s", &session])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_list_windows(session: String) -> Result<Vec<TmuxWindow>, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["list-windows", "-t", &session, "-F", "#{window_index}\t#{window_name}\t#{?window_active,1,0}\t#{window_panes}"])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let windows = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let mut it = line.split('\t');
            let index: u32 = it.next().unwrap_or("0").parse().unwrap_or(0);
            let name = it.next().unwrap_or("").to_string();
            let active = it.next().unwrap_or("0") == "1";
            let panes: u32 = it.next().unwrap_or("1").parse().unwrap_or(1);
            TmuxWindow { index, name, active, panes }
        })
        .collect();
    Ok(windows)
}

#[tauri::command]
fn tmux_new_window(session: String, window_name: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["new-window", "-t", &session, "-n", &window_name])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_capture_pane(session: String, window: String) -> Result<String, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["capture-pane", "-t", &format!("{}:{}", session, window), "-p"])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn tmux_send_keys(session: String, window: String, keys: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["send-keys", "-t", &format!("{}:{}", session, window), &keys, "Enter"])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_rename_window(session: String, window: String, new_name: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["rename-window", "-t", &format!("{}:{}", session, window), &new_name])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_kill_window(session: String, window: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args(["kill-window", "-t", &format!("{}:{}", session, window)])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn validate_python_executable(path: String) -> Result<String, String> {
    use std::path::Path;
    
    // Check if the file exists and is executable
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    
    // Try to run python --version
    let output = PCommand::new(&path)
        .args(["--version"])
        .output()
        .map_err(|e| format!("Failed to execute: {}", e))?;
    
    if !output.status.success() {
        return Err("Not a valid Python executable".to_string());
    }
    
    // Parse version from stdout or stderr (Python 2 outputs to stderr, Python 3 to stdout)
    let version_output = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        String::from_utf8_lossy(&output.stderr)
    };
    
    let version_line = version_output.lines().next().unwrap_or("").trim();
    
    if version_line.starts_with("Python ") {
        Ok(version_line.to_string())
    } else {
        Err("Invalid Python version output".to_string())
    }
}

#[tauri::command]
fn validate_python_executable(path: String) -> Result<String, String> {
    use std::path::Path;
    
    // Check if the file exists and is executable
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    
    // Try to run python --version
    let output = PCommand::new(&path)
        .args(["--version"])
        .output()
        .map_err(|e| format!("Failed to execute: {}", e))?;
    
    if !output.status.success() {
        return Err("Not a valid Python executable".to_string());
    }
    
    // Parse version from stdout or stderr (Python 2 outputs to stderr, Python 3 to stdout)
    let version_output = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        String::from_utf8_lossy(&output.stderr)
    };
    
    let version_line = version_output.lines().next().unwrap_or("").trim();
    
    if version_line.starts_with("Python ") {
        Ok(version_line.to_string())
    } else {
        Err("Invalid Python version output".to_string())
    }
}x: u32,
    name: String,
    active: bool,
    panes: u32,
}

#[derive(Serialize)]
struct TmuxSession {
    name: String,
    windows: u32,
    attached: bool,
}

#[tauri::command]
fn tmux_list_sessions() -> Result<Vec<TmuxSession>, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    // use tabs in the format string so names with spaces are safe
    let out = PCommand::new(&path)
        .args(["list-sessions", "-F", "#S\t#{session_windows}\t#{?session_attached,1,0}"])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if msg.contains("no server running")
            || msg.contains("failed to connect to server")
            || msg.contains("no sessions")
        {
            return Ok(vec![]);
        }
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let sessions = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let mut it = line.split('\t');
            let name = it.next().unwrap_or("").to_string();
            let windows = it.next().unwrap_or("0").parse().unwrap_or(0);
            let attached = it.next().unwrap_or("0") == "1";
            TmuxSession { name, windows, attached }
        })
        .collect();

    Ok(sessions)
}

#[tauri::command]
fn tmux_start_server() -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path).arg("start-server").output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if msg.contains("server already running") {
            return Ok(()); // tolerate
        }
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_list_windows(session: String) -> Result<Vec<TmuxWindow>, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    // tab-delimited for robustness
    let out = PCommand::new(&path)
        .args([
            "list-windows", "-t", &session, "-F",
            "#{window_index}\t#{window_name}\t#{?window_active,1,0}\t#{window_panes}",
        ])
        .output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut windows = Vec::new();
    for line in stdout.lines().filter(|l| !l.is_empty()) {
        let mut it = line.split('\t');
        let index  = it.next().unwrap_or("0").parse().unwrap_or(0);
        let name   = it.next().unwrap_or("").to_string();
        let active = it.next().unwrap_or("0") == "1";
        let panes  = it.next().unwrap_or("1").parse().unwrap_or(1);
        windows.push(TmuxWindow { index, name, active, panes });
    }
    Ok(windows)
}

#[tauri::command]
fn tmux_capture_pane(session: String, window_index: u32, lines: Option<u32>) -> Result<String, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let last = lines.unwrap_or(500).to_string();
    let target = format!("{}:{}", session, window_index);
    let out = PCommand::new(&path)
        .args([
            "capture-pane", "-p", "-t", &target, "-S", &format!("-{}", last),
            // drop "-e" if you want plain text without ANSI escapes:
            // "-e",
            "-J",
        ])
        .output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if msg.contains("no server running") || msg.contains("failed to connect to server") {
            return Ok(String::new());
        }
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn tmux_send_keys(session: String, window_index: u32, keys: String, with_enter: bool) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let target = format!("{}:{}", session, window_index);
    let out = PCommand::new(&path)
        .args(["send-keys", "-t", &target, &keys])
        .output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    if with_enter {
        let out2 = PCommand::new(&path)
            .args(["send-keys", "-t", &target, "Enter"])
            .output().map_err(|e| e.to_string())?;
        if !out2.status.success() {
            return Err(String::from_utf8_lossy(&out2.stderr).to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn tmux_kill_session(session: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path).args(["kill-session", "-t", &session]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_new_session(session: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path).args(["new-session", "-d", "-s", &session]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_new_window(session: String, name: Option<String>, cmd: Option<String>) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let mut args = vec!["new-window", "-t", &session];
    if let Some(n) = &name { args.push("-n"); args.push(n); }
    if let Some(c) = &cmd  { args.push(c); }
    let out = PCommand::new(&path).args(&args).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_kill_window(session: String, window_index: u32) -> Result<(), String> {
    let path = which ("tmux").map_err(|e| e.to_string())?;
    let target = format!("{}:{}", session, window_index);
    let out = PCommand::new(&path)
        .args(["kill-window", "-t", &target])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn tmux_rename_window(session: String, window_index: u32, name: String) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let target = format!("{}:{}", session, window_index);
    let out = PCommand::new(&path)
        .args(["rename-window", "-t", &target, &name])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // one window-state plugin, not two:
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unmaximize();
        }
        Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // sessions & server
            tmux_list_sessions,
            tmux_start_server,
            tmux_kill_session,
            tmux_new_session,
            // windows & panes
            tmux_list_windows,
            tmux_new_window,
            tmux_capture_pane,
            tmux_send_keys,
            tmux_rename_window,
            tmux_kill_window,
            // Python validation
            validate_python_executable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
