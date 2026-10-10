package store

import (
	"context"
	"fmt"
	"strings"
)

func (s *MySQLStore) SyncPoolSupplyOverview(ctx context.Context, rows []PoolSupplyOverview) error {
	if err := validatePoolSupplyRows(rows); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, row := range rows {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO pool_supply_overview (region, zone, instance_type, sales_state)
			VALUES (?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE sales_state = VALUES(sales_state)
		`, row.Region, row.Zone, row.InstanceType, row.SalesState)
		if err != nil {
			return fmt.Errorf("upsert pool supply state %s/%s/%s: %w", row.Region, row.Zone, row.InstanceType, err)
		}
		if row.Inventory == nil {
			continue
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE pool_supply_overview SET resource_count = ?, request_id = ?, updated_time = ?
			WHERE region = ? AND zone = ? AND instance_type = ?
		`, row.Inventory.ResourceCount, row.Inventory.RequestID, row.Inventory.UpdatedTime.UTC(), row.Region, row.Zone, row.InstanceType)
		if err != nil {
			return fmt.Errorf("update pool supply inventory %s/%s/%s: %w", row.Region, row.Zone, row.InstanceType, err)
		}
	}

	if len(rows) == 0 {
		if _, err := tx.ExecContext(ctx, "DELETE FROM pool_supply_overview"); err != nil {
			return err
		}
	} else {
		placeholders := make([]string, len(rows))
		args := make([]interface{}, 0, len(rows)*3)
		for i, row := range rows {
			placeholders[i] = "(?, ?, ?)"
			args = append(args, row.Region, row.Zone, row.InstanceType)
		}
		query := "DELETE FROM pool_supply_overview WHERE (region, zone, instance_type) NOT IN (" + strings.Join(placeholders, ", ") + ")"
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("delete obsolete pool supply keys: %w", err)
		}
	}
	return tx.Commit()
}
