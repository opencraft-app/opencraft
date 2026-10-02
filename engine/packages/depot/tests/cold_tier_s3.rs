use anyhow::Result;
use aws_config::Region;
use depot::{
	cold_tier::{ColdTier, S3ColdTier, cold_shard_object_key},
	types::DatabaseBranchId,
};
use gas::prelude::Id;

#[tokio::test]
async fn exact_s3_contract_against_configured_endpoint() -> Result<()> {
	let Ok(endpoint) = std::env::var("RIVET_TEST_S3_ENDPOINT") else {
		return Ok(());
	};
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let configured_bucket = std::env::var("RIVET_TEST_S3_BUCKET").ok();
	let virtual_hosted = matches!(
		std::env::var("RIVET_TEST_S3_ADDRESSING_STYLE").as_deref(),
		Ok("virtual")
	);
	let bucket = configured_bucket
		.clone()
		.unwrap_or_else(|| format!("rivet-cold-tier-{}", uuid::Uuid::new_v4().simple()));
	let shared_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
		.region(Region::new(region.clone()))
		.load()
		.await;
	let client = aws_sdk_s3::Client::from_conf(
		aws_sdk_s3::config::Builder::from(&shared_config)
			.endpoint_url(endpoint.clone())
			.force_path_style(!virtual_hosted)
			.build(),
	);
	if configured_bucket.is_none() {
		client.create_bucket().bucket(&bucket).send().await?;
	}

	let tier = S3ColdTier::from_env(
		bucket.clone(),
		Some(endpoint),
		region,
		!virtual_hosted,
		1024,
		2,
	)
	.await?;
	let key = cold_shard_object_key(DatabaseBranchId::new_v4(), Id::new_v1(1), 1, 1, [0x5e; 32]);
	assert!(tier.get_object(&key).await.unwrap_err().is_not_found());
	tier.put_object(&key, b"minio-contract").await?;
	assert_eq!(tier.get_object(&key).await?, b"minio-contract");
	assert_eq!(tier.head_object(&key).await?.size_bytes, 14);
	tier.delete_objects(std::slice::from_ref(&key)).await?;
	tier.delete_objects(std::slice::from_ref(&key)).await?;
	assert!(tier.get_object(&key).await.unwrap_err().is_not_found());

	if configured_bucket.is_none() {
		client.delete_bucket().bucket(bucket).send().await?;
	}
	Ok(())
}
