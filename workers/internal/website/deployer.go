package website

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// Deployer 部署执行器
type Deployer struct {
	ctlBaseURL    string
	cloudbaseEnvID string
	httpClient    *http.Client
}

func NewDeployer() *Deployer {
	return &Deployer{
		ctlBaseURL:    getEnv("CTL_BASE_URL", "http://ctl-api.ctl.svc.cluster.local"),
		cloudbaseEnvID: getEnv("CLOUDBASE_STATIC_ENV_ID", ""),
		httpClient:    &http.Client{Timeout: 30 * time.Second},
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
		Operations []Operation `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode operations: %w", err)
	}
	return result.Operations, nil
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

// executeCreate 创建站点 — 在CloudBase创建目录结构
func (d *Deployer) executeCreate(op Operation) error {
	// 一期：create操作只需标记成功（目录在deploy时创建）
	cloudPath := fmt.Sprintf("sites/%s/releases/", op.SiteID)
	publicURL := fmt.Sprintf("/s/%s/", op.SiteID)
	return d.completeOperation(op.OperationID, cloudPath, publicURL)
}

// executeDeploy 部署站点 — 下载制品并部署到CloudBase静态托管
func (d *Deployer) executeDeploy(op Operation) error {
	if d.cloudbaseEnvID == "" {
		return d.failOperation(op.OperationID, "CLOUDBASE_STATIC_ENV_ID not configured")
	}

	// TODO: 一期实现
	// 1. 从 COS 下载制品 zip
	// 2. 解压到临时目录
	// 3. 调用 CloudBase 管理 API 上传文件到静态托管
	// 4. 回调 ctl complete

	// 临时占位：直接标记成功
	cloudPath := fmt.Sprintf("sites/%s/releases/%s/", op.SiteID, op.ReleaseID)
	publicURL := fmt.Sprintf("/s/%s/", op.SiteID)
	return d.completeOperation(op.OperationID, cloudPath, publicURL)
}

// executeDelete 删除站点 — 清理CloudBase上的文件
func (d *Deployer) executeDelete(op Operation) error {
	// TODO: 调用 CloudBase 管理 API 删除 sites/{siteId}/ 下的所有文件
	// 临时占位：直接标记成功
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
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("complete operation status %d: %s", resp.StatusCode, string(body))
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
