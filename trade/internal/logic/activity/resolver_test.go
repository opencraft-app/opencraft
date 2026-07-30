// Package activity 单测：覆盖 Resolver 决策真值表（设计稿 §10.1）。
package activity

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/store"
)

// fakeActivityStore 是 store.ActivityStore 的 in-memory 测试替身。
//
// 单测不需要走真实 DB，所有判定全凭 fake 提供的 mapping / participation 集合。
type fakeActivityStore struct {
	bundles       map[string]*store.BundleActivity
	getErr        error
	participation map[string]bool // key = uin + "|" + activityID
	hasErr        error
	hasCalls      int
}

func newFakeActivityStore() *fakeActivityStore {
	return &fakeActivityStore{
		bundles:       map[string]*store.BundleActivity{},
		participation: map[string]bool{},
	}
}

func (f *fakeActivityStore) GetBundleActivityByBundleID(_ context.Context, bundleID string) (*store.BundleActivity, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	row, ok := f.bundles[bundleID]
	if !ok {
		return nil, store.ErrBundleActivityNotFound
	}
	return row, nil
}

func (f *fakeActivityStore) HasUserParticipated(_ context.Context, uin string, activityID int64) (bool, error) {
	f.hasCalls++
	if f.hasErr != nil {
		return false, f.hasErr
	}
	return f.participation[keyOf(uin, activityID)], nil
}

// InsertUserParticipation 满足 store.ActivityStore 接口；Resolver 不消费此方法，
// 单测中也不会被调用。签名严格匹配 store.ActivityStore 中的 *sql.Tx 入参。
func (f *fakeActivityStore) InsertUserParticipation(_ context.Context, _ *sql.Tx, _ *store.UserActivityParticipation) (int64, error) {
	return 0, errors.New("InsertUserParticipation not used in resolver tests")
}

// 编译期断言：fakeActivityStore 真实实现 store.ActivityStore 接口（避免再出 wrong-type 错）。
var _ store.ActivityStore = (*fakeActivityStore)(nil)

func keyOf(uin string, activityID int64) string {
	return uin + "|" + strconv.FormatInt(activityID, 10)
}

func TestResolver_NonActivityBundle(t *testing.T) {
	f := newFakeActivityStore()
	r := NewResolver(f)
	mapping, useDianshi, err := r.ResolveForInquiry(context.Background(), "bundle_other", "815836472", 1, "m")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if useDianshi {
		t.Errorf("non-activity bundle should not use dianshi")
	}
	if mapping != nil {
		t.Errorf("mapping should be nil for non-activity bundle, got %+v", mapping)
	}
}

func TestResolver_ActivityInactive(t *testing.T) {
	f := newFakeActivityStore()
	f.bundles["bundle_launch_01"] = &store.BundleActivity{
		BundleID: "bundle_launch_01", ActivityID: 164273735574009, ActID: 1862147936410255, Active: false,
	}
	r := NewResolver(f)
	mapping, useDianshi, err := r.ResolveForPlaceOrder(context.Background(), "bundle_launch_01", "815836472", 1, "m")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if useDianshi {
		t.Errorf("inactive activity should fall back to jifei")
	}
	if mapping == nil || mapping.ActivityID != 164273735574009 {
		t.Errorf("mapping should still be returned for log: %+v", mapping)
	}
}

func TestResolver_NotParticipated_UseDianshi(t *testing.T) {
	f := newFakeActivityStore()
	f.bundles["bundle_launch_01"] = &store.BundleActivity{
		BundleID: "bundle_launch_01", ActivityID: 164273735574009, ActID: 1862147936410255,
		SecretKey: "demo_secret", Active: true,
	}
	r := NewResolver(f)

	mapping, useDianshi, err := r.ResolveForInquiry(context.Background(), "bundle_launch_01", "815836472", 1, "m")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !useDianshi {
		t.Errorf("active activity + not participated should use dianshi")
	}
	if mapping == nil || mapping.SecretKey != "demo_secret" {
		t.Errorf("mapping fields wrong: %+v", mapping)
	}

	// 同样路径下 ResolveForPlaceOrder 行为应一致
	_, useDianshi2, err := r.ResolveForPlaceOrder(context.Background(), "bundle_launch_01", "815836472", 1, "m")
	if err != nil || !useDianshi2 {
		t.Errorf("ResolveForPlaceOrder should use dianshi too, useDianshi=%v err=%v", useDianshi2, err)
	}
}

func TestResolver_NotOneMonth_FallbackJifei(t *testing.T) {
	f := newFakeActivityStore()
	f.bundles["bundle_launch_01"] = &store.BundleActivity{
		BundleID: "bundle_launch_01", ActivityID: 164273735574009, ActID: 1862147936410255,
		SecretKey: "demo_secret", Active: true,
	}
	r := NewResolver(f)

	mapping, useDianshi, err := r.ResolveForInquiry(context.Background(), "bundle_launch_01", "815836472", 14, "d")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if useDianshi {
		t.Errorf("14d should fall back to jifei")
	}
	if mapping == nil || mapping.ActivityID != 164273735574009 {
		t.Errorf("mapping should still be returned for log: %+v", mapping)
	}
	if f.hasCalls != 0 {
		t.Errorf("participation should not be queried for non-1m request, calls=%d", f.hasCalls)
	}

	_, useDianshi, err = r.ResolveForPlaceOrder(context.Background(), "bundle_launch_01", "815836472", 2, "m")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if useDianshi {
		t.Errorf("2m should fall back to jifei")
	}
}

func TestResolver_AlreadyParticipated_FallbackJifei(t *testing.T) {
	f := newFakeActivityStore()
	f.bundles["bundle_launch_ai_01"] = &store.BundleActivity{
		BundleID: "bundle_launch_ai_01", ActivityID: 164273735574009, ActID: 1862105749386679, Active: true,
	}
	f.participation[keyOf("815836472", 164273735574009)] = true

	r := NewResolver(f)
	mapping, useDianshi, err := r.ResolveForInquiry(context.Background(), "bundle_launch_ai_01", "815836472", 1, "m")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if useDianshi {
		t.Errorf("already participated should fall back to jifei")
	}
	if mapping == nil {
		t.Fatal("mapping should still be returned for log")
	}
}

func TestResolver_DBError_BundleActivity(t *testing.T) {
	f := newFakeActivityStore()
	f.getErr = errors.New("db boom")
	r := NewResolver(f)
	_, _, err := r.ResolveForInquiry(context.Background(), "bundle_launch_01", "815836472", 1, "m")
	if err == nil {
		t.Fatal("expect db err")
	}
}

func TestResolver_DBError_Participation(t *testing.T) {
	f := newFakeActivityStore()
	f.bundles["bundle_launch_01"] = &store.BundleActivity{
		BundleID: "bundle_launch_01", ActivityID: 164273735574009, ActID: 1862147936410255, Active: true,
	}
	f.hasErr = errors.New("db boom")
	r := NewResolver(f)
	mapping, useDianshi, err := r.ResolveForInquiry(context.Background(), "bundle_launch_01", "815836472", 1, "m")
	if err == nil {
		t.Fatal("expect db err")
	}
	if useDianshi {
		t.Errorf("on db error must not return useDianshi=true")
	}
	if mapping == nil {
		t.Errorf("mapping should still be returned for log on participation db error")
	}
}

func TestResolver_RequiredArgs(t *testing.T) {
	f := newFakeActivityStore()
	r := NewResolver(f)
	if _, _, err := r.ResolveForInquiry(context.Background(), "", "815836472", 1, "m"); err == nil {
		t.Error("expect err on empty bundleID")
	}
	if _, _, err := r.ResolveForInquiry(context.Background(), "bundle_launch_01", "", 1, "m"); err == nil {
		t.Error("expect err on empty uin")
	}
}

func TestResolver_NilStore(t *testing.T) {
	r := NewResolver(nil)
	if _, _, err := r.ResolveForInquiry(context.Background(), "bundle_launch_01", "815836472", 1, "m"); err == nil {
		t.Error("expect err on nil store")
	}
}
