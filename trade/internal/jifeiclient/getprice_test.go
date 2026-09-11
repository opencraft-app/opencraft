package jifeiclient

import (
	"encoding/json"
	"math"
	"testing"
)

// flexFloat 的存在原因是一个真实的联调坑：变配询价的 timeSpan 是"剩余时长占比"
// 小数（实测 0.133333），而新购 / 续费是整数周期。字段声明成 int 时计费其实
// 已经把差价算对了，但整个回包在 encoding/json 层就解析失败，对外表现为 502
// UpstreamError。这组用例锁住"小数不能丢、整数不能变形"。
func TestFlexFloat_UnmarshalJSON(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    float64
		wantErr bool
	}{
		{"modify-fractional", `0.133333`, 0.133333, false},
		{"int-bare", `1`, 1, false},
		{"int-zero", `0`, 0, false},
		{"string-encoded-fractional", `"0.133333"`, 0.133333, false},
		{"string-encoded-int", `"12"`, 12, false},
		{"null", `null`, 0, false},
		{"empty-string", `""`, 0, false},
		{"bogus-string", `"foo"`, 0, true},
		{"bogus-bool", `true`, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var f flexFloat
			err := json.Unmarshal([]byte(tc.input), &f)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("input %q: want error, got nil (f=%v)", tc.input, float64(f))
				}
				return
			}
			if err != nil {
				t.Fatalf("input %q: unexpected err %v", tc.input, err)
			}
			if math.Abs(float64(f)-tc.want) > 1e-9 {
				t.Errorf("input %q: got %v, want %v", tc.input, float64(f), tc.want)
			}
		})
	}
}

// 整数值必须序列化成 `1` 而不是 `1.0`：新购 / 续费的既有出参不能因为变配的改动而漂移。
func TestFlexFloat_MarshalJSON(t *testing.T) {
	cases := []struct {
		val  flexFloat
		want string
	}{
		{flexFloat(0), `0`},
		{flexFloat(1), `1`},
		{flexFloat(12), `12`},
		{flexFloat(0.133333), `0.133333`},
	}
	for _, tc := range cases {
		got, err := json.Marshal(tc.val)
		if err != nil {
			t.Fatalf("marshal flexFloat(%v): %v", float64(tc.val), err)
		}
		if string(got) != tc.want {
			t.Errorf("flexFloat(%v): got %s, want %s", float64(tc.val), got, tc.want)
		}
	}
}

// GetPriceData 整体解码：变配回包的真实形状（价格字段为裸数字、timeSpan 为小数）
// 必须能完整读进来。这是 502 UpstreamError 的直接回归，报文取自云梯实测。
func TestGetPriceData_ModifyResponseDecodes(t *testing.T) {
	raw := `{"price":4603,"totalCost":614,"realTotalCost":1267,"currency":"CNY",
		"timeUnit":"m","timeSpan":0.133333,"goodsNum":1,"policy":0.0001,
		"productCode":"p_lighthouse","subProductCode":"sp_lighthouse_lightvela_mc","pid":1059119}`
	var d GetPriceData
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatalf("unmarshal modify GetPriceData: %v", err)
	}
	if d.RealTotalCost != "1267" {
		t.Errorf("realTotalCost = %q, want \"1267\"", d.RealTotalCost)
	}
	if math.Abs(float64(d.TimeSpan)-0.133333) > 1e-9 {
		t.Errorf("timeSpan = %v, want 0.133333", float64(d.TimeSpan))
	}
	if d.TimeUnit != "m" || d.Pid != 1059119 {
		t.Errorf("timeUnit/pid = %q/%d", d.TimeUnit, d.Pid)
	}
}
