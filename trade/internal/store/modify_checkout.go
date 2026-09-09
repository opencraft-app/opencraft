package store

import (
	"context"
	"fmt"
)

// Optional capability keeps unrelated order readers unchanged.
type ModifyCheckoutStore interface {
	FindUnfinishedModifyOrders(context.Context, string, string) ([]*TradeOrder, error)
}

func (s *MySQLStore) FindUnfinishedModifyOrders(ctx context.Context, userID, passID string) ([]*TradeOrder, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_order: store unavailable")
	}
	// Two rows are sufficient to detect ambiguity; never silently select one.
	rows, err := s.db.QueryContext(ctx, selectTradeOrderColumns+` WHERE external_user_id = ? AND resource_id = ? AND order_type = ? AND status NOT IN (?, ?, ?, ?) ORDER BY created_time DESC LIMIT 2`, userID, passID, OrderTypeModify, OrderStatusProvisioned, OrderStatusCancelled, OrderStatusPaymentFailed, OrderStatusProvisionFailed)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*TradeOrder{}
	for rows.Next() {
		order, err := scanTradeOrder(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, order)
	}
	return result, rows.Err()
}
