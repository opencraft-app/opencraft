package website

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"

	"github.com/tencentyun/cos-go-sdk-v5"
)

// defaultArtifactKeepVersions 是默认保留的制品版本数。
//
// 默认 1，也就是「只留最新一次发布的那一份」。做成可配置而不是硬编码 1：
// 将来想留历史版本只改配置不改代码。
//
// 为什么可以只留一份：制品 zip 原本唯一的用途是「套餐续费后从制品恢复站点」，
// 而生命周期改造后到期不再删除任何文件（只是网关不再对外服务），这个用途已经消失。
// 已确认没有任何代码路径依赖旧制品做回滚——ReleaseStatusRolledBack 这个状态在
// ctl 里定义了但从未被写入过，也没有从制品恢复某个历史版本的实现。
const defaultArtifactKeepVersions = 1

// artifactKeepVersions 返回要保留的制品版本数。
func artifactKeepVersions() int {
	return int(getPositiveInt64Env("WEBSITE_ARTIFACT_KEEP_VERSIONS", defaultArtifactKeepVersions))
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
// 两个前缀都算：sites/{siteID}/ 是线上文件（含发布中途留下的 releases/ 暂存目录），
// _artifacts/{siteID}/ 是制品 zip。它们都记在用户的存储额度上，因为都是用户上传的
// 内容在我们桶里实际占的空间。
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

// selectArtifactsToDelete 决定 _artifacts/{siteID}/ 下哪些 zip 该被删掉。
//
// keepKey 是本次发布的制品，无论如何都保留——它是当前线上内容的来源，
// 而 LastModified 在时钟回拨或重放场景下未必把它排在最前。
//
// 其余按 LastModified 倒序保留，凑满 keep 个为止。用修改时间而不是 key 排序：
// key 是 `wr-<随机 hex>.zip`，字典序和发布顺序毫无关系，按 key 排会随机删掉最新的那份。
//
// 这个函数不区分「新策略上线前积累的存量制品」和新产生的制品：它每次都对整个前缀
// 重新做一次判断。所以存量的多份历史 zip 会在该站点的**下一次发布**时一并收敛，
// 不需要额外的一次性清理脚本。
func selectArtifactsToDelete(objects []cos.Object, keepKey string, keep int) []string {
	if keep < 1 {
		keep = 1
	}

	candidates := make([]cos.Object, 0, len(objects))
	for _, object := range objects {
		if object.Key == "" || object.Key == keepKey {
			continue
		}
		candidates = append(candidates, object)
	}
	// 时间相同时按 key 倒序，只为让结果稳定可测——COS 的 LastModified 只到秒，
	// 同一秒内连发两次是完全可能的。
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].LastModified != candidates[j].LastModified {
			return candidates[i].LastModified > candidates[j].LastModified
		}
		return candidates[i].Key > candidates[j].Key
	})

	// keepKey 自己占掉一个名额。
	extra := keep - 1
	if extra > len(candidates) {
		extra = len(candidates)
	}
	if extra < 0 {
		extra = 0
	}

	victims := make([]string, 0, len(candidates)-extra)
	for _, object := range candidates[extra:] {
		victims = append(victims, object.Key)
	}
	return victims
}

// pruneSiteArtifacts 删除超出保留数的历史制品。
//
// 只在发布成功之后调用，且失败只告警：制品不在对外服务的路径上，清理失败只是
// 多占一点存储，不该让一次成功的发布被标记为失败。
func (d *Deployer) pruneSiteArtifacts(client *cosClient, siteID, keepReleaseID string) error {
	keep := artifactKeepVersions()
	prefix := fmt.Sprintf("_artifacts/%s/", siteID)
	objects, err := d.listCosObjects(client, prefix)
	if err != nil {
		return err
	}
	victims := selectArtifactsToDelete(objects, siteArtifactKey(siteID, keepReleaseID), keep)
	if len(victims) == 0 {
		return nil
	}

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
			return fmt.Errorf("delete stale artifacts (%s): %v", prefix, err)
		}
	}
	log.Printf("pruned %d stale artifact(s) for %s, keeping the newest %d", len(victims), siteID, keep)
	return nil
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
