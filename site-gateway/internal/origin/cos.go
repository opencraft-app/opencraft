package origin

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

type COSOptions struct {
	Bucket    string
	Region    string
	SecretID  string
	SecretKey string
	Timeout   time.Duration
	// MaxIdleConnsPerHost 控制到 COS 的长连接复用。站点资源请求量远大于业务
	// 接口，默认值（2）会导致大量连接反复建立，必须调高。
	MaxIdleConnsPerHost int
}

// COSFetcher 从单个 COS 桶读取对象。
//
// 所有用户站点共用这一个桶，按 sites/{siteID}/ 前缀分租户；key 由服务端拼接，
// 请求方无法影响前缀部分。
type COSFetcher struct {
	client *cos.Client
}

func NewCOSFetcher(opts COSOptions) (*COSFetcher, error) {
	if opts.Bucket == "" || opts.Region == "" {
		return nil, fmt.Errorf("bucket and region are required")
	}
	if opts.SecretID == "" || opts.SecretKey == "" {
		return nil, fmt.Errorf("cos credentials are required")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 10 * time.Second
	}
	if opts.MaxIdleConnsPerHost <= 0 {
		opts.MaxIdleConnsPerHost = 100
	}

	bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", opts.Bucket, opts.Region))
	if err != nil {
		return nil, fmt.Errorf("build bucket url: %w", err)
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = opts.MaxIdleConnsPerHost * 2
	transport.MaxIdleConnsPerHost = opts.MaxIdleConnsPerHost

	client := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{
		Timeout: opts.Timeout,
		Transport: &cos.AuthorizationTransport{
			SecretID:  opts.SecretID,
			SecretKey: opts.SecretKey,
			Transport: transport,
		},
	})
	return &COSFetcher{client: client}, nil
}

func (f *COSFetcher) Get(ctx context.Context, key string) (*Object, error) {
	resp, err := f.client.Object.Get(ctx, key, nil)
	if err != nil {
		if cos.IsNotFoundError(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get object %q: %w", key, err)
	}
	// COS 对不存在的对象返回 404，SDK 会转成错误；这里再兜一层，避免把
	// 非 2xx 的响应体当作站点内容返回给用户。
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, fmt.Errorf("get object %q: unexpected status %d", key, resp.StatusCode)
	}

	return &Object{
		Body:          resp.Body,
		ContentType:   resp.Header.Get("Content-Type"),
		ContentLength: resp.ContentLength,
		ETag:          strings.TrimSpace(resp.Header.Get("ETag")),
		LastModified:  resp.Header.Get("Last-Modified"),
		CacheControl:  resp.Header.Get("Cache-Control"),
	}, nil
}
