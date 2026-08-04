package schemaaudit

import (
	"errors"
	"strings"
	"testing"
)

func TestParseTopologyObservations接受TDSQL键值Status(t *testing.T) {
	observations, err := parseTopologyObservations(
		[]string{"status_name", "value"},
		[][][]byte{
			{[]byte("cluster"), []byte("opaque-cluster")},
			{[]byte("set_opaque_a:alias"), []byte("opaque-alias-a")},
			{[]byte("set_opaque_a:hash_range"), []byte("0-31")},
			{[]byte("set_opaque_b:alias"), []byte("opaque-alias-b")},
			{[]byte("set_opaque_b:hash_range"), []byte("32-63")},
		},
	)
	if err != nil {
		t.Fatalf("parseTopologyObservations() error = %v", err)
	}
	want := []TopologyObservation{
		{OpaqueID: "set_opaque_a", HashRange: "0-31"},
		{OpaqueID: "set_opaque_b", HashRange: "32-63"},
	}
	if len(observations) != len(want) {
		t.Fatalf("observations = %#v", observations)
	}
	for index := range want {
		if observations[index] != want[index] {
			t.Fatalf("observations[%d] = %#v, want %#v", index, observations[index], want[index])
		}
	}
}

func TestParseTopologyObservations保留行式Status并拒绝普通MySQL(t *testing.T) {
	observations, err := parseTopologyObservations(
		[]string{"set_id", "hash_range"},
		[][][]byte{
			{[]byte("opaque-a"), []byte("0-31")},
			{[]byte("opaque-b"), []byte("32-63")},
		},
	)
	if err != nil || len(observations) != 2 {
		t.Fatalf("row layout observations = %#v, error = %v", observations, err)
	}

	_, err = parseTopologyObservations(
		[]string{"Variable_name", "Value"},
		[][][]byte{{[]byte("Threads_connected"), []byte("1")}},
	)
	if !errors.Is(err, errTDSQLPlatformMismatch) {
		t.Fatalf("plain MySQL error = %v", err)
	}
}

func TestAllsetsQuery使用TDSQL文本协议且拒绝外部表名(t *testing.T) {
	query, err := allsetsQuery("account_login_identities")
	if err != nil {
		t.Fatalf("allsetsQuery() error = %v", err)
	}
	if strings.Contains(query, "?") {
		t.Fatalf("allsets query 不得使用 Proxy 无法追加 info 列的预处理参数：%s", query)
	}
	if !strings.HasPrefix(query, "/*sets:allsets*/") {
		t.Fatalf("TDSQL 路由注释必须位于 SQL 第一个字节：%q", query)
	}
	if !strings.Contains(query, "table_name = 'account_login_identities'") {
		t.Fatalf("allsets query 没有安全内联物理表名：%s", query)
	}
	for _, invalid := range []string{"", "Accounts", "accounts;drop", "accounts'"} {
		if _, err := allsetsQuery(invalid); err == nil {
			t.Fatalf("allsetsQuery(%q) 应失败", invalid)
		}
	}
}
