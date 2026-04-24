package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"shadow/internal/storage"
)

type HTTPOptions struct {
	Platform            string
	DianshiEndpoint     string
	BillingEndpoint     string
	RecoveryEndpoint    string
	FreeTrialActivityID string
	FreeTrialActID      string
	SubProductCode      string
	RequestTimeout      time.Duration
}

type HTTPProvider struct {
	opts   HTTPOptions
	store  storage.Store
	client *http.Client
}

func NewHTTPProvider(opts HTTPOptions, store storage.Store) (*HTTPProvider, error) {
	if store == nil {
		return nil, errors.New("billing store is required")
	}
	if opts.Platform == "" {
		return nil, errors.New("billing platform is required")
	}
	if opts.DianshiEndpoint == "" || opts.BillingEndpoint == "" {
		return nil, errors.New("billing endpoints are required")
	}
	if opts.FreeTrialActivityID == "" || opts.FreeTrialActID == "" || opts.SubProductCode == "" {
		return nil, errors.New("free-trial goods config is required")
	}
	if opts.RequestTimeout == 0 {
		opts.RequestTimeout = 10 * time.Second
	}
	return &HTTPProvider{
		opts:   opts,
		store:  store,
		client: &http.Client{Timeout: opts.RequestTimeout},
	}, nil
}

func (p *HTTPProvider) CreateFreeTrialOrderAndPay(ctx context.Context, in FreeTrialOrderInput) (FreeTrialOrderResult, error) {
	pending, err := p.store.GetPendingFreeTrialOrderByOwnerUin(ctx, in.OwnerUin)
	if err == nil && pending.Status == storage.PendingFreeTrialOrderStatusPaid && pending.InstanceID != "" {
		return FreeTrialOrderResult{
			BigDealID:  pending.BigDealID,
			DealName:   pending.DealName,
			InstanceID: pending.InstanceID,
		}, nil
	}
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		return FreeTrialOrderResult{}, err
	}

	if errors.Is(err, storage.ErrNotFound) || pending.BigDealID == "" {
		bigDealID, err := p.createOrder(ctx, in)
		if err != nil {
			if errors.Is(err, ErrDuplicateOrder) {
				pending, err = p.store.GetPendingFreeTrialOrderByOwnerUin(ctx, in.OwnerUin)
				if err != nil {
					if errors.Is(err, storage.ErrNotFound) {
						return FreeTrialOrderResult{}, ErrDuplicateOrder
					}
					return FreeTrialOrderResult{}, err
				}
			} else {
				return FreeTrialOrderResult{}, err
			}
		} else {
			pending = storage.PendingFreeTrialOrder{
				OwnerUin:  in.OwnerUin,
				UserID:    in.UserID,
				AppID:     in.AppID,
				BigDealID: bigDealID,
				Status:    storage.PendingFreeTrialOrderStatusOrdered,
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
			}
			if err := p.store.SavePendingFreeTrialOrder(ctx, pending); err != nil {
				return FreeTrialOrderResult{}, err
			}
		}
	}

	return p.payAndFinalize(ctx, in, pending)
}

func (p *HTTPProvider) createOrder(ctx context.Context, in FreeTrialOrderInput) (string, error) {
	var response struct {
		ReturnCode    int    `json:"returnCode"`
		ReturnMessage string `json:"returnMessage"`
		Data          struct {
			BigDealNo string `json:"big_deal_no"`
		} `json:"data"`
	}
	if err := p.post(ctx, p.opts.DianshiEndpoint, map[string]any{
		"version":       "1.0",
		"componentName": "shadow",
		"eventId":       randomEventID(),
		"timestamp":     time.Now().UnixMilli(),
		"interface": map[string]any{
			"interfaceName": "",
			"para": map[string]any{
				"uin":         fmt.Sprintf("%d", in.Uin),
				"activity_id": p.opts.FreeTrialActivityID,
				"goods": []map[string]any{{
					"act_id": p.opts.FreeTrialActID,
					"preference_param": map[string]any{
						"license":      5,
						"storage":      50,
						"timeSpanUnit": "1m",
						"traffic":      "0",
						"version":      p.opts.SubProductCode,
					},
				}},
				"saas_info": map[string]any{
					"SaaSToken":     in.SaaSToken,
					"Platform":      p.opts.Platform,
					"TokenUin":      in.Uin,
					"TokenOwnerUin": in.OwnerUin,
					"ClientIP":      in.ClientIP,
					"ClientUA":      in.ClientUA,
				},
			},
		},
	}, &response); err != nil {
		return "", err
	}
	if response.ReturnCode == 1100106 {
		return "", ErrDuplicateOrder
	}
	if response.ReturnCode != 0 {
		return "", errors.New(response.ReturnMessage)
	}
	if response.Data.BigDealNo == "" {
		return "", errors.New("missing big deal id")
	}
	return response.Data.BigDealNo, nil
}

func (p *HTTPProvider) payAndFinalize(ctx context.Context, in FreeTrialOrderInput, pending storage.PendingFreeTrialOrder) (FreeTrialOrderResult, error) {
	var response struct {
		ReturnCode    int    `json:"returnCode"`
		ReturnMessage string `json:"returnMessage"`
		Data          struct {
			DealNames   []string            `json:"dealNames"`
			ResourceIDs map[string][]string `json:"resourceIds"`
		} `json:"data"`
	}
	if err := p.post(ctx, p.opts.BillingEndpoint, map[string]any{
		"version":       "1.0",
		"componentName": "shadow",
		"eventId":       randomEventID(),
		"timestamp":     time.Now().UnixMilli(),
		"interface": map[string]any{
			"interfaceName": "qcloud.Deal.payDealsNew",
			"para": map[string]any{
				"ownerUin":                fmt.Sprintf("%d", in.OwnerUin),
				"uin":                     fmt.Sprintf("%d", in.Uin),
				"appId":                   in.AppID,
				"bigDealIds":              []string{pending.BigDealID},
				"fromGenerateDealsAndPay": "8ab8c907b716ffc77c94109852122102",
			},
		},
	}, &response); err != nil {
		return FreeTrialOrderResult{}, err
	}
	if response.ReturnCode == 100102 {
		if pending.Status == storage.PendingFreeTrialOrderStatusPaid && pending.InstanceID != "" {
			return FreeTrialOrderResult{
				BigDealID:  pending.BigDealID,
				DealName:   pending.DealName,
				InstanceID: pending.InstanceID,
			}, nil
		}
		recovered, err := p.recoverPaidOrder(ctx, pending)
		if err == nil {
			return recovered, nil
		}
		return FreeTrialOrderResult{}, ErrDeliveryDelayed
	}
	if response.ReturnCode != 0 {
		return FreeTrialOrderResult{}, errors.New(response.ReturnMessage)
	}

	dealName := firstString(response.Data.DealNames)
	instanceID := firstString(response.Data.ResourceIDs[dealName])
	if instanceID == "" {
		return FreeTrialOrderResult{}, ErrDeliveryDelayed
	}
	pending.DealName = dealName
	pending.InstanceID = instanceID
	pending.Status = storage.PendingFreeTrialOrderStatusPaid
	pending.UpdatedAt = time.Now().UTC()
	if err := p.store.SavePendingFreeTrialOrder(ctx, pending); err != nil {
		return FreeTrialOrderResult{}, err
	}
	return FreeTrialOrderResult{
		BigDealID:  pending.BigDealID,
		DealName:   dealName,
		InstanceID: instanceID,
	}, nil
}

func (p *HTTPProvider) recoverPaidOrder(ctx context.Context, pending storage.PendingFreeTrialOrder) (FreeTrialOrderResult, error) {
	if p.opts.RecoveryEndpoint == "" {
		return FreeTrialOrderResult{}, ErrDeliveryDelayed
	}
	var response struct {
		DealName   string `json:"deal_name"`
		InstanceID string `json:"instance_id"`
	}
	if err := p.post(ctx, p.opts.RecoveryEndpoint, map[string]any{
		"big_deal_id": pending.BigDealID,
		"owner_uin":   pending.OwnerUin,
		"app_id":      pending.AppID,
	}, &response); err != nil {
		return FreeTrialOrderResult{}, err
	}
	if strings.TrimSpace(response.InstanceID) == "" {
		return FreeTrialOrderResult{}, ErrDeliveryDelayed
	}
	pending.DealName = strings.TrimSpace(response.DealName)
	pending.InstanceID = strings.TrimSpace(response.InstanceID)
	pending.Status = storage.PendingFreeTrialOrderStatusPaid
	pending.UpdatedAt = time.Now().UTC()
	if err := p.store.SavePendingFreeTrialOrder(ctx, pending); err != nil {
		return FreeTrialOrderResult{}, err
	}
	return FreeTrialOrderResult{
		BigDealID:  pending.BigDealID,
		DealName:   pending.DealName,
		InstanceID: pending.InstanceID,
	}, nil
}

func (p *HTTPProvider) post(ctx context.Context, endpoint string, payload any, out any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("unexpected status %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return err
	}
	return nil
}

func randomEventID() string {
	return fmt.Sprintf("shadow-%d-%d", time.Now().UnixNano(), rand.Int63())
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}
