package provider

import (
	"encoding/json"
	"testing"
)

func TestCVMInventoryParameters(t *testing.T) {
	params, err := cvmInventoryParameters([]string{"SA4", "SA9"}, []string{"ap-shanghai-5", "ap-shanghai-8"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"Filters":[{"Name":"instance-charge-type","Values":["POSTPAID_BY_HOUR"]},{"Name":"instance-family","Values":["SA4","SA9"]},{"Name":"zone","Values":["ap-shanghai-5","ap-shanghai-8"]},{"Name":"extra-params","Values":["realStatus"]}]}`
	if string(got) != want {
		t.Fatalf("filters = %s, want %s", got, want)
	}
	if _, err := cvmInventoryParameters([]string{"A", "B", "C", "D", "E", "F"}, []string{"ap-shanghai-5"}); err == nil {
		t.Fatal("expected family filter limit error")
	}
	if _, err := cvmInventoryParameters([]string{"SA4"}, []string{"a-1", "b-1", "c-1", "d-1", "e-1", "f-1"}); err == nil {
		t.Fatal("expected zone filter limit error")
	}
}

func TestParseCVMInventoryResponsePreservesInstanceQuota(t *testing.T) {
	batch, err := parseCVMInventoryResponse([]byte(`{"Response":{"InstanceTypeQuotaSet":[{"Zone":"ap-shanghai-5","InstanceType":"SA9.MEDIUM8","InstanceChargeType":"POSTPAID_BY_HOUR","InstanceQuota":17}],"RequestId":"request-1"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if batch.RequestID != "request-1" || len(batch.Items) != 1 || batch.Items[0].InstanceQuota == nil || *batch.Items[0].InstanceQuota != 17 {
		t.Fatalf("unexpected batch: %+v", batch)
	}
	missing, err := parseCVMInventoryResponse([]byte(`{"Response":{"InstanceTypeQuotaSet":[{"Zone":"ap-shanghai-5","InstanceType":"SA9.MEDIUM8"}],"RequestId":"request-2"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(missing.Items) != 1 || missing.Items[0].InstanceQuota != nil {
		t.Fatalf("missing quota must remain unknown: %+v", missing)
	}
	zero, err := parseCVMInventoryResponse([]byte(`{"Response":{"InstanceTypeQuotaSet":[{"Zone":"ap-shanghai-5","InstanceType":"SA9.MEDIUM8","InstanceQuota":0}],"RequestId":"request-3"}}`))
	if err != nil || len(zero.Items) != 1 || zero.Items[0].InstanceQuota == nil || *zero.Items[0].InstanceQuota != 0 {
		t.Fatalf("zero is a known inventory count: batch=%+v err=%v", zero, err)
	}
}
