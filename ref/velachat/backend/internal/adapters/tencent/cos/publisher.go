package cos

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	cosSDK "github.com/tencentyun/cos-go-sdk-v5"
)

// Publisher 用最小权限身份发布不可覆盖的版本化 Computer 制品。
type Publisher struct {
	client *cosSDK.Client
}

func NewPublisher(config Config) (*Publisher, error) {
	endpoint, err := endpointFor(config)
	if err != nil {
		return nil, err
	}
	transport := &cosSDK.AuthorizationTransport{
		SecretID: config.SecretID, SecretKey: config.SecretKey,
		SessionToken: config.SecurityToken,
	}
	return &Publisher{client: cosSDK.NewClient(
		&cosSDK.BaseURL{BucketURL: endpoint},
		&http.Client{Transport: transport},
	)}, nil
}

// PublishFile 先验证本地字节，禁止覆盖上传，最后重新 GET 并校验真实远端字节。
func (publisher *Publisher) PublishFile(
	ctx context.Context,
	objectKey string,
	filename string,
	contentType string,
	expectedHash [32]byte,
	expectedSize int64,
) error {
	if ctx == nil || !validObjectKey(objectKey) || strings.TrimSpace(filename) == "" ||
		strings.TrimSpace(contentType) == "" || expectedHash == [32]byte{} || expectedSize <= 0 {
		return errors.New("COS 发布参数无效")
	}
	if err := verifyLocalFile(filename, expectedHash, expectedSize); err != nil {
		return err
	}
	if publisher == nil || publisher.client == nil {
		return errors.New("COS 发布器未配置")
	}
	file, err := os.Open(filename)
	if err != nil {
		return errors.New("无法读取待发布制品")
	}
	header := make(http.Header)
	header.Set("x-cos-forbid-overwrite", "true")
	_, putErr := publisher.client.Object.Put(ctx, objectKey, file, &cosSDK.ObjectPutOptions{
		ObjectPutHeaderOptions: &cosSDK.ObjectPutHeaderOptions{
			ContentType: strings.TrimSpace(contentType), ContentLength: expectedSize,
			XOptionHeader: &header,
		},
	})
	closeErr := file.Close()
	if closeErr != nil && putErr == nil {
		putErr = closeErr
	}
	verifyErr := publisher.verifyRemote(ctx, objectKey, expectedHash, expectedSize)
	if verifyErr == nil {
		return nil
	}
	if putErr != nil {
		return errors.New("COS 对象上传失败且远端内容不一致")
	}
	return verifyErr
}

func (publisher *Publisher) verifyRemote(
	ctx context.Context,
	objectKey string,
	expectedHash [32]byte,
	expectedSize int64,
) error {
	response, err := publisher.client.Object.Get(ctx, objectKey, nil)
	if err != nil || response == nil || response.Body == nil {
		return errors.New("无法验证 COS 远端制品")
	}
	defer response.Body.Close()
	digest := sha256.New()
	written, err := io.Copy(digest, io.LimitReader(response.Body, expectedSize+1))
	if err != nil || written != expectedSize {
		return errors.New("COS 远端制品大小不一致")
	}
	actual := digest.Sum(nil)
	if !equalDigest(actual, expectedHash) {
		return errors.New("COS 远端制品摘要不一致")
	}
	return nil
}

func verifyLocalFile(filename string, expectedHash [32]byte, expectedSize int64) error {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Size() != expectedSize {
		return errors.New("待发布制品大小或类型无效")
	}
	file, err := os.Open(filename)
	if err != nil {
		return errors.New("无法读取待发布制品")
	}
	defer file.Close()
	digest := sha256.New()
	written, err := io.Copy(digest, file)
	if err != nil || written != expectedSize || !equalDigest(digest.Sum(nil), expectedHash) {
		return errors.New("待发布制品摘要无效")
	}
	return nil
}

func equalDigest(actual []byte, expected [32]byte) bool {
	return len(actual) == len(expected) && string(actual) == string(expected[:])
}
