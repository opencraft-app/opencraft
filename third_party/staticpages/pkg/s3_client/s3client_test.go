package s3_client

import (
	"testing"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/stretchr/testify/assert"
)

func TestWithBucketConfUsesPathStyleByDefault(t *testing.T) {
	client := &S3PageClient{}

	WithBucketConf(&config.BucketConfig{})(client)

	assert.True(t, client.s3Options.UsePathStyle)
}

func TestWithBucketConfAllowsVirtualHostedStyle(t *testing.T) {
	client := &S3PageClient{}
	usePathStyle := false

	WithBucketConf(&config.BucketConfig{UsePathStyle: &usePathStyle})(client)

	assert.False(t, client.s3Options.UsePathStyle)
}

func TestWithBucketConfDisablesPublicReadByDefault(t *testing.T) {
	client := &S3PageClient{}

	WithBucketConf(&config.BucketConfig{})(client)

	assert.False(t, client.publicRead)
}

func TestWithBucketConfAllowsPublicReadArtifacts(t *testing.T) {
	client := &S3PageClient{}
	publicRead := true

	WithBucketConf(&config.BucketConfig{PublicRead: &publicRead})(client)

	assert.True(t, client.publicRead)
}
