use depot::cold_tier::{ColdTier, ColdTierError, FilesystemColdTier};

#[tokio::test]
async fn filesystem_cold_tier_exact_key_contract() {
	let root = tempfile::tempdir().unwrap();
	let tier = FilesystemColdTier::new_bounded(root.path(), 16, 2).unwrap();
	let key = "branches/abc/shards/0001.cold";

	assert!(matches!(
		tier.get_object(key).await.unwrap_err(),
		ColdTierError::NotFound { .. }
	));
	tier.put_object(key, b"immutable").await.unwrap();
	assert_eq!(tier.get_object(key).await.unwrap(), b"immutable");
	assert_eq!(tier.head_object(key).await.unwrap().size_bytes, 9);
	tier.delete_objects(&[key.to_string()]).await.unwrap();
	tier.delete_objects(&[key.to_string()]).await.unwrap();
	assert!(tier.get_object(key).await.unwrap_err().is_not_found());
}

#[tokio::test]
async fn filesystem_cold_tier_rejects_traversal_and_oversized_objects() {
	let root = tempfile::tempdir().unwrap();
	let tier = FilesystemColdTier::new_bounded(root.path(), 4, 1).unwrap();

	for key in ["", "../escape", "/absolute", "a/./b", "a\\b"] {
		assert!(matches!(
			tier.put_object(key, b"x").await.unwrap_err(),
			ColdTierError::InvalidKey { .. }
		));
	}
	assert!(matches!(
		tier.put_object("valid/key", b"12345").await.unwrap_err(),
		ColdTierError::TooLarge { .. }
	));
	assert!(!root.path().join("escape").exists());
}

#[tokio::test]
async fn filesystem_cold_tier_detects_oversized_existing_object() {
	let root = tempfile::tempdir().unwrap();
	let tier = FilesystemColdTier::new_bounded(root.path(), 4, 1).unwrap();
	let path = root.path().join("external/object");
	tokio::fs::create_dir_all(path.parent().unwrap())
		.await
		.unwrap();
	tokio::fs::write(&path, b"12345").await.unwrap();

	assert!(matches!(
		tier.get_object("external/object").await.unwrap_err(),
		ColdTierError::TooLarge { .. }
	));
}

#[tokio::test]
async fn filesystem_inventory_is_bounded_sorted_and_cursor_resumable() {
	let root = tempfile::tempdir().unwrap();
	let tier = FilesystemColdTier::new_bounded(root.path(), 16, 2).unwrap();
	for key in ["c/object.cold", "a/object.cold", "b/object.cold"] {
		tier.put_object(key, key.as_bytes()).await.unwrap();
	}

	let first = tier.list_inventory_page(None, 2).await.unwrap();
	assert_eq!(
		first
			.objects
			.iter()
			.map(|object| object.key.as_str())
			.collect::<Vec<_>>(),
		vec!["a/object.cold", "b/object.cold"]
	);
	let cursor = first.next_cursor.as_deref().expect("first page cursor");
	let second = tier.list_inventory_page(Some(cursor), 2).await.unwrap();
	assert_eq!(
		second
			.objects
			.iter()
			.map(|object| object.key.as_str())
			.collect::<Vec<_>>(),
		vec!["c/object.cold"]
	);
	assert_eq!(second.next_cursor, None);
}
