use serde::Serialize;
use serde_json::Value as JsonValue;
use std::process::Command as PCommand;
use tauri::Manager;
use which::which;

mod control;
mod ssh;
use ssh::{exec as ssh_exec, SshCreds};

// ---- types shared with frontend ----
#[derive(serde::Deserialize)]
struct HostProfile {
    host: String,
    port: Option<u16>,
    user: String,
    auth: Option<String>,     // "agent" | "key" | "password"
    password: Option<String>, // only when auth == "password"
    key_path: Option<String>,
    key_pass: Option<String>,
    use_agent: Option<bool>, // legacy switch; respected if auth not set
}

#[derive(Serialize)]
struct TmuxWindow {
    index: u32,
    id: String,
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

#[derive(Serialize)]
struct Snapshot {
    windows: Vec<TmuxWindow>,
    pane: String,
}

fn is_placeholder_name(name: &str, index: u32) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return true;
    }
    trimmed.parse::<u32>().map(|n| n == index).unwrap_or(false)
}

fn tmux_target(session: &str, window: &TmuxWindow) -> String {
    let id = window.id.trim();
    if !id.is_empty() {
        id.to_string()
    } else {
        format!("{}:{}", session, window.index)
    }
}

fn hydrate_local_names(session: &str, windows: &mut [TmuxWindow]) -> Result<(), String> {
    if windows.is_empty() {
        return Ok(());
    }
    let tmux_path = which("tmux").map_err(|e| e.to_string())?;
    for win in windows.iter_mut() {
        if !is_placeholder_name(&win.name, win.index) {
            continue;
        }
        let target = tmux_target(session, win);
        let out = PCommand::new(&tmux_path)
            .args([
                "display-message",
                "-p",
                "-t",
                &target,
                "-F",
                "#{window_name}",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            continue;
        }
        let name = String::from_utf8_lossy(&out.stdout)
            .trim_end_matches(['\r', '\n'])
            .trim()
            .to_string();
        if !name.is_empty() {
            win.name = name;
        }
    }
    Ok(())
}

fn hydrate_remote_names(
    session: &str,
    windows: &mut [TmuxWindow],
    creds: &SshCreds<'_>,
) -> Result<(), String> {
    if windows.is_empty() {
        return Ok(());
    }
    for win in windows.iter_mut() {
        if !is_placeholder_name(&win.name, win.index) {
            continue;
        }
        let target = tmux_target(session, win);
        let escaped = shell_escape::escape(target.into());
        let cmd = format!(
            "tmux display-message -p -t {} -F '#{{window_name}}'",
            escaped
        );
        let out = ssh_exec(creds, &cmd)?;
        if out.code != 0 {
            continue;
        }
        let name = out.stdout.trim_end_matches(['\r', '\n']).trim().to_string();
        if !name.is_empty() {
            win.name = name;
        }
    }
    Ok(())
}

fn ensure_window_ids(session: &str, windows: &mut [TmuxWindow]) {
    for win in windows.iter_mut() {
        if win.id.trim().is_empty() {
            win.id = format!("{}:{}", session, win.index);
        }
    }
}

fn run_remote_cmd(creds: &SshCreds<'_>, raw: String) -> Result<ssh::ExecOut, String> {
    let prelude = "unset BASH_ENV TMUX PROMPT_COMMAND PS1; if [ -f /etc/profile ]; then source /etc/profile; fi";
    let chained = format!("{}; {}", prelude, raw);
    let wrapped = format!("bash -lc {}", shell_escape::escape(chained.into()));
    ssh_exec(creds, &wrapped)
}

// ---- helper: build SshCreds from HostProfile (no slow fallbacks) ----
fn creds_from(profile: &HostProfile) -> SshCreds<'_> {
    use std::path::Path;

    // Resolve auth mode deterministically
    let auth = profile.auth.as_deref().unwrap_or_else(|| {
        // keep legacy behavior: default to agent unless told otherwise
        if profile.use_agent.unwrap_or(true) {
            "agent"
        } else if profile.key_path.as_deref().is_some() {
            "key"
        } else {
            "agent"
        }
    });

    let key_path = if auth == "key" {
        profile.key_path.as_deref().and_then(|s| {
            if s.trim().is_empty() {
                None
            } else {
                Some(Path::new(s))
            }
        })
    } else {
        None
    };

    SshCreds {
        host: &profile.host,
        port: profile.port.unwrap_or(22),
        user: &profile.user,
        password: if auth == "password" {
            profile.password.as_deref()
        } else {
            None
        },
        key_path,
        key_pass: if auth == "key" {
            profile.key_pass.as_deref()
        } else {
            None
        },
        use_agent: auth == "agent",
    }
}

// ----------------- LOCAL TMUX -----------------

#[tauri::command]
fn tmux_list_sessions() -> Result<Vec<TmuxSession>, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let out = PCommand::new(&path)
        .args([
            "list-sessions",
            "-F",
            "#S|#{session_windows}|#{?session_attached,1,0}",
        ])
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
            let mut it = line.split('|');
            let name = it.next().unwrap_or("").to_string();
            let windows = it.next().unwrap_or("0").parse().unwrap_or(0);
            let attached = it.next().unwrap_or("0") == "1";
            TmuxSession {
                name,
                windows,
                attached,
            }
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
fn tmux_rename_session(payload: JsonValue) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let new_name = payload
        .get("new_name")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("newName").and_then(|v| v.as_str()))
        .ok_or_else(|| "missing new_name/newName".to_string())?;
    let out = PCommand::new(&path)
        .args(["rename-session", "-t", session, new_name])
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
        .args([
            "list-windows",
            "-t",
            &session,
            "-F",
            "#{window_index}|#{window_id}|#{window_name}|#{?window_active,1,0}|#{window_panes}",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if msg.contains("no server running") {
            return Ok(vec![]);
        }
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut windows: Vec<TmuxWindow> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let mut it = line.split('|'); // NOTE: '|' (not tab)
            let index: u32 = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
            let id = it.next().unwrap_or("").trim().to_string();
            let name = it
                .next()
                .unwrap_or("")
                .trim_end_matches(['\r', '\n'])
                .to_string();
            let active = it.next().unwrap_or("0").trim() == "1";
            let panes: u32 = it.next().unwrap_or("1").trim().parse().unwrap_or(1);
            TmuxWindow {
                index,
                id,
                name,
                active,
                panes,
            }
        })
        .collect();
    hydrate_local_names(&session, &mut windows)?;
    ensure_window_ids(&session, &mut windows);
    Ok(windows)
}

#[tauri::command]
fn tmux_new_window(
    session: String,
    name: Option<String>,
    cmd: Option<String>,
) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let mut args = vec!["new-window", "-P", "-F", "#{window_id}", "-t", &session];
    if let Some(ref n) = name {
        args.push("-n");
        args.push(n);
    }
    if let Some(c) = &cmd {
        args.push(c);
    }
    let out = PCommand::new(&path)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    if name.is_some() {
        let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !id.is_empty() {
            let _ = PCommand::new(&path)
                .args(["set-window-option", "-t", &id, "automatic-rename", "off"])
                .output();
        }
    }
    Ok(())
}

#[tauri::command]
fn tmux_capture_pane(payload: JsonValue) -> Result<String, String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let window_id = payload
        .get("window_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("windowId").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let last = payload.get("lines").and_then(|v| v.as_u64()).unwrap_or(800) as u32;
    let target = window_id.unwrap_or_else(|| format!("{}:{}", session, idx));
    let out = PCommand::new(&path)
        .args([
            "capture-pane",
            "-p",
            "-t",
            &target,
            "-S",
            &format!("-{}", last),
            "-e",
            "-J",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if msg.contains("no server running") || msg.contains("failed to connect to server") {
            return Ok(String::new());
        }
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxCommand {
    args: Vec<String>,
}

fn build_tmux_send_keys_commands(target: &str, keys: &str, with_enter: bool) -> Vec<TmuxCommand> {
    let mut commands = vec![TmuxCommand {
        args: vec![
            "send-keys".into(),
            "-t".into(),
            target.to_string(),
            "-l".into(),
            keys.to_string(),
        ],
    }];
    if with_enter {
        commands.push(TmuxCommand {
            args: vec![
                "send-keys".into(),
                "-t".into(),
                target.to_string(),
                "Enter".into(),
            ],
        });
    }
    commands
}

fn format_remote_tmux_command(command: &TmuxCommand) -> String {
    use std::borrow::Cow;
    let escaped: Vec<String> = command
        .args
        .iter()
        .map(|arg| shell_escape::escape(Cow::from(arg.as_str())).to_string())
        .collect();
    format!("tmux {}", escaped.join(" "))
}

#[tauri::command]
fn tmux_send_keys(payload: JsonValue) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let window_id = payload
        .get("window_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("windowId").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let keys = payload
        .get("keys")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing keys".to_string())?;
    let with_enter = payload
        .get("with_enter")
        .and_then(|v| v.as_bool())
        .or_else(|| payload.get("withEnter").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let target = window_id.unwrap_or_else(|| format!("{}:{}", session, idx));
    let commands = build_tmux_send_keys_commands(&target, keys, with_enter);
    for command in commands {
        let mut proc = PCommand::new(&path);
        proc.args(&command.args);
        let out = proc.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn tmux_rename_window(payload: JsonValue) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let new_name = payload
        .get("new_name")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("name").and_then(|v| v.as_str()))
        .ok_or_else(|| "missing new_name/name".to_string())?;
    let target = format!("{}:{}", session, idx);
    let out = PCommand::new(&path)
        .args(["rename-window", "-t", &target, &new_name])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let _ = PCommand::new(&path)
        .args([
            "set-window-option",
            "-t",
            &target,
            "automatic-rename",
            "off",
        ])
        .output();
    Ok(())
}

#[tauri::command]
fn tmux_kill_window(payload: JsonValue) -> Result<(), String> {
    let path = which("tmux").map_err(|e| e.to_string())?;
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let window_id = payload
        .get("window_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("windowId").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let target = window_id.unwrap_or_else(|| format!("{}:{}", session, idx));
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
fn validate_python_executable(path: String) -> Result<String, String> {
    use std::path::Path;
    if !Path::new(&path).exists() {
        return Err("File does not exist".into());
    }
    let output = PCommand::new(&path)
        .args(["--version"])
        .output()
        .map_err(|e| format!("Failed to execute: {}", e))?;
    if !output.status.success() {
        return Err("Not a valid Python executable".into());
    }
    let v = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        String::from_utf8_lossy(&output.stderr)
    };
    let line = v.lines().next().unwrap_or("").trim();
    if line.starts_with("Python ") {
        Ok(line.to_string())
    } else {
        Err("Invalid Python version output".into())
    }
}

// ----------------- REMOTE TMUX -----------------

#[tauri::command]
fn remote_tmux_list_sessions(profile: HostProfile) -> Result<Vec<TmuxSession>, String> {
    let c = creds_from(&profile);
    let cmd = r##"tmux list-sessions -F "#S|#{session_windows}|#{?session_attached,1,0}""##;
    let out = run_remote_cmd(&c, cmd.to_string())?;
    if out.code != 0 {
        let msg = out.stderr.to_lowercase();
        if msg.contains("no server running") || msg.contains("no sessions") {
            return Ok(vec![]);
        }
        return Err(out.stderr);
    }
    let sessions = out
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let mut it = line.split('|');
            let name = it.next().unwrap_or("").to_string();
            let windows = it.next().unwrap_or("0").parse().unwrap_or(0);
            let attached = it.next().unwrap_or("0") == "1";
            TmuxSession {
                name,
                windows,
                attached,
            }
        })
        .collect();
    Ok(sessions)
}

#[tauri::command]
fn remote_tmux_list_windows(
    profile: HostProfile,
    session: String,
) -> Result<Vec<TmuxWindow>, String> {
    let c = creds_from(&profile);

    // robust: no newlines, single-quoted -F, escape tmux braces for Rust,
    // and shell-escape the session name
    let cmd = format!(
    "tmux list-windows -t {} -F '#{{window_index}}|#{{window_id}}|#{{window_name}}|#{{?window_active,1,0}}|#{{window_panes}}'",
    shell_escape::escape(session.clone().into())
  );

    let out = run_remote_cmd(&c, cmd.clone())?;
    if out.code != 0 {
        return Err(out.stderr);
    }

    println!(
        "[remote_tmux_list_windows] cmd={} code={} stdout=<<{}>> stderr=<<{}>>",
        cmd, out.code, out.stdout, out.stderr,
    );

    let mut windows: Vec<TmuxWindow> = out
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let mut it = line.split('|');
            let index = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
            let id = it.next().unwrap_or("").trim().to_string();
            let name = it
                .next()
                .unwrap_or("")
                .trim_end_matches(['\r', '\n'])
                .to_string();
            let active = it.next().unwrap_or("0").trim() == "1";
            let panes = it.next().unwrap_or("1").trim().parse().unwrap_or(1);
            TmuxWindow {
                index,
                id,
                name,
                active,
                panes,
            }
        })
        .collect();

    hydrate_remote_names(&session, &mut windows, &c)?;
    ensure_window_ids(&session, &mut windows);
    Ok(windows)
}

#[tauri::command]
fn remote_tmux_snapshot(
    profile: HostProfile,
    session: String,
    window_index: Option<u32>,
    window_id: Option<String>,
    lines: Option<u32>,
) -> Result<Snapshot, String> {
    let c = creds_from(&profile);

    // list-windows format
    let fmt = "#{window_index}|#{window_id}|#{window_name}|#{?window_active,1,0}|#{window_panes}";
    let delim = "__ARC_SPLIT__";

    let escaped_session = shell_escape::escape(session.clone().into());

    // pick a tmux target: if no index, use the active window via "session:"
    let target = if let Some(ref id) = window_id {
        id.clone()
    } else if let Some(idx) = window_index {
        format!("{}:{}", escaped_session, idx)
    } else {
        format!("{}:", escaped_session)
    };

    // one SSH exec
    let cmd = format!(
    "tmux list-windows -t {} -F '{}' && printf '\\n{}\\n' && tmux capture-pane -p -t {} -S -{} -e -J",
    escaped_session,
    fmt,
    delim,
    target,
    lines.unwrap_or(200)
  );

    let out = run_remote_cmd(&c, cmd.clone())?;
    if out.code != 0 {
        return Err(out.stderr);
    }

    let delim_line = format!("\n{}\n", delim);
    let (win_txt, pane_txt) = match out.stdout.split_once(&delim_line) {
        Some((a, b)) => (a, b),
        None => (out.stdout.as_str(), ""),
    };

    let mut windows = win_txt
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let mut it = line.split('|');
            let index = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
            let id = it.next().unwrap_or("").trim().to_string();
            let name = it
                .next()
                .unwrap_or("")
                .trim_end_matches(['\r', '\n'])
                .to_string();
            let active = it.next().unwrap_or("0").trim() == "1";
            let panes = it.next().unwrap_or("1").trim().parse().unwrap_or(1);
            TmuxWindow {
                index,
                id,
                name,
                active,
                panes,
            }
        })
        .collect::<Vec<_>>();

    hydrate_remote_names(&session, &mut windows, &c)?;
    ensure_window_ids(&session, &mut windows);

    Ok(Snapshot {
        windows,
        pane: pane_txt.to_string(),
    })
}

#[tauri::command]
fn remote_tmux_capture_pane(payload: JsonValue) -> Result<String, String> {
    let profile: HostProfile = serde_json::from_value(
        payload
            .get("profile")
            .cloned()
            .ok_or_else(|| "missing profile".to_string())?,
    )
    .map_err(|e| format!("invalid profile: {}", e))?;
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let window_id = payload
        .get("window_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("windowId").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let lines = payload.get("lines").and_then(|v| v.as_u64()).unwrap_or(800) as u32;
    let c = creds_from(&profile);
    let escaped_session = shell_escape::escape(session.into());
    let target = window_id.unwrap_or_else(|| format!("{escaped_session}:{idx}"));
    let cmd = format!(
        r##"tmux capture-pane -p -t {} -S -{} -e -J"##,
        target, lines
    );
    let out = run_remote_cmd(&c, cmd.clone())?;
    if out.code == 0 {
        Ok(out.stdout)
    } else {
        let msg = out.stderr.to_lowercase();
        if msg.contains("no server running") {
            return Ok(String::new());
        }
        Err(out.stderr)
    }
}

#[tauri::command]
fn remote_tmux_select_window(
    profile: HostProfile,
    session: String,
    target: String,
) -> Result<(), String> {
    control::send_command(profile, session, format!("select-window -t {}", target))
}

#[tauri::command]
fn remote_tmux_control_start(
    app_handle: tauri::AppHandle,
    profile: HostProfile,
    session: String,
) -> Result<(), String> {
    control::start_control(app_handle, profile, session)
}

#[tauri::command]
fn remote_tmux_control_stop(profile: HostProfile, session: String) -> Result<(), String> {
    control::stop_control(profile, session)
}

#[tauri::command]
fn remote_tmux_control_send(
    profile: HostProfile,
    session: String,
    command: String,
) -> Result<(), String> {
    control::send_command(profile, session, command)
}

#[tauri::command]
fn remote_tmux_send_keys(payload: JsonValue) -> Result<(), String> {
    let profile: HostProfile = serde_json::from_value(
        payload
            .get("profile")
            .cloned()
            .ok_or_else(|| "missing profile".to_string())?,
    )
    .map_err(|e| format!("invalid profile: {}", e))?;
    let c = creds_from(&profile);
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let window_id = payload
        .get("window_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("windowId").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let keys = payload
        .get("keys")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing keys".to_string())?;
    let with_enter = payload
        .get("with_enter")
        .and_then(|v| v.as_bool())
        .or_else(|| payload.get("withEnter").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let target = window_id.unwrap_or_else(|| format!("{}:{}", session, idx));
    let commands = build_tmux_send_keys_commands(&target, keys, with_enter);
    for command in commands {
        let formatted = format_remote_tmux_command(&command);
        let out = run_remote_cmd(&c, formatted)?;
        if out.code != 0 {
            return Err(out.stderr);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_tmux_send_keys_commands,
        format_remote_tmux_command,
        TmuxCommand,
    };

    #[test]
    fn build_commands_include_enter_when_requested() {
        let commands = build_tmux_send_keys_commands("arc:0", "ls -la", true);
        assert_eq!(
            commands,
            vec![
                TmuxCommand {
                    args: vec![
                        "send-keys".into(),
                        "-t".into(),
                        "arc:0".into(),
                        "-l".into(),
                        "ls -la".into(),
                    ],
                },
                TmuxCommand {
                    args: vec![
                        "send-keys".into(),
                        "-t".into(),
                        "arc:0".into(),
                        "Enter".into(),
                    ],
                },
            ]
        );
    }

    #[test]
    fn build_commands_omit_enter_when_not_requested() {
        let commands = build_tmux_send_keys_commands("arc:1", "whoami", false);
        assert_eq!(
            commands,
            vec![TmuxCommand {
                args: vec![
                    "send-keys".into(),
                    "-t".into(),
                    "arc:1".into(),
                    "-l".into(),
                    "whoami".into(),
                ],
            }]
        );
    }

    #[test]
    fn remote_format_escapes_arguments() {
        let commands = build_tmux_send_keys_commands("pane @1", "echo 'hi'", true);
        let literal = format_remote_tmux_command(&commands[0]);
        let enter = format_remote_tmux_command(&commands[1]);
        assert_eq!(
            literal,
            "tmux send-keys -t 'pane @1' -l 'echo '"'"'hi'"'"''"
        );
        assert_eq!(enter, "tmux send-keys -t 'pane @1' Enter");
    }
}

#[tauri::command]
fn remote_tmux_new_window(
    profile: HostProfile,
    session: String,
    name: Option<String>,
    cmd: Option<String>,
) -> Result<(), String> {
    let c = creds_from(&profile);
    let mut args = format!(
        "tmux new-window -P -F '#{{window_id}}' -t {}",
        shell_escape::escape(session.clone().into())
    );
    if let Some(ref n) = name {
        args.push_str(&format!(" -n {}", shell_escape::escape(n.into())));
    }
    if let Some(command) = cmd {
        args.push(' ');
        args.push_str(&command);
    }
    let out = run_remote_cmd(&c, args.clone())?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    if name.is_some() {
        let id = out.stdout.trim();
        if !id.is_empty() {
            let _ = run_remote_cmd(
                &c,
                format!("tmux set-window-option -t {} automatic-rename off", id),
            );
        }
    }
    Ok(())
}

#[tauri::command]
fn remote_tmux_kill_window(payload: JsonValue) -> Result<(), String> {
    let profile: HostProfile = serde_json::from_value(
        payload
            .get("profile")
            .cloned()
            .ok_or_else(|| "missing profile".to_string())?,
    )
    .map_err(|e| format!("invalid profile: {}", e))?;
    let c = creds_from(&profile);
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let window_id = payload
        .get("window_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("windowId").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let escaped_session = shell_escape::escape(session.into());
    let target = window_id.unwrap_or_else(|| format!("{}:{}", escaped_session, idx));
    let out = ssh_exec(&c, &format!("tmux kill-window -t {}", target))?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    Ok(())
}

#[tauri::command]
fn remote_tmux_rename_window(payload: JsonValue) -> Result<(), String> {
    let profile: HostProfile = serde_json::from_value(
        payload
            .get("profile")
            .cloned()
            .ok_or_else(|| "missing profile".to_string())?,
    )
    .map_err(|e| format!("invalid profile: {}", e))?;
    let c = creds_from(&profile);
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let idx = payload
        .get("window_index")
        .and_then(|v| v.as_u64())
        .or_else(|| payload.get("windowIndex").and_then(|v| v.as_u64()))
        .ok_or_else(|| "missing window_index/windowIndex".to_string())? as u32;
    let window_id = payload
        .get("window_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("windowId").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let new_name = payload
        .get("new_name")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("name").and_then(|v| v.as_str()))
        .ok_or_else(|| "missing new_name/name".to_string())?;
    let escaped_session = shell_escape::escape(session.into());
    let target = window_id.unwrap_or_else(|| format!("{}:{}", escaped_session, idx));
    let cmd = format!(
        "tmux rename-window -t {} {}",
        target,
        shell_escape::escape(new_name.into())
    );
    let out = ssh_exec(&c, &cmd)?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    let _ = ssh_exec(
        &c,
        &format!("tmux set-window-option -t {} automatic-rename off", target),
    );
    Ok(())
}

#[tauri::command]
fn remote_tmux_start_server(profile: HostProfile) -> Result<(), String> {
    let c = creds_from(&profile);
    let out = ssh_exec(&c, "tmux start-server")?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    Ok(())
}

#[tauri::command]
fn remote_tmux_new_session(profile: HostProfile, session: String) -> Result<(), String> {
    let c = creds_from(&profile);
    let out = ssh_exec(
        &c,
        &format!(
            "tmux new-session -d -s {}",
            shell_escape::escape(session.into())
        ),
    )?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    Ok(())
}

#[tauri::command]
fn remote_tmux_rename_session(payload: JsonValue) -> Result<(), String> {
    let profile: HostProfile = serde_json::from_value(
        payload
            .get("profile")
            .cloned()
            .ok_or_else(|| "missing profile".to_string())?,
    )
    .map_err(|e| format!("invalid profile: {}", e))?;
    let c = creds_from(&profile);
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing session".to_string())?;
    let new_name = payload
        .get("new_name")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("newName").and_then(|v| v.as_str()))
        .ok_or_else(|| "missing new_name/newName".to_string())?;
    let out = ssh_exec(
        &c,
        &format!(
            "tmux rename-session -t {} {}",
            shell_escape::escape(session.into()),
            shell_escape::escape(new_name.into())
        ),
    )?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    Ok(())
}

#[tauri::command]
fn remote_tmux_kill_session(profile: HostProfile, session: String) -> Result<(), String> {
    let c = creds_from(&profile);
    let out = ssh_exec(
        &c,
        &format!(
            "tmux kill-session -t {}",
            shell_escape::escape(session.into())
        ),
    )?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    Ok(())
}

#[tauri::command]
fn remote_ping(profile: HostProfile) -> Result<String, String> {
    let c = creds_from(&profile);
    let out = ssh_exec(&c, "whoami && tmux -V || true")?;
    if out.code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        Err(out.stderr)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if let Some(_win) = app.get_webview_window("main") { /* keep restored size/pos */ }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // local
            tmux_list_sessions,
            tmux_start_server,
            tmux_kill_session,
            tmux_new_session,
            tmux_rename_session,
            tmux_list_windows,
            tmux_new_window,
            tmux_capture_pane,
            tmux_send_keys,
            tmux_rename_window,
            tmux_kill_window,
            validate_python_executable,
            // remote
            remote_ping,
            remote_tmux_snapshot,
            remote_tmux_start_server,
            remote_tmux_list_sessions,
            remote_tmux_list_windows,
            remote_tmux_capture_pane,
            remote_tmux_send_keys,
            remote_tmux_new_window,
            remote_tmux_kill_window,
            remote_tmux_rename_window,
            remote_tmux_new_session,
            remote_tmux_rename_session,
            remote_tmux_kill_session,
            remote_tmux_select_window,
            remote_tmux_control_start,
            remote_tmux_control_stop,
            remote_tmux_control_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
