use frontend_lib::model::{ARCRun, RunStatus};
use std::path::PathBuf;

#[test]
fn arc_run_json_roundtrip() {
    let run = ARCRun {
        id: "uuid-1234".into(),
        name: "rmg_rxn_2025".into(),
        session: "tmux-session-1".into(),
        input_path: PathBuf::from("/tmp/input.py"),
        work_dir: PathBuf::from("/tmp/workdir"),
        started_at: Some("2024-10-01T12:00:00Z".into()),
        finished_at: None,
        status: RunStatus::Running,
        last_stdout: Some(String::new()), // <-- wrap with Some(...)
        last_stderr: Some(String::new()), // <-- wrap with Some(...)
    };

    let json = serde_json::to_string(&run).unwrap();
    let deserialized: ARCRun = serde_json::from_str(&json).unwrap();
    assert_eq!(run, deserialized);
}
