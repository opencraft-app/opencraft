package tdsqlddl

import (
	"strings"
	"testing"
)

func TestMySQLStorageRemovesOnlyPhysicalShardOption(t *testing.T) {
	input := "CREATE TABLE `sample` (`server_id` varchar(64) NOT NULL, `id` varchar(64) NOT NULL, `note` varchar(64) DEFAULT 'shardkey=`keep`', PRIMARY KEY (`server_id`, `id`)) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`server_id`"
	output, err := WithoutPhysicalSharding(input)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "DEFAULT 'shardkey=`keep`'") || !strings.Contains(output, "PRIMARY KEY (`server_id`, `id`)") || strings.HasSuffix(output, "shardkey=`server_id`") {
		t.Fatal("MySQL adaptation changed logical content or retained physical sharding")
	}
}
