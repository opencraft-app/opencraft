package internalapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/store"
)

type dianshiRecordsResponse struct {
	Orders              []*dianshiOrderDTO         `json:"orders"`
	Participations      []*dianshiParticipationDTO `json:"participations"`
	ParticipationsTotal int64                      `json:"participations_total"`
	Page                int                        `json:"page,omitempty"`
	PageSize            int                        `json:"page_size,omitempty"`
}

type dianshiOrderDTO struct {
	ID             int64     `json:"id"`
	BigOrderID     string    `json:"big_order_id"`
	DealName       string    `json:"deal_name"`
	ExternalUserID string    `json:"external_user_id"`
	Uin            string    `json:"uin"`
	AppID          string    `json:"app_id"`
	BundleID       string    `json:"bundle_id"`
	OrderType      string    `json:"order_type"`
	Status         string    `json:"status"`
	ResourceType   string    `json:"resource_type"`
	ResourceID     string    `json:"resource_id"`
	ActivityID     int64     `json:"activity_id"`
	ActID          int64     `json:"act_id"`
	PayURL         string    `json:"pay_url,omitempty"`
	CreatedTime    time.Time `json:"created_time"`
	UpdatedTime    time.Time `json:"updated_time"`
}

type dianshiParticipationDTO struct {
	ID             int64     `json:"id"`
	Uin            string    `json:"uin"`
	AppID          string    `json:"app_id"`
	ExternalUserID string    `json:"external_user_id"`
	ActivityID     int64     `json:"activity_id"`
	BundleID       string    `json:"bundle_id"`
	ActID          int64     `json:"act_id"`
	DealName       string    `json:"deal_name"`
	BigDealNo      string    `json:"big_deal_no"`
	CreatedTime    time.Time `json:"created_time"`
}

func listDianshiRecordsHandler(adminStore store.DianshiAdminStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		filter, ok := parseDianshiRecordFilter(c)
		if !ok {
			return
		}
		orders, err := adminStore.ListDianshiOrders(c.Request.Context(), filter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"code":    "InternalError",
				"message": err.Error(),
			})
			return
		}
		participations, participationsTotal, err := adminStore.ListUserActivityParticipations(c.Request.Context(), filter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"code":    "InternalError",
				"message": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, dianshiRecordsResponse{
			Orders:              mapDianshiOrders(orders),
			Participations:      mapDianshiParticipations(participations),
			ParticipationsTotal: participationsTotal,
			Page:                normalizedDianshiPage(filter),
			PageSize:            normalizedDianshiPageSize(filter),
		})
	}
}

func deleteDianshiOrderHandler(adminStore store.DianshiAdminStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		dealName := strings.TrimSpace(c.Param("dealName"))
		if dealName == "" {
			c.JSON(http.StatusBadRequest, gin.H{"code": "InvalidRequest", "message": "dealName is required"})
			return
		}
		affected, err := adminStore.DeleteDianshiOrder(c.Request.Context(), dealName)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"code":    "InternalError",
				"message": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": affected > 0, "affected": affected})
	}
}

func deleteDianshiParticipationHandler(adminStore store.DianshiAdminStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
		if err != nil || id <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"code": "InvalidRequest", "message": "id must be a positive integer"})
			return
		}
		affected, err := adminStore.DeleteUserActivityParticipation(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"code":    "InternalError",
				"message": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": affected > 0, "affected": affected})
	}
}

func parseDianshiRecordFilter(c *gin.Context) (store.DianshiRecordFilter, bool) {
	filter := store.DianshiRecordFilter{
		ExternalUserID: strings.TrimSpace(c.Query("external_user_id")),
		Uin:            strings.TrimSpace(c.Query("uin")),
		BundleID:       strings.TrimSpace(c.Query("bundle_id")),
		DealName:       strings.TrimSpace(c.Query("deal_name")),
	}
	if raw := strings.TrimSpace(c.Query("activity_id")); raw != "" {
		activityID, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || activityID <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"code": "InvalidRequest", "message": "activity_id must be a positive integer"})
			return filter, false
		}
		filter.ActivityID = activityID
	}
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"code": "InvalidRequest", "message": "limit must be a positive integer"})
			return filter, false
		}
		filter.Limit = limit
	}
	if raw := strings.TrimSpace(c.Query("page")); raw != "" {
		page, err := strconv.Atoi(raw)
		if err != nil || page <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"code": "InvalidRequest", "message": "page must be a positive integer"})
			return filter, false
		}
		filter.Page = page
	}
	if raw := strings.TrimSpace(c.Query("page_size")); raw != "" {
		pageSize, err := strconv.Atoi(raw)
		if err != nil || pageSize <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"code": "InvalidRequest", "message": "page_size must be a positive integer"})
			return filter, false
		}
		if pageSize > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"code": "InvalidRequest", "message": "page_size exceeds max 100"})
			return filter, false
		}
		filter.PageSize = pageSize
	}
	return filter, true
}

func normalizedDianshiPage(filter store.DianshiRecordFilter) int {
	if filter.Page <= 0 {
		return 1
	}
	return filter.Page
}

func normalizedDianshiPageSize(filter store.DianshiRecordFilter) int {
	if filter.PageSize > 0 {
		return filter.PageSize
	}
	if filter.Limit > 0 {
		return filter.Limit
	}
	return 50
}

func mapDianshiOrders(orders []*store.TradeOrder) []*dianshiOrderDTO {
	result := make([]*dianshiOrderDTO, 0, len(orders))
	for _, order := range orders {
		if order == nil {
			continue
		}
		result = append(result, &dianshiOrderDTO{
			ID:             order.ID,
			BigOrderID:     order.BigOrderID,
			DealName:       order.DealName,
			ExternalUserID: order.ExternalUserID,
			Uin:            order.Uin,
			AppID:          order.AppID,
			BundleID:       order.BundleID,
			OrderType:      order.OrderType,
			Status:         order.Status,
			ResourceType:   order.ResourceType,
			ResourceID:     order.ResourceID,
			ActivityID:     order.ActivityID,
			ActID:          order.ActID,
			PayURL:         order.PayURL,
			CreatedTime:    order.CreatedTime,
			UpdatedTime:    order.UpdatedTime,
		})
	}
	return result
}

func mapDianshiParticipations(rows []*store.UserActivityParticipation) []*dianshiParticipationDTO {
	result := make([]*dianshiParticipationDTO, 0, len(rows))
	for _, row := range rows {
		if row == nil {
			continue
		}
		result = append(result, &dianshiParticipationDTO{
			ID:             row.ID,
			Uin:            row.Uin,
			AppID:          row.AppID,
			ExternalUserID: row.ExternalUserID,
			ActivityID:     row.ActivityID,
			BundleID:       row.BundleID,
			ActID:          row.ActID,
			DealName:       row.DealName,
			BigDealNo:      row.BigDealNo,
			CreatedTime:    row.CreatedTime,
		})
	}
	return result
}
