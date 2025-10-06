use crate::ssh;
use crate::{creds_from, HostProfile};
use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static MANAGER: Lazy<ControlManager> = Lazy::new(ControlManager::new);

pub struct ControlManager {
    inner: Mutex<HashMap<String, ControlHandle>>,
}

struct ControlHandle {
    cmd_tx: mpsc::Sender<String>,
    stop_tx: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ControlManager {
    const EVENT: &'static str = "tmux-control-event";

    fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn global() -> &'static Self {
        &MANAGER
    }

    fn key(profile: &HostProfile, session: &str) -> String {
        let port = profile.port.unwrap_or(22);
        format!("{}@{}:{}#{}", profile.user, profile.host, port, session)
    }

    pub fn start(
        &self,
        app: AppHandle,
        profile: HostProfile,
        session: String,
    ) -> Result<(), String> {
        let key = Self::key(&profile, &session);
        {
            let inner = self.inner.lock().unwrap();
            if inner.contains_key(&key) {
                return Err("control session already running".into());
            }
        }

        let creds = creds_from(&profile);
        let mut channel = ssh::open_channel(&creds)?;
        let cmd = format!(
            "tmux -CC attach-session -t {}",
            shell_escape::escape(session.clone().into())
        );
        channel
            .exec(&cmd)
            .map_err(|e| format!("tmux control exec: {e}"))?;

        let (cmd_tx, cmd_rx) = mpsc::channel::<String>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let handle_key = key.clone();

        let reader_thread = thread::spawn(move || {
            let mut channel = channel;
            let app_handle = app.clone();
            let send_event = |kind: &str, line: Option<String>| {
                let payload = json!({
                    "key": handle_key,
                    "kind": kind,
                    "line": line,
                });
                let _ = app_handle.emit(ControlManager::EVENT, payload);
            };

            send_event("started", None);
            let mut buf = [0u8; 4096];
            let mut pending = String::new();

            loop {
                if stop_rx.try_recv().is_ok() {
                    let _ = channel.close();
                    send_event("stopped", None);
                    break;
                }

                while let Ok(cmd) = cmd_rx.try_recv() {
                    let mut command = cmd;
                    if !command.ends_with('\n') {
                        command.push('\n');
                    }
                    if let Err(e) = channel.write_all(command.as_bytes()) {
                        send_event("error", Some(format!("write failed: {e}")));
                        let _ = channel.close();
                        send_event("stopped", None);
                        return;
                    }
                    let _ = channel.flush();
                }

                match channel.read(&mut buf) {
                    Ok(0) => {
                        if channel.eof() {
                            send_event("closed", None);
                            break;
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]);
                        pending.push_str(&chunk);
                        while let Some(idx) = pending.find('\n') {
                            let line = pending[..idx].to_string();
                            let rest = pending[idx + 1..].to_string();
                            pending = rest;
                            send_event("line", Some(line));
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(err) => {
                        send_event("error", Some(format!("read failed: {err}")));
                        let _ = channel.close();
                        send_event("stopped", None);
                        break;
                    }
                }
            }
        });

        let handle = ControlHandle {
            cmd_tx,
            stop_tx,
            thread: Some(reader_thread),
        };

        let mut inner = self.inner.lock().unwrap();
        inner.insert(key, handle);
        Ok(())
    }

    pub fn stop(&self, profile: HostProfile, session: String) -> Result<(), String> {
        let key = Self::key(&profile, &session);
        let handle = {
            let mut inner = self.inner.lock().unwrap();
            inner.remove(&key)
        };
        match handle {
            Some(mut handle) => {
                let _ = handle.stop_tx.send(());
                if let Some(thread) = handle.thread.take() {
                    let _ = thread.join();
                }
                Ok(())
            }
            None => Err("control session not running".into()),
        }
    }

    pub fn send(
        &self,
        profile: HostProfile,
        session: String,
        command: String,
    ) -> Result<(), String> {
        let key = Self::key(&profile, &session);
        let inner = self.inner.lock().unwrap();
        match inner.get(&key) {
            Some(handle) => handle.cmd_tx.send(command).map_err(|e| format!("{e}")),
            None => Err("control session not running".into()),
        }
    }
}

pub fn start_control(app: AppHandle, profile: HostProfile, session: String) -> Result<(), String> {
    ControlManager::global().start(app, profile, session)
}

pub fn stop_control(profile: HostProfile, session: String) -> Result<(), String> {
    ControlManager::global().stop(profile, session)
}

pub fn send_command(profile: HostProfile, session: String, command: String) -> Result<(), String> {
    ControlManager::global().send(profile, session, command)
}
