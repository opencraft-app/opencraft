// Package cos 使用腾讯云官方 Go SDK 为私有安装制品生成短期 GET 地址。
package cos

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	cosSDK "github.com/tencentyun/cos-go-sdk-v5"
)

var (
	bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}-[0-9]{5,}$`)
	regionPattern = regexp.MustCompile(`^[a-z]+-[a-z]+[0-9]*$`)
)

type Config struct {
	Bucket        string
	Region        string
	SecretID      string
	SecretKey     string
	SecurityToken string
}

type Signer struct {
	client        *cosSDK.Client
	secretID      string
	secretKey     string
	securityToken string
}

func NewSigner(config Config) (*Signer, error) {
	endpoint, err := endpointFor(config)
	if err != nil {
		return nil, err
	}
	return &Signer{
		client:   cosSDK.NewClient(&cosSDK.BaseURL{BucketURL: endpoint}, &http.Client{}),
		secretID: config.SecretID, secretKey: config.SecretKey,
		securityToken: config.SecurityToken,
	}, nil
}

func endpointFor(config Config) (*url.URL, error) {
	config.Bucket = strings.TrimSpace(config.Bucket)
	config.Region = strings.TrimSpace(config.Region)
	if !bucketPattern.MatchString(config.Bucket) ||
		!regionPattern.MatchString(config.Region) ||
		strings.TrimSpace(config.SecretID) == "" || strings.TrimSpace(config.SecretKey) == "" ||
		strings.ContainsAny(config.SecretID+config.SecretKey+config.SecurityToken, "\r\n\x00") {
		return nil, errors.New("COS 配置无效")
	}
	endpoint, err := url.Parse(
		"https://" + config.Bucket + ".cos." + config.Region + ".myqcloud.com",
	)
	if err != nil {
		return nil, errors.New("COS endpoint 无效")
	}
	return endpoint, nil
}

func (signer *Signer) PresignGet(
	ctx context.Context,
	objectKey string,
	ttl time.Duration,
) (string, error) {
	if signer == nil || signer.client == nil || ctx == nil ||
		!validObjectKey(objectKey) || ttl <= 0 || ttl > 5*time.Minute {
		return "", errors.New("COS 预签名参数无效")
	}
	var options any
	if signer.securityToken != "" {
		query := make(url.Values)
		query.Set("x-cos-security-token", signer.securityToken)
		options = &cosSDK.PresignedURLOptions{Query: &query}
	}
	signed, err := signer.client.Object.GetPresignedURL(
		ctx,
		http.MethodGet,
		objectKey,
		signer.secretID,
		signer.secretKey,
		ttl,
		options,
		true,
	)
	if err != nil {
		return "", errors.New("COS 预签名失败")
	}
	return signed.String(), nil
}

func validObjectKey(value string) bool {
	return value != "" && !strings.HasPrefix(value, "/") &&
		path.Clean(value) == value && value != "." &&
		!strings.Contains(value, "..") &&
		!strings.ContainsAny(value, "\r\n\x00")
}
