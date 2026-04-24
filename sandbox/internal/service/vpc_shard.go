package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
)

const defaultStaticVPCShardBlueprintPath = "config/vpc-shard-blueprint.yaml"

func (s *Service) LoadStaticVPCShardBlueprint(path string) (blueprint.StaticVPCShardBlueprint, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		path = defaultStaticVPCShardBlueprintPath
	}
	return blueprint.LoadStaticVPCShardBlueprint(path)
}

func (s *Service) EnsureVPCShardBlueprintSnapshot(ctx context.Context, path string) (core.VPCShardBlueprintSnapshot, error) {
	bp, err := s.LoadStaticVPCShardBlueprint(path)
	if err != nil {
		return core.VPCShardBlueprintSnapshot{}, err
	}
	raw, err := json.Marshal(bp)
	if err != nil {
		return core.VPCShardBlueprintSnapshot{}, err
	}
	snapshot := core.VPCShardBlueprintSnapshot{
		ID:                   s.nextID("vpsnap"),
		SchemaVersion:        bp.SchemaVersion,
		SourceRegion:         bp.SourceRegion,
		NetworkTemplateID:    bp.NetworkTemplateID,
		BlueprintFingerprint: blueprint.StaticBlueprintFingerprint(bp),
		TopologyJSON:         string(raw),
		ValidationState:      "valid",
		CreatedAt:            time.Now().UTC(),
	}
	return s.store.UpsertVPCShardBlueprintSnapshot(ctx, snapshot)
}

func (s *Service) UpsertVPCShardBlueprintSnapshot(ctx context.Context, snapshot core.VPCShardBlueprintSnapshot) (core.VPCShardBlueprintSnapshot, error) {
	now := time.Now().UTC()
	if strings.TrimSpace(snapshot.ID) == "" {
		snapshot.ID = s.nextID("vpsnap")
	}
	if snapshot.CreatedAt.IsZero() {
		snapshot.CreatedAt = now
	}
	return s.store.UpsertVPCShardBlueprintSnapshot(ctx, snapshot)
}

func (s *Service) GetVPCShardBlueprintSnapshot(ctx context.Context, id string) (core.VPCShardBlueprintSnapshot, error) {
	return s.store.GetVPCShardBlueprintSnapshot(ctx, id)
}

func (s *Service) ListVPCShardBlueprintSnapshots(ctx context.Context) ([]core.VPCShardBlueprintSnapshot, error) {
	return s.store.ListVPCShardBlueprintSnapshots(ctx)
}

func (s *Service) UpsertVPCShardProvisionProgress(ctx context.Context, progress core.VPCShardProvisionProgress) (core.VPCShardProvisionProgress, error) {
	now := time.Now().UTC()
	if strings.TrimSpace(progress.ID) == "" {
		progress.ID = s.nextID("vpprog")
	}
	if progress.StartedAt.IsZero() {
		progress.StartedAt = now
	}
	progress.UpdatedAt = now
	return s.store.UpsertVPCShardProvisionProgress(ctx, progress)
}

func (s *Service) GetVPCShardProvisionProgress(ctx context.Context, shardID string) (core.VPCShardProvisionProgress, error) {
	return s.store.GetVPCShardProvisionProgress(ctx, shardID)
}

func (s *Service) DecodeVPCShardBlueprintSnapshot(snapshot core.VPCShardBlueprintSnapshot) (blueprint.StaticVPCShardBlueprint, error) {
	var bp blueprint.StaticVPCShardBlueprint
	if strings.TrimSpace(snapshot.TopologyJSON) == "" {
		return bp, fmt.Errorf("empty topology_json")
	}
	if err := json.Unmarshal([]byte(snapshot.TopologyJSON), &bp); err != nil {
		return bp, err
	}
	if err := blueprint.ValidateStaticVPCShardBlueprint(bp); err != nil {
		return bp, err
	}
	return bp, nil
}

func (s *Service) BuildVPCShardProvisionRequest(snapshot core.VPCShardBlueprintSnapshot, templateClassID string, sku core.SKU) (provider.VPCShardProvisionRequest, error) {
	bp, err := s.DecodeVPCShardBlueprintSnapshot(snapshot)
	if err != nil {
		return provider.VPCShardProvisionRequest{}, err
	}
	req := provider.VPCShardProvisionRequest{
		BlueprintSnapshotID:         snapshot.ID,
		TemplateClassID:             strings.TrimSpace(templateClassID),
		SKUID:                       sku.ID,
		BlueprintFingerprint:        snapshot.BlueprintFingerprint,
		NetworkTemplateID:           bp.NetworkTemplateID,
		SecurityGroupRuleTemplateID: sku.SecurityGroupRuleTemplateID,
		Region:                      bp.SourceRegion,
		VpcCIDR:                     bp.VPCCIDR,
		SupportSubnet: provider.VPCShardSubnetSpec{
			Name:    bp.SupportSubnet.Name,
			CIDR:    bp.SupportSubnet.CIDR,
			Zone:    bp.SupportSubnet.Zone,
			Role:    core.VPCShardSubnetRole(bp.SupportSubnet.Role),
			Ordinal: bp.SupportSubnet.Ordinal,
		},
		NATShape:   bp.NATShape,
		RouteShape: bp.RouteShape,
		Tags: map[string]string{
			"template_class_id": strings.TrimSpace(templateClassID),
			"sku_id":            sku.ID,
			"blueprint_fp":      snapshot.BlueprintFingerprint,
		},
	}
	req.WorkloadSubnets = make([]provider.VPCShardSubnetSpec, 0, len(bp.WorkloadSubnets))
	for _, subnet := range bp.WorkloadSubnets {
		req.WorkloadSubnets = append(req.WorkloadSubnets, provider.VPCShardSubnetSpec{
			Name:    subnet.Name,
			CIDR:    subnet.CIDR,
			Zone:    subnet.Zone,
			Role:    core.VPCShardSubnetRole(subnet.Role),
			Ordinal: subnet.Ordinal,
		})
	}
	return req, nil
}

func (s *Service) TryStartVPCShardCreate(ctx context.Context, blueprintFingerprint string, region string) (core.VPCShardCreateLock, bool, error) {
	return s.store.TryStartVPCShardCreate(ctx, blueprintFingerprint, region)
}

func (s *Service) ReconcileVPCShardHeadroom(ctx context.Context, provisioner provider.VPCShardProvisioner, templateClass core.TemplateClass, target AutoscaleTarget, blueprintPath string) (core.VPCShard, bool, error) {
	if provisioner == nil {
		return core.VPCShard{}, false, fmt.Errorf("missing vpc shard provisioner")
	}
	if shard, activeSubnet, ok, err := s.ActiveShardSubnetForSKU(ctx, templateClass.ID, target.SKU.ID); err != nil {
		return core.VPCShard{}, false, err
	} else if ok {
		if !activeSubnet.NearWaterline {
			return shard, false, nil
		}
		if _, reserved, reserveErr := s.ReserveNextVPCShardSubnet(ctx, shard.ID); reserveErr == nil {
			switched, activateErr := s.ActivateVPCShardSubnet(ctx, shard.ID, reserved.ID, time.Now().UTC(), "active_subnet_near_waterline")
			if activateErr != nil {
				return core.VPCShard{}, false, activateErr
			}
			return switched, false, nil
		} else if !errors.Is(reserveErr, core.ErrVPCShardSubnetNotFound) {
			return core.VPCShard{}, false, reserveErr
		}
	}

	snapshot, err := s.EnsureVPCShardBlueprintSnapshot(ctx, blueprintPath)
	if err != nil {
		return core.VPCShard{}, false, err
	}
	if _, acquired, err := s.TryStartVPCShardCreate(ctx, snapshot.BlueprintFingerprint, templateClass.Region); err != nil {
		return core.VPCShard{}, false, err
	} else if !acquired {
		return core.VPCShard{}, false, nil
	}
	defer func() {
		_ = s.store.DeleteVPCShardCreateLock(ctx, snapshot.BlueprintFingerprint, templateClass.Region)
	}()

	shard, err := s.ProvisionAndPersistVPCShard(ctx, provisioner, snapshot, templateClass.ID, target.SKU)
	if err != nil {
		return core.VPCShard{}, false, err
	}
	subnets, err := s.ListVPCShardSubnets(ctx, shard.ID)
	if err != nil {
		return core.VPCShard{}, false, err
	}
	var firstWorkload *core.VPCShardSubnet
	for _, subnet := range subnets {
		if subnet.Role != core.VPCShardSubnetRoleWorkload {
			continue
		}
		candidate := subnet
		if firstWorkload == nil || candidate.Ordinal < firstWorkload.Ordinal {
			firstWorkload = &candidate
		}
	}
	if firstWorkload == nil {
		return core.VPCShard{}, false, fmt.Errorf("no workload subnet available for new shard")
	}
	shard, err = s.ActivateVPCShardSubnet(ctx, shard.ID, firstWorkload.ID, time.Now().UTC(), "initial_activation")
	if err != nil {
		return core.VPCShard{}, false, err
	}
	return shard, true, nil
}

func (s *Service) ProvisionAndPersistVPCShard(ctx context.Context, provisioner provider.VPCShardProvisioner, snapshot core.VPCShardBlueprintSnapshot, templateClassID string, sku core.SKU) (core.VPCShard, error) {
	if provisioner == nil {
		return core.VPCShard{}, fmt.Errorf("missing vpc shard provisioner")
	}
	req, err := s.BuildVPCShardProvisionRequest(snapshot, templateClassID, sku)
	if err != nil {
		return core.VPCShard{}, err
	}
	shard, err := s.UpsertVPCShard(ctx, core.VPCShard{
		BlueprintSnapshotID:  snapshot.ID,
		BlueprintFingerprint: snapshot.BlueprintFingerprint,
		TemplateClassID:      strings.TrimSpace(templateClassID),
		SKUID:                sku.ID,
		NetworkTemplateID:    strings.TrimSpace(req.NetworkTemplateID),
		Region:               strings.TrimSpace(req.Region),
		State:                core.VPCShardStateProvisioning,
	})
	if err != nil {
		return core.VPCShard{}, err
	}
	progress, err := s.UpsertVPCShardProvisionProgress(ctx, core.VPCShardProvisionProgress{
		VPCShardID:           shard.ID,
		BlueprintSnapshotID:  snapshot.ID,
		BlueprintFingerprint: snapshot.BlueprintFingerprint,
		Status:               core.VPCShardProvisionProgressStatusRunning,
		LastStep:             "provision_start",
	})
	if err != nil {
		return core.VPCShard{}, err
	}
	result, err := provisioner.ProvisionVPCShard(ctx, req)
	if err != nil {
		progress.Status = core.VPCShardProvisionProgressStatusFailed
		progress.LastError = err.Error()
		if provisionErr, ok := err.(*provider.VPCShardProvisionError); ok {
			progress.LastStep = strings.TrimSpace(provisionErr.LastStep)
			if len(provisionErr.PartialResult.CleanupResources) > 0 {
				if _, replaceErr := s.ReplaceVPCShardCleanupResources(ctx, shard.ID, provisionErr.PartialResult.CleanupResources); replaceErr != nil {
					return core.VPCShard{}, replaceErr
				}
				partialSubnets := collectProvisionedShardSubnets(provisionErr.PartialResult)
				if len(partialSubnets) > 0 {
					if _, replaceErr := s.ReplaceVPCShardSubnets(ctx, shard.ID, partialSubnets); replaceErr != nil {
						return core.VPCShard{}, replaceErr
					}
				}
				shard.VpcID = strings.TrimSpace(provisionErr.PartialResult.VpcID)
				shard.State = core.VPCShardStateCleanupPending
				shard.CleanupState = core.VPCShardCleanupStatePending
				shard.CleanupLastError = err.Error()
				now := time.Now().UTC()
				shard.CleanupStartedAt = &now
			} else {
				shard.State = core.VPCShardStateFailed
			}
		} else {
			shard.State = core.VPCShardStateFailed
		}
		if _, updateErr := s.UpsertVPCShard(ctx, shard); updateErr != nil {
			return core.VPCShard{}, updateErr
		}
		if _, progressErr := s.UpsertVPCShardProvisionProgress(ctx, progress); progressErr != nil {
			return core.VPCShard{}, progressErr
		}
		return core.VPCShard{}, err
	}
	shard.VpcID = strings.TrimSpace(result.VpcID)
	persisted, err := s.PersistProvisionedVPCShard(ctx, shard, result.SupportSubnet, result.WorkloadSubnets, result.CleanupResources)
	if err != nil {
		return core.VPCShard{}, err
	}
	progress.Status = core.VPCShardProvisionProgressStatusCompleted
	progress.LastStep = "completed"
	completedAt := time.Now().UTC()
	progress.CompletedAt = &completedAt
	progress.LastError = ""
	if _, err := s.UpsertVPCShardProvisionProgress(ctx, progress); err != nil {
		return core.VPCShard{}, err
	}
	return persisted, nil
}

func collectProvisionedShardSubnets(result provider.VPCShardProvisionResult) []core.VPCShardSubnet {
	subnets := make([]core.VPCShardSubnet, 0, 1+len(result.WorkloadSubnets))
	if strings.TrimSpace(result.SupportSubnet.SubnetID) != "" {
		subnets = append(subnets, result.SupportSubnet)
	}
	for _, subnet := range result.WorkloadSubnets {
		if strings.TrimSpace(subnet.SubnetID) == "" {
			continue
		}
		subnets = append(subnets, subnet)
	}
	return subnets
}

func (s *Service) UpsertVPCShard(ctx context.Context, shard core.VPCShard) (core.VPCShard, error) {
	now := time.Now().UTC()
	if shard.CreatedAt.IsZero() {
		shard.CreatedAt = now
	}
	shard.UpdatedAt = now
	if strings.TrimSpace(shard.ID) == "" {
		shard.ID = s.nextID("vpshard")
	}
	if strings.TrimSpace(shard.BlueprintSnapshotID) == "" {
		return core.VPCShard{}, fmt.Errorf("missing vpc shard blueprint_snapshot_id")
	}
	if strings.TrimSpace(shard.BlueprintFingerprint) == "" {
		return core.VPCShard{}, fmt.Errorf("missing vpc shard blueprint_fingerprint")
	}
	if strings.TrimSpace(shard.Region) == "" {
		return core.VPCShard{}, fmt.Errorf("missing vpc shard region")
	}
	if shard.State == "" {
		shard.State = core.VPCShardStateProvisioning
	}
	return s.store.UpsertVPCShard(ctx, shard)
}

func (s *Service) GetVPCShard(ctx context.Context, id string) (core.VPCShard, error) {
	return s.store.GetVPCShard(ctx, id)
}

func (s *Service) ListVPCShards(ctx context.Context) ([]core.VPCShard, error) {
	return s.store.ListVPCShards(ctx)
}

func (s *Service) ReplaceVPCShardSubnets(ctx context.Context, shardID string, subnets []core.VPCShardSubnet) ([]core.VPCShardSubnet, error) {
	now := time.Now().UTC()
	items := make([]core.VPCShardSubnet, 0, len(subnets))
	for _, subnet := range subnets {
		subnet.VPCShardID = shardID
		if subnet.CreatedAt.IsZero() {
			subnet.CreatedAt = now
		}
		subnet.UpdatedAt = now
		if strings.TrimSpace(subnet.ID) == "" {
			subnet.ID = s.nextID("vpsubnet")
		}
		if subnet.ReservationState == "" {
			subnet.ReservationState = core.VPCShardSubnetReservationAvailable
		}
		items = append(items, subnet)
	}
	return s.store.ReplaceVPCShardSubnets(ctx, shardID, items)
}

func (s *Service) ListVPCShardSubnets(ctx context.Context, shardID string) ([]core.VPCShardSubnet, error) {
	return s.store.ListVPCShardSubnets(ctx, shardID)
}

func (s *Service) ReserveNextVPCShardSubnet(ctx context.Context, shardID string) (core.VPCShard, core.VPCShardSubnet, error) {
	return s.store.ReserveNextVPCShardSubnet(ctx, shardID)
}

func (s *Service) ActivateVPCShardSubnet(ctx context.Context, shardID string, subnetMemberID string, switchedAt time.Time, waterlineReason string) (core.VPCShard, error) {
	return s.store.ActivateVPCShardSubnet(ctx, shardID, subnetMemberID, switchedAt.UTC(), waterlineReason)
}

func (s *Service) ReplaceVPCShardCleanupResources(ctx context.Context, shardID string, resources []core.VPCShardCleanupResource) ([]core.VPCShardCleanupResource, error) {
	now := time.Now().UTC()
	items := make([]core.VPCShardCleanupResource, 0, len(resources))
	for _, resource := range resources {
		resource.VPCShardID = shardID
		if strings.TrimSpace(resource.ID) == "" {
			resource.ID = s.nextID("vpscleanup")
		}
		if resource.CreatedAt.IsZero() {
			resource.CreatedAt = now
		}
		items = append(items, resource)
	}
	return s.store.ReplaceVPCShardCleanupResources(ctx, shardID, items)
}

func (s *Service) ListVPCShardCleanupResources(ctx context.Context, shardID string) ([]core.VPCShardCleanupResource, error) {
	return s.store.ListVPCShardCleanupResources(ctx, shardID)
}

func (s *Service) PersistProvisionedVPCShard(ctx context.Context, shard core.VPCShard, supportSubnet core.VPCShardSubnet, workloadSubnets []core.VPCShardSubnet, cleanupResources []core.VPCShardCleanupResource) (core.VPCShard, error) {
	persisted, err := s.UpsertVPCShard(ctx, shard)
	if err != nil {
		return core.VPCShard{}, err
	}
	allSubnets := make([]core.VPCShardSubnet, 0, 1+len(workloadSubnets))
	allSubnets = append(allSubnets, supportSubnet)
	allSubnets = append(allSubnets, workloadSubnets...)
	if _, err := s.ReplaceVPCShardSubnets(ctx, persisted.ID, allSubnets); err != nil {
		return core.VPCShard{}, err
	}
	if _, err := s.ReplaceVPCShardCleanupResources(ctx, persisted.ID, cleanupResources); err != nil {
		return core.VPCShard{}, err
	}
	return s.GetVPCShard(ctx, persisted.ID)
}

func (s *Service) PersistProvisionedVPCShardFromRequest(ctx context.Context, req provider.VPCShardProvisionRequest, result provider.VPCShardProvisionResult) (core.VPCShard, error) {
	shard := core.VPCShard{
		BlueprintSnapshotID:  strings.TrimSpace(req.BlueprintSnapshotID),
		BlueprintFingerprint: strings.TrimSpace(req.BlueprintFingerprint),
		TemplateClassID:      strings.TrimSpace(req.TemplateClassID),
		SKUID:                strings.TrimSpace(req.SKUID),
		NetworkTemplateID:    strings.TrimSpace(req.NetworkTemplateID),
		Region:               strings.TrimSpace(req.Region),
		VpcID:                strings.TrimSpace(result.VpcID),
		State:                core.VPCShardStateProvisioning,
	}
	return s.PersistProvisionedVPCShard(ctx, shard, result.SupportSubnet, result.WorkloadSubnets, result.CleanupResources)
}

func (s *Service) ActiveShardSubnetForSKU(ctx context.Context, templateClassID string, skuID string) (core.VPCShard, core.VPCShardSubnet, bool, error) {
	templateClassID = strings.TrimSpace(templateClassID)
	skuID = strings.TrimSpace(skuID)
	if templateClassID == "" || skuID == "" {
		return core.VPCShard{}, core.VPCShardSubnet{}, false, nil
	}
	shards, err := s.ListVPCShards(ctx)
	if err != nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, false, err
	}
	var chosen *core.VPCShard
	for _, shard := range shards {
		if shard.TemplateClassID != templateClassID || shard.SKUID != skuID {
			continue
		}
		if strings.TrimSpace(shard.ActiveSubnetMemberID) == "" {
			continue
		}
		switch shard.State {
		case core.VPCShardStateActive, core.VPCShardStateProvisioning:
		default:
			continue
		}
		candidate := shard
		if chosen == nil || candidate.CreatedAt.After(chosen.CreatedAt) {
			chosen = &candidate
		}
	}
	if chosen == nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, false, nil
	}
	subnets, err := s.ListVPCShardSubnets(ctx, chosen.ID)
	if err != nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, false, err
	}
	for _, subnet := range subnets {
		if subnet.ID == chosen.ActiveSubnetMemberID {
			return *chosen, subnet, true, nil
		}
	}
	return core.VPCShard{}, core.VPCShardSubnet{}, false, nil
}

func (s *Service) MarkVPCShardCleanupPending(ctx context.Context, shardID string, cleanupErr string, startedAt time.Time) (core.VPCShard, error) {
	shard, err := s.GetVPCShard(ctx, shardID)
	if err != nil {
		return core.VPCShard{}, err
	}
	shard.State = core.VPCShardStateCleanupPending
	shard.CleanupState = core.VPCShardCleanupStatePending
	ts := startedAt.UTC()
	shard.CleanupStartedAt = &ts
	shard.CleanupLastError = strings.TrimSpace(cleanupErr)
	return s.UpsertVPCShard(ctx, shard)
}
