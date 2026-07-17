package runtimecleanup

import "testing"

func TestValidateTargetAcceptsDedicatedSetRuntime(t *testing.T) {
	err := ValidateTarget(Target{DatabaseName: "newapi_set_auto_000123", RedisDB: 17, RedisDBStart: 10, RedisDBLimit: 32})
	if err != nil {
		t.Fatal(err)
	}
}

func TestValidateTargetRejectsUnsafeDatabaseNames(t *testing.T) {
	for _, database := range []string{"mysql", "newapi-set-a", "newapi_set_a` DROP DATABASE mysql", ""} {
		err := ValidateTarget(Target{DatabaseName: database, RedisDB: 17, RedisDBStart: 10, RedisDBLimit: 32})
		if err == nil {
			t.Fatalf("database %q should be rejected", database)
		}
	}
}

func TestValidateTargetRejectsRedisDBOutsideFrozenRange(t *testing.T) {
	for _, redisDB := range []int{9, 42} {
		err := ValidateTarget(Target{DatabaseName: "newapi_set_a", RedisDB: redisDB, RedisDBStart: 10, RedisDBLimit: 32})
		if err == nil {
			t.Fatalf("redis db %d should be rejected", redisDB)
		}
	}
}
