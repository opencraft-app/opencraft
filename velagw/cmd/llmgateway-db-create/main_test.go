package main

import "testing"

func TestMySQLAdminConfigAllowsTencentCloudNativePassword(t *testing.T) {
	config := mysqlAdminConfig("mysql.internal", "3306", "root", "secret")

	if !config.AllowNativePasswords {
		t.Fatal("database bootstrap must allow the mysql_native_password plugin used by Tencent Cloud MySQL")
	}
}
