package checkmodify

import (
	"fmt"
	"strconv"
)

// goodsDetail 取值 helper。与 checkcreate / checkrenew 同型实现（各包自持一份避免
// 循环依赖）。变配独有的 oldConfig / newConfig 对象解析在协议层
// jifei.GoodsDetailSVMap（checkModify 与 modifyResource 共用，见 resolve.go 注释）。

func goodsDetailStringField(m map[string]interface{}, key string) (string, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false
	}
	switch t := v.(type) {
	case string:
		return t, true
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10), true
		}
		return strconv.FormatFloat(t, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(t), true
	default:
		return fmt.Sprintf("%v", t), true
	}
}

func goodsDetailIntField(m map[string]interface{}, key string) (int, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int64:
		return int(t), true
	case string:
		n, err := strconv.Atoi(t)
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}
