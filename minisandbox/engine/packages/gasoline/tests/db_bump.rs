use gas::prelude::Id;
use gasoline as gas;
use gasoline::db::BumpSubSubject;

#[test]
fn bump_subject_display_preserves_wire_subjects() {
	let workflow_id = Id::new_v1(1);

	let cases = [
		(BumpSubSubject::Worker, "gasoline.worker.bump".to_string()),
		(
			BumpSubSubject::WorkflowComplete { workflow_id },
			format!("gasoline.workflow.complete.{workflow_id}"),
		),
		(
			BumpSubSubject::SignalPublish {
				to_workflow_id: workflow_id,
			},
			format!("gasoline.signal.for-workflow.{workflow_id}"),
		),
	];

	for (subject, expected) in cases {
		assert_eq!(subject.to_string(), expected);
	}
}
