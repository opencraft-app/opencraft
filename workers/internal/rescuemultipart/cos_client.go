package rescuemultipart

import (
	"bytes"
	"context"
	"errors"

	cos "github.com/tencentyun/cos-go-sdk-v5"
)

type COSClient struct {
	client    *cos.Client
	objectKey string
	uploadID  string
}

func NewCOSClient(client *cos.Client, objectKey, uploadID string) (*COSClient, error) {
	if client == nil {
		return nil, errors.New("COS SDK client is required")
	}
	if objectKey == "" {
		return nil, errors.New("COS object key is required")
	}
	if uploadID == "" {
		return nil, errors.New("COS multipart upload ID is required")
	}
	return &COSClient{client: client, objectKey: objectKey, uploadID: uploadID}, nil
}

func (c *COSClient) UploadPart(ctx context.Context, number int, data []byte) (string, error) {
	response, err := c.client.Object.UploadPart(
		ctx,
		c.objectKey,
		c.uploadID,
		number,
		bytes.NewReader(data),
		&cos.ObjectUploadPartOptions{ContentLength: int64(len(data))},
	)
	if err != nil {
		return "", err
	}
	return response.Header.Get("ETag"), nil
}

func (c *COSClient) Complete(ctx context.Context, parts []CompletedPart) error {
	completed := make([]cos.Object, 0, len(parts))
	for _, part := range parts {
		completed = append(completed, cos.Object{PartNumber: part.Number, ETag: part.ETag})
	}
	_, _, err := c.client.Object.CompleteMultipartUpload(
		ctx,
		c.objectKey,
		c.uploadID,
		&cos.CompleteMultipartUploadOptions{Parts: completed},
	)
	return err
}
