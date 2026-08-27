package website

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/tencentyun/cos-go-sdk-v5"
)

// selectReleaseObjectsToDelete keeps the candidate and the exact cloud_path
// that CTL says is currently active. COS timestamps are not activation order:
// retries and failed candidates can have newer timestamps than the real previous
// release, so timestamp-based retention can preserve the wrong generation.
func selectReleaseObjectsToDelete(objects []cos.Object, basePrefix, candidatePrefix, previousActivePrefix string) []string {
	keep := map[string]struct{}{}
	for _, prefix := range []string{candidatePrefix, previousActivePrefix} {
		if isDirectChildPrefix(basePrefix, prefix) {
			keep[prefix] = struct{}{}
		}
	}

	victims := make([]string, 0)
	for _, object := range objects {
		if object.Key == "" || !strings.HasPrefix(object.Key, basePrefix) {
			continue
		}
		retained := false
		for prefix := range keep {
			if strings.HasPrefix(object.Key, prefix) {
				retained = true
				break
			}
		}
		if !retained {
			victims = append(victims, object.Key)
		}
	}
	return victims
}

func isDirectChildPrefix(basePrefix, prefix string) bool {
	if !strings.HasPrefix(prefix, basePrefix) || !strings.HasSuffix(prefix, "/") {
		return false
	}
	segment := strings.TrimSuffix(strings.TrimPrefix(prefix, basePrefix), "/")
	if segment == "" || strings.Contains(segment, "/") {
		return false
	}
	for _, char := range segment {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '-' && char != '_' {
			return false
		}
	}
	return true
}

func (d *Deployer) pruneSiteReleases(client *cosClient, siteID, candidateReleaseID, previousActivePrefix string) error {
	basePrefix := fmt.Sprintf("sites/%s/releases/", siteID)
	candidatePrefix := siteReleasePrefix(siteID, candidateReleaseID)
	objects, err := d.listCosObjects(client, basePrefix)
	if err != nil {
		return err
	}
	victims := selectReleaseObjectsToDelete(objects, basePrefix, candidatePrefix, previousActivePrefix)
	for start := 0; start < len(victims); start += 1000 {
		end := start + 1000
		if end > len(victims) {
			end = len(victims)
		}
		batch := make([]cos.Object, 0, end-start)
		for _, key := range victims[start:end] {
			batch = append(batch, cos.Object{Key: key})
		}
		if _, _, err := client.client.Object.DeleteMulti(context.Background(),
			&cos.ObjectDeleteMultiOptions{Objects: batch}); err != nil {
			return fmt.Errorf("delete stale releases (%s): %v", basePrefix, err)
		}
	}
	return nil
}

// listCosObjects 列出指定前缀下的所有对象（含大小与修改时间）。
func (d *Deployer) listCosObjects(client *cosClient, prefix string) ([]cos.Object, error) {
	var objects []cos.Object
	var marker string
	for {
		opt := &cos.BucketGetOptions{Prefix: prefix, MaxKeys: 1000}
		if marker != "" {
			opt.Marker = marker
		}
		result, _, err := client.client.Bucket.Get(context.Background(), opt)
		if err != nil {
			return nil, fmt.Errorf("list objects (%s): %v", prefix, err)
		}
		objects = append(objects, result.Contents...)
		if !result.IsTruncated {
			return objects, nil
		}
		marker = result.NextMarker
	}
}

// siteStorageBytes 统计站点当前占用的字节数。
//
// 两个前缀都算：sites/{siteID}/ 是保留的不可变 release，_artifacts/{siteID}/
// 是发布中的临时 zip。成功发布会先删除本次 zip 再调用这里；若历史清理失败仍有临时
// 对象残留，它们也按实际占用计入额度，直到代码重试或桶生命周期清理。
func (d *Deployer) siteStorageBytes(client *cosClient, siteID string) (int64, error) {
	var total int64
	for _, prefix := range []string{
		fmt.Sprintf("sites/%s/", siteID),
		fmt.Sprintf("_artifacts/%s/", siteID),
	} {
		objects, err := d.listCosObjects(client, prefix)
		if err != nil {
			return 0, err
		}
		total += sumObjectSizes(objects)
	}
	return total, nil
}

func sumObjectSizes(objects []cos.Object) int64 {
	var total int64
	for _, object := range objects {
		if object.Size > 0 {
			total += object.Size
		}
	}
	return total
}

// reportSiteStorage 把站点当前的存储用量回填给 ctl。
//
// 上报绝对值而不是增量：deployer 每次都重新列一遍全部对象，所以覆盖式写入天然幂等，
// 重试不会让用量翻倍。这一点和流量上报正好相反——那边只有增量可用。
//
// 为什么事件驱动就够：文件永久保留，用量只在「发布成功」和「删除完成」这两个时刻
// 变化，不发布就不变。定时全桶扫描在这个模型下只是把同一个数字重算一遍。
func (d *Deployer) reportSiteStorage(siteID string, storageBytes int64) error {
	body, _ := json.Marshal(map[string]int64{"storage_bytes": storageBytes})
	req, err := d.newInternalRequest(http.MethodPost,
		fmt.Sprintf("%s/internal/ctl/websites/sites/%s/storage", d.ctlBaseURL, siteID),
		bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("report storage request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("report storage usage: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("report storage usage status %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// refreshSiteStorage 重算并上报站点存储用量。
//
// 全程只告警不失败：用量是给用户看的近似值和存储额度的判据，让它把一次成功的发布
// 或删除翻转成失败是明显更差的取舍——发布失败用户会立刻看到，用量晚一轮更新
// 则要等到下次发布才自然纠正。
func (d *Deployer) refreshSiteStorage(client *cosClient, siteID string) {
	if client == nil || siteID == "" {
		return
	}
	total, err := d.siteStorageBytes(client, siteID)
	if err != nil {
		log.Printf("warning: compute storage usage for %s failed: %v", siteID, err)
		return
	}
	if err := d.reportSiteStorage(siteID, total); err != nil {
		log.Printf("warning: report storage usage for %s failed: %v", siteID, err)
	}
}
