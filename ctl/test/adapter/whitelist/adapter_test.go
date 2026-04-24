package whitelist

import (
	"testing"

	"ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/whitelist"
	"ctl/pkg/util"
	"ctl/test"
)

func init() {
	test.InitTestResource()
}

// checkUinInWhitelist 检查指定uin是否在指定白名单类型中
func checkUinInWhitelist(
	t *testing.T,
	resp whitelist.QConfigBatchGetWhiteListData,
	uin, whitelistType string,
	shouldExist bool,
) {
	if uinList, exists := resp[whitelistType]; exists {
		found := util.Contains(uinList, uin)
		if found == shouldExist {
			t.Logf("✓ %s in %s whitelist: %v", uin, whitelistType, shouldExist)
		} else if shouldExist {
			t.Errorf("Expected %s to be in %s whitelist", uin, whitelistType)
		} else {
			t.Errorf("Expected %s NOT to be in %s whitelist", uin, whitelistType)
		}
	} else {
		// 没有该白名单类型，所有用户都不在该白名单
		if shouldExist {
			t.Errorf("Expected %s to be in %s whitelist, but whitelist type not found", uin, whitelistType)
		} else {
			t.Logf("✓ %s whitelist not found, %s not in whitelist (as expected)", whitelistType, uin)
		}
	}
}

func TestQConfigBatchGetWhiteList(t *testing.T) {
	t.Skip("external whitelist integration test")

	ctx := &whitelist.Context{
		Context: test.Context(),
	}

	typeList := []string{"LIGHTHOUSE_IPV6_GZ", "NOT_EXISTS_WHITELIST_XX"}
	whiteListItems := []string{"75092499", "11112222"}

	adapter := factory.DefaultAdapterFactory.WhitelistAdapter()
	resp, err := adapter.QConfigBatchGetWhiteList(ctx, typeList, whiteListItems)
	if err != nil {
		t.Logf("QConfigBatchGetWhiteList error: %v", err)
		return
	}

	t.Logf("QConfigBatchGetWhiteList response: %+v", resp)

	if resp == nil {
		t.Error("Expected Results to be non-nil")
		return
	}

	// 验证白名单结果
	checkUinInWhitelist(t, resp, "75092499", "LIGHTHOUSE_IPV6_GZ", true) // 75092499 应该在 LIGHTHOUSE_IPV6_GZ 中
	checkUinInWhitelist(
		t,
		resp,
		"75092499",
		"NOT_EXISTS_WHITELIST_XX",
		false,
	) // 75092499 不应该在 NOT_EXISTS_WHITELIST_XX 中
	checkUinInWhitelist(t, resp, "11112222", "LIGHTHOUSE_IPV6_GZ", false) // 11112222 不应该在 LIGHTHOUSE_IPV6_GZ 中
	checkUinInWhitelist(
		t,
		resp,
		"11112222",
		"NOT_EXISTS_WHITELIST_XX",
		false,
	) // 11112222 不应该在 NOT_EXISTS_WHITELIST_XX 中
}
