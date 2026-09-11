package provider

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	cvm "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cvm/v20170312"
)

// Same-SP upgrade (变配) support: grow an already-delivered instance in place.
//
// Each step reads the effective spec back from CVM before acting, so a retried
// child task never re-issues a resize that already landed. That read-back is
// what makes the steps idempotent — we deliberately do not try to enumerate the
// vendor error codes for "nothing changed".

// resizeSettleTimeout bounds how long a single resize step waits for the
// instance to leave its transient state.
const resizeSettleTimeout = 5 * time.Minute

// DescribeInstanceSpec implements InstanceSpecResizer.
func (p *TencentCloudProvider) DescribeInstanceSpec(ctx context.Context, cloudID string) (InstanceSpec, error) {
	cloudID = strings.TrimSpace(cloudID)
	if cloudID == "" {
		return InstanceSpec{}, errors.New("DescribeInstanceSpec: cloudID is required")
	}
	req := cvm.NewDescribeInstancesRequest()
	req.InstanceIds = []*string{common.StringPtr(cloudID)}
	req.SetContext(ctx)

	var resp *cvm.DescribeInstancesResponse
	if err := retryRateLimit(ctx, "DescribeInstances", func() error {
		r, e := p.client.DescribeInstances(req)
		if e != nil {
			return e
		}
		resp = r
		return nil
	}); err != nil {
		return InstanceSpec{}, fmt.Errorf("DescribeInstances %s: %w", cloudID, err)
	}
	if resp == nil || resp.Response == nil || len(resp.Response.InstanceSet) == 0 {
		return InstanceSpec{}, fmt.Errorf("DescribeInstanceSpec %s: instance not found", cloudID)
	}
	inst := resp.Response.InstanceSet[0]
	spec := InstanceSpec{}
	if inst.InstanceType != nil {
		spec.InstanceType = *inst.InstanceType
	}
	if inst.SystemDisk != nil && inst.SystemDisk.DiskSize != nil {
		spec.SystemDiskSize = int(*inst.SystemDisk.DiskSize)
	}
	if inst.InstanceState != nil {
		spec.State = *inst.InstanceState
	}
	if inst.StopChargingMode != nil {
		spec.StopChargingMode = *inst.StopChargingMode
	}
	return spec, nil
}

// StopInstanceForResize keeps allocation while temporarily shutting down.
// CVM rejects same-family ResetInstancesType on STOP_CHARGING instances
// (UnsupportedOperation.StoppedModeStopChargingSameFamily). A task stopped by
// the old pause-based implementation must first boot, then stop with billing
// retained. Read-back also permits resuming after either half of that cycle.
func (p *TencentCloudProvider) StopInstanceForResize(ctx context.Context, cloudID string) error {
	spec, err := p.DescribeInstanceSpec(ctx, cloudID)
	if err != nil {
		return err
	}
	if strings.EqualFold(spec.State, "STARTING") || strings.EqualFold(spec.State, "STOPPING") {
		if err := p.awaitInstanceSpec(ctx, cloudID, func(s InstanceSpec) bool {
			return strings.EqualFold(s.State, "RUNNING") || strings.EqualFold(s.State, "STOPPED")
		}, "stable state before resize shutdown"); err != nil {
			return err
		}
		spec, err = p.DescribeInstanceSpec(ctx, cloudID)
		if err != nil {
			return err
		}
	}
	switch strings.ToUpper(spec.State) {
	case "STOPPED":
		switch strings.ToUpper(spec.StopChargingMode) {
		case "KEEP_CHARGING", "NOT_APPLICABLE":
			return nil
		case "STOP_CHARGING":
		default:
			return fmt.Errorf("prepare resize %s: unknown stopped billing mode %q", cloudID, spec.StopChargingMode)
		}
		if err := p.StartInstance(ctx, cloudID); err != nil {
			return fmt.Errorf("prepare resize %s: leave STOP_CHARGING: %w", cloudID, err)
		}
	case "RUNNING":
	default:
		return fmt.Errorf("prepare resize %s: unsupported state %s", cloudID, spec.State)
	}
	if err := p.stopInstanceWithMode(ctx, cloudID, "KEEP_CHARGING"); err != nil {
		return err
	}
	spec, err = p.DescribeInstanceSpec(ctx, cloudID)
	if err != nil {
		return err
	}
	if !strings.EqualFold(spec.State, "STOPPED") ||
		(!strings.EqualFold(spec.StopChargingMode, "KEEP_CHARGING") && !strings.EqualFold(spec.StopChargingMode, "NOT_APPLICABLE")) {
		return fmt.Errorf("prepare resize %s: shutdown not ready, state=%s billing=%s", cloudID, spec.State, spec.StopChargingMode)
	}
	return nil
}

// ResizeInstanceType implements InstanceSpecResizer.
func (p *TencentCloudProvider) ResizeInstanceType(ctx context.Context, cloudID, instanceType string) error {
	cloudID = strings.TrimSpace(cloudID)
	instanceType = strings.TrimSpace(instanceType)
	if cloudID == "" || instanceType == "" {
		return errors.New("ResizeInstanceType: cloudID and instanceType are required")
	}
	spec, err := p.DescribeInstanceSpec(ctx, cloudID)
	if err != nil {
		return err
	}
	if spec.InstanceType == instanceType {
		return nil
	}
	// A persisted operation may resume directly at compute resize after an
	// older worker completed the stop step with STOP_CHARGING. Prepare here
	// as well as in the explicit stop step; completed target stays a no-op.
	if err := p.StopInstanceForResize(ctx, cloudID); err != nil {
		return err
	}

	req := cvm.NewResetInstancesTypeRequest()
	req.InstanceIds = []*string{common.StringPtr(cloudID)}
	req.InstanceType = common.StringPtr(instanceType)
	req.SetContext(ctx)

	if err := p.callWhileInstanceBusy(ctx, "ResetInstancesType", cloudID, func() error {
		_, e := p.client.ResetInstancesType(req)
		return e
	}); err != nil {
		return fmt.Errorf("ResetInstancesType %s to %s: %w", cloudID, instanceType, err)
	}
	return p.awaitInstanceSpec(ctx, cloudID, func(s InstanceSpec) bool {
		return s.InstanceType == instanceType && !isTransientInstanceState(s.State)
	}, fmt.Sprintf("instance type %s", instanceType))
}

// ResizeSystemDisk implements InstanceSpecResizer.
func (p *TencentCloudProvider) ResizeSystemDisk(ctx context.Context, cloudID string, sizeGB int) error {
	cloudID = strings.TrimSpace(cloudID)
	if cloudID == "" || sizeGB <= 0 {
		return errors.New("ResizeSystemDisk: cloudID and a positive sizeGB are required")
	}
	spec, err := p.DescribeInstanceSpec(ctx, cloudID)
	if err != nil {
		return err
	}
	if spec.SystemDiskSize == sizeGB {
		return nil
	}
	if spec.SystemDiskSize > sizeGB {
		return fmt.Errorf("ResizeSystemDisk %s: cloud disks cannot shrink (%dG -> %dG)",
			cloudID, spec.SystemDiskSize, sizeGB)
	}

	req := cvm.NewResizeInstanceDisksRequest()
	req.InstanceId = common.StringPtr(cloudID)
	req.SystemDisk = &cvm.SystemDisk{DiskSize: common.Int64Ptr(int64(sizeGB))}
	req.SetContext(ctx)

	if err := p.callWhileInstanceBusy(ctx, "ResizeInstanceDisks", cloudID, func() error {
		_, e := p.client.ResizeInstanceDisks(req)
		return e
	}); err != nil {
		return fmt.Errorf("ResizeInstanceDisks %s to %dG: %w", cloudID, sizeGB, err)
	}
	return p.awaitInstanceSpec(ctx, cloudID, func(s InstanceSpec) bool {
		return s.SystemDiskSize >= sizeGB && !isTransientInstanceState(s.State)
	}, fmt.Sprintf("system disk %dG", sizeGB))
}

// callWhileInstanceBusy issues call, retrying only while CVM reports another
// operation already in flight on the same instance.
func (p *TencentCloudProvider) callWhileInstanceBusy(ctx context.Context, op, cloudID string, call func() error) error {
	deadline := time.Now().Add(resizeSettleTimeout)
	for {
		err := retryRateLimit(ctx, op, call)
		if err == nil {
			return nil
		}
		var sdk *tcerrors.TencentCloudSDKError
		if errors.As(err, &sdk) && sdk.Code == "OperationDenied.InstanceOperationInProgress" {
			if time.Now().After(deadline) {
				return fmt.Errorf("%s on %s timed out waiting for the pending operation: %w", op, cloudID, err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Second):
			}
			continue
		}
		return err
	}
}

// awaitInstanceSpec polls until the instance spec satisfies want.
func (p *TencentCloudProvider) awaitInstanceSpec(ctx context.Context, cloudID string, want func(InstanceSpec) bool, describe string) error {
	deadline := time.Now().Add(resizeSettleTimeout)
	for {
		spec, err := p.DescribeInstanceSpec(ctx, cloudID)
		if err != nil {
			return err
		}
		if want(spec) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout waiting for %s on %s; last spec=%s/%dG state=%s",
				describe, cloudID, spec.InstanceType, spec.SystemDiskSize, spec.State)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

// isTransientInstanceState reports whether the instance is mid-operation, in
// which case its reported spec may not be settled yet.
func isTransientInstanceState(state string) bool {
	switch strings.ToUpper(strings.TrimSpace(state)) {
	case "PENDING", "STARTING", "STOPPING", "REBOOTING", "SHUTDOWN", "TERMINATING", "RESIZING", "UPGRADING":
		return true
	default:
		return false
	}
}
