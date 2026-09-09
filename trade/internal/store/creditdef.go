package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

var ErrCreditDefinitionNotFound = errors.New("trade_credit_definition: not found")

type CreditDefinition struct {
	ID             int64
	ProductID      string
	ProductCode    string
	SubProductCode string
	Pid            int64
	CategoryIDs    []CategoryIDEntry
	SVList         map[string]int64
	ProductInfo    []map[string]interface{}
}

func (d *CreditDefinition) CategoryIDForScene(scene string) int64 {
	if d == nil {
		return 0
	}
	for _, e := range d.CategoryIDs {
		if e.Scene == scene {
			return e.Category
		}
	}
	return 0
}

type CreditDefinitionStore interface {
	GetCreditDefinitionByProductID(ctx context.Context, productID string) (*CreditDefinition, error)
	ListCreditDefinitions(ctx context.Context, productCode, subProductCode string) ([]*CreditDefinition, error)
}

var _ CreditDefinitionStore = (*MySQLStore)(nil)

func (s *MySQLStore) GetCreditDefinitionByProductID(ctx context.Context, productID string) (*CreditDefinition, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_credit_definition: store is nil")
	}
	const q = `
		SELECT id, product_id, product_code, sub_product_code, pid,
		       category_ids, sv_list, product_info
		  FROM trade_credit_definition
		 WHERE product_id = ?
	`
	var (
		id                                 int64
		pID, prodCode, subProdCode         string
		pid                                int64
		categoryRaw, svRaw, productInfoRaw []byte
	)
	err := s.db.QueryRowContext(ctx, q, productID).Scan(
		&id, &pID, &prodCode, &subProdCode, &pid,
		&categoryRaw, &svRaw, &productInfoRaw,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCreditDefinitionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_credit_definition: query productID=%s: %w", productID, err)
	}
	def, err := decodeCreditDefinition(id, pID, prodCode, subProdCode, pid, categoryRaw, svRaw, productInfoRaw)
	if err != nil {
		return nil, fmt.Errorf("trade_credit_definition: decode productID=%s: %w", productID, err)
	}
	return def, nil
}

func (s *MySQLStore) ListCreditDefinitions(ctx context.Context, productCode, subProductCode string) ([]*CreditDefinition, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_credit_definition: store is nil")
	}
	query := `
		SELECT id, product_id, product_code, sub_product_code, pid,
		       category_ids, sv_list, product_info
		  FROM trade_credit_definition
		 WHERE 1 = 1
	`
	args := make([]any, 0, 2)
	if productCode != "" {
		query += ` AND product_code = ?`
		args = append(args, productCode)
	}
	if subProductCode != "" {
		query += ` AND sub_product_code = ?`
		args = append(args, subProductCode)
	}
	query += ` ORDER BY id ASC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("trade_credit_definition: list: %w", err)
	}
	defer rows.Close()
	definitions := make([]*CreditDefinition, 0)
	for rows.Next() {
		var (
			id                                 int64
			productID, prodCode, subProdCode   string
			pid                                int64
			categoryRaw, svRaw, productInfoRaw []byte
		)
		if err := rows.Scan(
			&id, &productID, &prodCode, &subProdCode, &pid,
			&categoryRaw, &svRaw, &productInfoRaw,
		); err != nil {
			return nil, err
		}
		def, err := decodeCreditDefinition(id, productID, prodCode, subProdCode, pid, categoryRaw, svRaw, productInfoRaw)
		if err != nil {
			return nil, fmt.Errorf("trade_credit_definition: decode productID=%s: %w", productID, err)
		}
		definitions = append(definitions, def)
	}
	return definitions, rows.Err()
}

func decodeCreditDefinition(
	id int64,
	productID, prodCode, subProdCode string,
	pid int64,
	categoryRaw, svRaw, productInfoRaw []byte,
) (*CreditDefinition, error) {
	def := &CreditDefinition{
		ID:             id,
		ProductID:      productID,
		ProductCode:    prodCode,
		SubProductCode: subProdCode,
		Pid:            pid,
	}
	if len(categoryRaw) > 0 {
		if err := json.Unmarshal(categoryRaw, &def.CategoryIDs); err != nil {
			return nil, fmt.Errorf("category_ids unmarshal: %w", err)
		}
	}
	if len(svRaw) > 0 {
		if err := json.Unmarshal(svRaw, &def.SVList); err != nil {
			return nil, fmt.Errorf("sv_list unmarshal: %w", err)
		}
	}
	if len(productInfoRaw) > 0 {
		if err := json.Unmarshal(productInfoRaw, &def.ProductInfo); err != nil {
			return nil, fmt.Errorf("product_info unmarshal: %w", err)
		}
	}
	return def, nil
}
