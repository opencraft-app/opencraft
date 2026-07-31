package website

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

// Deployer 部署执行器
type Deployer struct {
	ctlBaseURL  string
	httpClient  *http.Client
	artifactCos *cosClient
	siteCos     *cosClient
}

type cosClient struct {
	bucket string
	region string
	client *cos.Client
}

func NewDeployer() *Deployer {
	d := &Deployer{
		ctlBaseURL: getEnv("CTL_BASE_URL", "http://ctl-api.ctl.svc.cluster.local"),
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
	// 制品COS（下载用）
	d.artifactCos = newCosClient(
		getEnv("WEBSITE_COS_BUCKET", ""),
		getEnv("WEBSITE_COS_REGION", ""),
		getEnv("WEBSITE_COS_SECRET_ID", ""),
		getEnv("WEBSITE_COS_SECRET_KEY", ""),
	)
	// CloudBase静态托管COS（上传/删除用）
	d.siteCos = newCosClient(
		getEnv("CLOUDBASE_STATIC_COS_BUCKET", ""),
		getEnv("CLOUDBASE_STATIC_COS_REGION", ""),
		getEnv("CLOUDBASE_STATIC_COS_SECRET_ID", ""),
		getEnv("CLOUDBASE_STATIC_COS_SECRET_KEY", ""),
	)
	return d
}

func newCosClient(bucket, region, secretID, secretKey string) *cosClient {
	if bucket == "" || region == "" || secretID == "" || secretKey == "" {
		return nil
	}
	u, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", bucket, region))
	if err != nil {
		return nil
	}
	return &cosClient{
		bucket: bucket,
		region: region,
		client: cos.NewClient(&cos.BaseURL{BucketURL: u}, &http.Client{}),
	}
}

// PollOperations 轮询待执行操作
func (d *Deployer) PollOperations() ([]Operation, error) {
	resp, err := d.httpClient.Get(d.ctlBaseURL + "/internal/ctl/websites/operations?status=created")
	if err != nil {
		return nil, fmt.Errorf("poll operations: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("poll operations status %d", resp.StatusCode)
	}

	var result struct {
		Code string `json:"code"`
		Data struct {
			Operations []Operation `json:"operations"`
			Count      int         `json:"count"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode operations: %w", err)
	}
	return result.Data.Operations, nil
}

// Execute 执行一个操作
func (d *Deployer) Execute(op Operation) error {
	switch op.OperationType {
	case "create":
		return d.executeCreate(op)
	case "deploy":
		return d.executeDeploy(op)
	case "delete":
		return d.executeDelete(op)
	default:
		return fmt.Errorf("unknown operation type: %s", op.OperationType)
	}
}

// executeCreate 创建站点 — 一期只标记成功，目录在deploy时创建
func (d *Deployer) executeCreate(op Operation) error {
	cloudPath := fmt.Sprintf("sites/%s/releases/", op.SiteID)
	publicURL := fmt.Sprintf("/s/%s/", op.SiteID)
	return d.completeOperation(op.OperationID, cloudPath, publicURL)
}

// executeDeploy 部署站点 — 从COS下载制品→解压→上传到CloudBase静态托管COS
func (d *Deployer) executeDeploy(op Operation) error {
	if d.artifactCos == nil {
		return d.failOperation(op.OperationID, "artifact COS not configured")
	}
	if d.siteCos == nil {
		return d.failOperation(op.OperationID, "site COS not configured")
	}

	// 1. 从制品COS下载zip
	artifactKey := fmt.Sprintf("website-artifacts/%s/%s.zip", op.SiteID, op.ReleaseID)
	resp, err := d.artifactCos.client.Object.Get(context.Background(), artifactKey, nil)
	if err != nil {
		return d.failOperation(op.OperationID, fmt.Sprintf("download artifact: %v", err))
	}
	defer resp.Body.Close()
	zipData, err := io.ReadAll(resp.Body)
	if err != nil {
		return d.failOperation(op.OperationID, fmt.Sprintf("read artifact: %v", err))
	}

	// 2. 解压并上传到CloudBase COS
	prefix := fmt.Sprintf("sites/%s/releases/%s/", op.SiteID, op.ReleaseID)
	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return d.failOperation(op.OperationID, fmt.Sprintf("unzip artifact: %v", err))
	}

	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() || strings.HasSuffix(file.Name, "/") {
			continue
		}
		rc, err := file.Open()
		if err != nil {
			return d.failOperation(op.OperationID, fmt.Sprintf("open zip entry %s: %v", file.Name, err))
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return d.failOperation(op.OperationID, fmt.Sprintf("read zip entry %s: %v", file.Name, err))
		}

		// 安全：清理路径，防止路径穿越
		cleanName := strings.TrimPrefix(filepath.Clean("/"+file.Name), "/")
		cosKey := prefix + cleanName

		_, err = d.siteCos.client.Object.Put(context.Background(), cosKey, bytes.NewReader(content), nil)
		if err != nil {
			return d.failOperation(op.OperationID, fmt.Sprintf("upload %s: %v", cosKey, err))
		}
	}

	// 3. 回调ctl标记成功
	cloudPath := prefix
	publicURL := fmt.Sprintf("/s/%s/", op.SiteID)
	return d.completeOperation(op.OperationID, cloudPath, publicURL)
}

// executeDelete 删除站点 — 清理CloudBase COS上的所有文件
func (d *Deployer) executeDelete(op Operation) error {
	if d.siteCos == nil {
		// COS未配置，直接标记成功（测试环境兼容）
		return d.completeOperation(op.OperationID, "", "")
	}

	prefix := fmt.Sprintf("sites/%s/", op.SiteID)

	// 列出并批量删除
	var marker string
	for {
		opt := &cos.BucketGetOptions{
			Prefix:  prefix,
			MaxKeys: 1000,
		}
		if marker != "" {
			opt.Marker = marker
		}
		result, _, err := d.siteCos.client.Bucket.Get(context.Background(), opt)
		if err != nil {
			return d.failOperation(op.OperationID, fmt.Sprintf("list objects: %v", err))
		}

		if len(result.Contents) == 0 {
			break
		}

		// 批量删除
		var objects []cos.Object
		for _, item := range result.Contents {
			objects = append(objects, cos.Object{Key: item.Key})
		}
		_, _, err = d.siteCos.client.Object.DeleteMulti(context.Background(), &cos.ObjectDeleteMultiOptions{Objects: objects})
		if err != nil {
			return d.failOperation(op.OperationID, fmt.Sprintf("batch delete: %v", err))
		}

		if !result.IsTruncated {
			break
		}
		marker = result.NextMarker
	}

	return d.completeOperation(op.OperationID, "", "")
}

// completeOperation 回调ctl标记操作成功
func (d *Deployer) completeOperation(opID, cloudPath, publicURL string) error {
	body, _ := json.Marshal(map[string]string{
		"cloud_path": cloudPath,
		"public_url": publicURL,
	})
	resp, err := d.httpClient.Post(
		d.ctlBaseURL+"/internal/ctl/websites/operations/"+opID+"/complete",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("complete operation status %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// failOperation 回调ctl标记操作失败
func (d *Deployer) failOperation(opID, errMsg string) error {
	body, _ := json.Marshal(map[string]string{
		"error_message": errMsg,
	})
	resp, err := d.httpClient.Post(
		d.ctlBaseURL+"/internal/ctl/websites/operations/"+opID+"/fail",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("fail operation: %w", err)
	}
	defer resp.Body.Close()
	return nil
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
