use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RunStatus {
    Idle,
    Starting,
    Running,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ARCRun {
    pub id: String,                  // unique id of the run
    pub name: String,                // name of the run e.g. "rmg_rxn_1"
    pub session: String,             // tmux session id
    pub input_path: PathBuf,         // path to the input file
    pub work_dir: PathBuf,           // working directory for the run
    pub started_at: Option<String>,  // timestamp when the run started
    pub finished_at: Option<String>, // timestamp when the run finished
    pub status: RunStatus,           // current status of the run
    pub last_stdout: Option<String>, // last stdout line
    pub last_stderr: Option<String>, // last stderr line
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppConfig {
    pub python_path: String,      // path to the python executable
    pub arc_path: String,         // path to the ARC root directory  - so like /home/user/ARC/ARC.py
    pub default_work_dir: String, // default working directory for runs
    pub concurrency_cap: u32,     // max number of concurrent runs
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            python_path: "python3".into(),
            arc_path: "/path/to/ARC/ARC.py".into(),
            default_work_dir: "/path/to/arc_work_dir".into(),
            concurrency_cap: 2,
        }
    }
}
