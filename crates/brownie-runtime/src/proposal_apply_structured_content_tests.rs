use super::tests::{append_generated_patch_hunk_proposal, lock_env, parse_line};
use super::BrownieStore;
use serde_json::json;

#[test]
fn proposal_apply_patch_file_rejects_malformed_json_before_writing() {
    let _guard = lock_env();
    let temp = tempfile::tempdir().expect("tempdir");
    let original = "{\n  \"name\": \"brownie\"\n}\n";
    std::fs::write(temp.path().join("package.json"), original).expect("write package");
    std::env::set_var("BROWNIE_WORKSPACE_ROOT", temp.path());

    let start = parse_line(
        r#"{"jsonrpc":"2.0","id":1,"method":"task.start","params":{"goal":"Reject malformed JSON candidate","mode_id":"implementer"}}"#,
    );
    let run_id = start.result.expect("start result")["run_id"]
        .as_str()
        .expect("run id")
        .to_string();
    let store = BrownieStore::new(temp.path());
    let record = store
        .tasks()
        .get_task_by_run_id(&run_id)
        .expect("get task")
        .expect("task");
    let proposal_id = "malformed_json_patch";
    append_generated_patch_hunk_proposal(
        &store,
        &record,
        proposal_id,
        "package.json",
        "}\n",
        "}\n{\n",
    );

    let approve = parse_line(&format!(
        r#"{{"jsonrpc":"2.0","id":2,"method":"proposal.approve","params":{{"run_id":"{run_id}","proposal_id":"{proposal_id}","reason":"JSON preflight regression test"}}}}"#
    ));
    assert!(approve.error.is_none());
    let preflight = parse_line(&format!(
        r#"{{"jsonrpc":"2.0","id":3,"method":"proposal.preflight","params":{{"run_id":"{run_id}","proposal_id":"{proposal_id}"}}}}"#
    ));
    let expected_hash = preflight.result.expect("preflight result")["snapshot"]["file_sha256"]
        .as_str()
        .expect("file hash")
        .to_string();

    let apply = parse_line(
        &json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "proposal.apply",
            "params": {
                "run_id": run_id,
                "proposal_id": proposal_id,
                "expected_target_sha256": expected_hash,
                "patch_old_text": "}\n",
                "patch_new_text": "}\n{\n",
                "authorize": true,
            }
        })
        .to_string(),
    );
    let apply_result = apply.result.expect("apply result");
    assert_eq!(apply_result["apply_result"]["apply_status"], "Denied");
    assert_eq!(apply_result["apply_result"]["applied"], false);
    assert_eq!(
        apply_result["apply_result"]["authorization_consumed"],
        false
    );
    assert_eq!(
        apply_result["apply_result"]["failed_checks"],
        json!(["structured_content_parseable"])
    );
    assert!(apply_result["apply_result"]["checklist"]
        .as_array()
        .expect("checklist")
        .iter()
        .any(|check| {
            check["name"] == "structured_content_parseable" && check["status"] == "Fail"
        }));
    assert_eq!(
        std::fs::read_to_string(temp.path().join("package.json")).expect("read package"),
        original
    );

    std::env::remove_var("BROWNIE_WORKSPACE_ROOT");
}
