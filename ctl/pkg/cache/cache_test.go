package cache

import (
	"testing"

	"ctl/test"
)

func init() {
	test.InitTestResource()
}

// 用于测试的结构体
type TestData struct {
	Name  string `json:"name"`
	Age   int    `json:"age"`
	Email string `json:"email"`
}

func TestCache_SetAndGet(t *testing.T) {
	// 创建缓存实例
	cache := New()

	// 测试数据
	testKey := "test:user:1"
	testData := TestData{
		Name:  "张三",
		Age:   25,
		Email: "zhangsan@example.com",
	}

	// 测试 Set
	err := cache.Set(testKey, testData, 60) // 60秒过期
	if err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	// 测试 Get
	var result TestData
	found, err := cache.Get(testKey, &result)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if !found {
		t.Fatal("Key not found")
	}

	// 验证数据
	if result.Name != testData.Name {
		t.Errorf("Name mismatch: expected %s, got %s", testData.Name, result.Name)
	}
	if result.Age != testData.Age {
		t.Errorf("Age mismatch: expected %d, got %d", testData.Age, result.Age)
	}
	if result.Email != testData.Email {
		t.Errorf("Email mismatch: expected %s, got %s", testData.Email, result.Email)
	}
}

func TestCache_GetNonExistentKey(t *testing.T) {
	cache := New()

	var result TestData
	found, err := cache.Get("non-existent-key", &result)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if found {
		t.Fatal("Expected key not to be found")
	}
}

func TestCache_SetWithoutExpiry(t *testing.T) {
	cache := New()

	testKey := "test:permanent"
	testData := "这是一个永久缓存"

	// 设置不过期的缓存
	err := cache.Set(testKey, testData, 0)
	if err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	// 获取缓存
	var result string
	found, err := cache.Get(testKey, &result)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if !found {
		t.Fatal("Key not found")
	}

	if result != testData {
		t.Errorf("Data mismatch: expected %s, got %s", testData, result)
	}
}

func TestCache_SetAndGetInt(t *testing.T) {
	cache := New()

	testKey := "test:int"
	testData := 12345

	// 设置整数缓存
	err := cache.Set(testKey, testData, 60)
	if err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	// 获取整数缓存
	var result int
	found, err := cache.Get(testKey, &result)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if !found {
		t.Fatal("Key not found")
	}

	if result != testData {
		t.Errorf("Data mismatch: expected %d, got %d", testData, result)
	}
}

func TestCache_SetAndGetFloat(t *testing.T) {
	cache := New()

	testKey := "test:float"
	testData := 123.456

	// 设置浮点数缓存
	err := cache.Set(testKey, testData, 60)
	if err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	// 获取浮点数缓存
	var result float64
	found, err := cache.Get(testKey, &result)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if !found {
		t.Fatal("Key not found")
	}

	if result != testData {
		t.Errorf("Data mismatch: expected %f, got %f", testData, result)
	}
}

func TestCache_SetAndGetBool(t *testing.T) {
	cache := New()

	// 测试 true 值
	testKey1 := "test:bool:true"
	testData1 := true

	err := cache.Set(testKey1, testData1, 60)
	if err != nil {
		t.Fatalf("Set true failed: %v", err)
	}

	var result1 bool
	found1, err := cache.Get(testKey1, &result1)
	if err != nil {
		t.Fatalf("Get true failed: %v", err)
	}

	if !found1 {
		t.Fatal("True key not found")
	}

	if result1 != testData1 {
		t.Errorf("True data mismatch: expected %t, got %t", testData1, result1)
	}

	// 测试 false 值
	testKey2 := "test:bool:false"
	testData2 := false

	err = cache.Set(testKey2, testData2, 60)
	if err != nil {
		t.Fatalf("Set false failed: %v", err)
	}

	var result2 bool
	found2, err := cache.Get(testKey2, &result2)
	if err != nil {
		t.Fatalf("Get false failed: %v", err)
	}

	if !found2 {
		t.Fatal("False key not found")
	}

	if result2 != testData2 {
		t.Errorf("False data mismatch: expected %t, got %t", testData2, result2)
	}
}

func TestCache_SetAndGetString(t *testing.T) {
	cache := New()

	// 测试普通字符串
	testKey1 := "test:string:normal"
	testData1 := "这是一个普通字符串"

	err := cache.Set(testKey1, testData1, 60)
	if err != nil {
		t.Fatalf("Set normal string failed: %v", err)
	}

	var result1 string
	found1, err := cache.Get(testKey1, &result1)
	if err != nil {
		t.Fatalf("Get normal string failed: %v", err)
	}

	if !found1 {
		t.Fatal("Normal string key not found")
	}

	if result1 != testData1 {
		t.Errorf("Normal string data mismatch: expected %s, got %s", testData1, result1)
	}

	// 测试包含特殊字符的字符串
	testKey2 := "test:string:special"
	testData2 := "包含特殊字符: @#$%^&*()_+{}|:<>?[]\\;'\",./"

	err = cache.Set(testKey2, testData2, 60)
	if err != nil {
		t.Fatalf("Set special string failed: %v", err)
	}

	var result2 string
	found2, err := cache.Get(testKey2, &result2)
	if err != nil {
		t.Fatalf("Get special string failed: %v", err)
	}

	if !found2 {
		t.Fatal("Special string key not found")
	}

	if result2 != testData2 {
		t.Errorf("Special string data mismatch: expected %s, got %s", testData2, result2)
	}

	// 测试空字符串
	testKey3 := "test:string:empty"
	testData3 := ""

	err = cache.Set(testKey3, testData3, 60)
	if err != nil {
		t.Fatalf("Set empty string failed: %v", err)
	}

	var result3 string
	found3, err := cache.Get(testKey3, &result3)
	if err != nil {
		t.Fatalf("Get empty string failed: %v", err)
	}

	if !found3 {
		t.Fatal("Empty string key not found")
	}

	if result3 != testData3 {
		t.Errorf("Empty string data mismatch: expected '%s', got '%s'", testData3, result3)
	}
}

func TestCache_SetAndGetSlice(t *testing.T) {
	cache := New()

	testKey := "test:slice"
	testData := []string{"苹果", "香蕉", "橙子", "葡萄"}

	// 设置切片缓存
	err := cache.Set(testKey, testData, 60)
	if err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	// 获取切片缓存
	var result []string
	found, err := cache.Get(testKey, &result)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if !found {
		t.Fatal("Key not found")
	}

	if len(result) != len(testData) {
		t.Fatalf("Slice length mismatch: expected %d, got %d", len(testData), len(result))
	}

	for i, v := range testData {
		if result[i] != v {
			t.Errorf("Slice element mismatch at index %d: expected %s, got %s", i, v, result[i])
		}
	}
}

func TestCache_SetAndGetMap(t *testing.T) {
	cache := New()

	testKey := "test:map"
	testData := map[string]any{
		"name":    "张三",
		"age":     25,
		"married": true,
		"score":   88.5,
		"hobbies": []string{"读书", "游泳", "编程"},
	}

	// 设置映射缓存
	err := cache.Set(testKey, testData, 60)
	if err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	// 获取映射缓存
	var result map[string]any
	found, err := cache.Get(testKey, &result)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if !found {
		t.Fatal("Key not found")
	}

	if result["name"] != testData["name"] {
		t.Errorf("Name mismatch: expected %v, got %v", testData["name"], result["name"])
	}

	// JSON 反序列化后，数字类型会变成 float64
	if result["age"].(float64) != float64(testData["age"].(int)) {
		t.Errorf("Age mismatch: expected %v, got %v", testData["age"], result["age"])
	}

	if result["married"] != testData["married"] {
		t.Errorf("Married mismatch: expected %v, got %v", testData["married"], result["married"])
	}

	if result["score"] != testData["score"] {
		t.Errorf("Score mismatch: expected %v, got %v", testData["score"], result["score"])
	}
}
