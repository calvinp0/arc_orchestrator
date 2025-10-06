// src-tauri/src/ssh.rs
use once_cell::sync::Lazy;
use ssh2::Session;
use std::sync::Mutex;
use std::{net::TcpStream, path::Path};

pub struct SshCreds<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: Option<&'a str>,
    pub key_path: Option<&'a Path>,
    pub key_pass: Option<&'a str>,
    pub use_agent: bool,
}

pub struct ExecOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConnKey {
    host: String,
    port: u16,
    user: String,
}

impl ConnKey {
    fn from(creds: &SshCreds) -> Self {
        Self {
            host: creds.host.to_string(),
            port: creds.port,
            user: creds.user.to_string(),
        }
    }
}

struct SshClient {
    key: ConnKey,
    sess: Session,
}

static CLIENT: Lazy<Mutex<Option<SshClient>>> = Lazy::new(|| Mutex::new(None));

fn connect(creds: &SshCreds) -> Result<SshClient, String> {
    let stream = TcpStream::connect((creds.host, creds.port)).map_err(|e| format!("tcp: {}", e))?;

    // ssh.rs (inside connect())
    let mut sess = Session::new().map_err(|e| format!("ssh: {e}"))?;
    sess.set_tcp_stream(stream);
    sess.handshake()
        .map_err(|e| format!("ssh handshake: {e}"))?;

    // Add a hard timeout for all channel ops (ms)
    sess.set_timeout(6000);

    // Auth preference: password -> agent -> key file.
    if let Some(pw) = creds.password {
        sess.userauth_password(creds.user, pw)
            .map_err(|e| format!("password auth: {e}"))?;
    } else if creds.use_agent {
        let mut agent = sess.agent().map_err(|e| format!("agent: {e}"))?;
        agent.connect().map_err(|e| format!("agent connect: {e}"))?;
        agent
            .list_identities()
            .map_err(|e| format!("agent ids: {e}"))?;
        let mut ok = false;
        for id in agent.identities().map_err(|e| format!("agent ids: {e}"))? {
            if agent.userauth(creds.user, &id).is_ok() {
                ok = true;
                break;
            }
        }
        if !ok {
            return Err("ssh-agent auth failed".into());
        }
    } else if let Some(kp) = creds.key_path {
        sess.userauth_pubkey_file(creds.user, None, kp, creds.key_pass)
            .map_err(|e| format!("pubkey auth: {e}"))?;
    } else {
        return Err("no auth method".into());
    }

    if !sess.authenticated() {
        return Err("ssh not authenticated".into());
    }

    // (Optional) keepalive every 15s so idle capture polls don’t drop
    // Not all versions expose a setter; ignore if unsupported.
    let _ = sess.keepalive_send();

    Ok(SshClient {
        key: ConnKey::from(creds),
        sess,
    })
}

fn ensure_client(
    creds: &SshCreds,
) -> Result<std::sync::MutexGuard<'static, Option<SshClient>>, String> {
    let mut guard = CLIENT.lock().unwrap();
    let need_new = match &*guard {
        Some(c) => c.key != ConnKey::from(creds),
        None => true,
    };
    if need_new {
        *guard = Some(connect(creds)?);
    }
    Ok(guard)
}

pub fn exec(creds: &SshCreds, cmd: &str) -> Result<ExecOut, String> {
    for attempt in 0..2 {
        // 1) get or create a session, but DO NOT hold the lock for network I/O
        let sess = {
            let mut guard = ensure_client(creds)?;
            match guard.as_mut() {
                Some(client) => client.sess.clone(), // clone the session handle
                None => {
                    *guard = Some(connect(creds)?);
                    guard.as_ref().unwrap().sess.clone()
                }
            }
        }; // <-- mutex is dropped here

        // 2) do the SSH work without holding the mutex
        match sess.channel_session() {
            Ok(mut ch) => {
                if let Err(e) = ch.exec(cmd) {
                    // invalidate and retry once
                    if attempt == 0 {
                        let mut guard = CLIENT.lock().unwrap();
                        *guard = None;
                        continue;
                    } else {
                        return Err(format!("exec: {e}"));
                    }
                }

                use std::io::Read;
                let mut out = String::new();
                let mut err = String::new();
                let _ = ch.read_to_string(&mut out);
                let mut ext = ch.stderr();
                let _ = ext.read_to_string(&mut err);
                let _ = ch.wait_close();
                let code = ch.exit_status().unwrap_or(1);
                return Ok(ExecOut {
                    code,
                    stdout: out,
                    stderr: err,
                });
            }
            Err(e) => {
                if attempt == 0 {
                    let mut guard = CLIENT.lock().unwrap();
                    *guard = None;
                    continue;
                } else {
                    return Err(format!("channel: {e}"));
                }
            }
        }
    }
    Err("unreachable exec failure".into())
}

pub fn open_channel(creds: &SshCreds) -> Result<ssh2::Channel, String> {
    for attempt in 0..2 {
        let sess = {
            let mut guard = ensure_client(creds)?;
            match guard.as_mut() {
                Some(client) => client.sess.clone(),
                None => {
                    *guard = Some(connect(creds)?);
                    guard.as_ref().unwrap().sess.clone()
                }
            }
        };

        match sess.channel_session() {
            Ok(channel) => return Ok(channel),
            Err(e) => {
                if attempt == 0 {
                    let mut guard = CLIENT.lock().unwrap();
                    *guard = None;
                    continue;
                } else {
                    return Err(format!("channel: {e}"));
                }
            }
        }
    }
    Err("unreachable open_channel failure".into())
}
