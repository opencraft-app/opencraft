# International Tax-Inclusive Pay URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include billing tax in international payment URLs and regular Jifei inquiry prices.

**Architecture:** Decode the amount and nested `taxDetail.taxRate` together from
the JSON-encoded billing `OrderInfos[].PriceDetail`, then calculate integer cents
with a shared exact rational helper used by place-order and inquiry services.
Regular Jifei international inquiries apply tax to all three displayed amount
fields; domestic and Dianshi inquiry paths remain unchanged.

**Tech Stack:** Go, standard library `encoding/json` and `math/big`, Go testing.

## Global Constraints

- Use `PriceDetail.taxDetail.taxRate`, not a sibling `OrderInfos[].TaxDetail` or
  the separate `PriceDetail.taxRate` field.
- Calculate `paid amount * (1 + tax rate)` exactly.
- Round positive fractional cents up to the next whole cent.
- Missing, empty, malformed, or negative tax rates are errors; zero is valid.
- Do not add a decimal-library dependency.
- Apply inquiry tax only to regular Jifei international purchase, batch, and
  renewal paths; do not change domestic or Dianshi inquiry amounts.

---

### Task 1: Decode the Billing Tax Rate

**Files:**
- Modify: `trade/internal/cloudbillingclient/describe_order_list.go`
- Test: `trade/internal/cloudbillingclient/client_test.go`

**Interfaces:**
- Consumes: billing `OrderInfos[].PriceDetail` as a JSON-encoded object string.
- Produces: `OrderInfo.TaxRate string` containing normalized decimal text.

- [x] **Step 1: Write failing response-decoding tests**

Add cases whose `PriceDetail.taxDetail.taxRate` is represented as `"0.07"` or
`0.07`, then assert `OrderInfo.TaxRate == "0.07"`. Add malformed and
missing-tax-rate cases and assert `DescribeOrderList` returns an error.

- [x] **Step 2: Verify the tests fail for the missing field**

Run:

```bash
cd trade && go test ./internal/cloudbillingclient -run 'TestDescribeOrderList|TestDecodeOrderTaxDetail' -count=1
```

Expected: FAIL because `OrderInfo` has no `TaxRate` and nested tax details are
not decoded.

- [x] **Step 3: Implement minimal tax decoding**

Add `TaxRate string` to `OrderInfo` and extend the `PriceDetail` decoder with a
focused nested-tax decoder that accepts a string or number rate via the existing
`billingAmountText` helper. Reject empty, malformed, and negative values while
allowing zero.

- [x] **Step 4: Verify Cloud Billing client tests pass**

Run:

```bash
cd trade && go test ./internal/cloudbillingclient -count=1
```

Expected: PASS.

### Task 1B: Correct DescribeOrderList Tax Detail Layer

**Files:**
- Modify: `trade/internal/cloudbillingclient/describe_order_list.go`
- Test: `trade/internal/cloudbillingclient/client_test.go`

**Interfaces:**
- Consumes: billing `OrderInfos[].PriceDetail` as a JSON-encoded object string.
- Produces: `OrderInfo.TaxRate string` from
  `PriceDetail.taxDetail.taxRate`, alongside the existing amount fields.

- [x] **Step 1: Write a failing real-shape response test**

Change the response fixture so `taxDetail` is inside the escaped `PriceDetail`
JSON string and remove the sibling `OrderInfos[].TaxDetail`. Assert that the
decoded order contains both `realTotalCostHigh` and `TaxRate == "0.07"`.

- [x] **Step 2: Verify the real-shape test fails**

Run:

```bash
cd trade && go test ./internal/cloudbillingclient -run 'TestDescribeOrderListDecodesNestedOrderInfos' -count=1
```

Expected: FAIL with `taxDetail is required` because the old decoder reads the
nonexistent sibling field.

- [x] **Step 3: Decode amount and tax from PriceDetail once**

Remove the sibling `TaxDetail` wire field. Extend `decodeOrderPriceDetail` to
return `(highPrecisionRealTotalCost, realTotalCost, taxRate, error)` and parse
`taxDetail.taxRate` from the same JSON object. Preserve the existing amount
priority and tax validation.

- [x] **Step 4: Verify Cloud Billing and Trade regression tests pass**

Run:

```bash
cd trade && go test ./internal/cloudbillingclient -count=1
cd trade && go test ./...
```

Expected: PASS.

### Task 2: Calculate Tax-Inclusive ChargeAmount

**Files:**
- Modify: `trade/internal/logic/placeorder/service.go`
- Test: `trade/internal/logic/placeorder/service_test.go`

**Interfaces:**
- Consumes: `OrderInfo.TaxRate`, high-precision or fallback real total cost.
- Produces: `chargeAmountFromOrderList(dealName, response) (int64, error)` in cents.

- [x] **Step 1: Write failing amount tests**

Cover `650000000 * (1 + 0.07) == 696` cents, a value whose tax-inclusive total
has a fractional cent and must round up, zero tax, missing tax, malformed tax,
negative tax, and the existing high-precision/fallback amount priority.

- [x] **Step 2: Verify the amount tests fail for untaxed behavior**

Run:

```bash
cd trade && go test ./internal/logic/placeorder -run 'TestChargeAmountFromOrderList' -count=1
```

Expected: FAIL because the current result excludes tax and rejects sub-cent paid amounts before tax calculation.

- [x] **Step 3: Implement exact rational calculation**

Parse the selected paid amount and `TaxRate` with `math/big`. Compute
`paid * (1 + rate) / 1_000_000` as a rational number of cents, add one to the
integer quotient when the positive remainder is non-zero, and reject overflow
or a non-positive result.

- [x] **Step 4: Verify place-order tests pass**

Run:

```bash
cd trade && go test ./internal/logic/placeorder -count=1
```

Expected: PASS.

### Task 3: Share Exact Tax Calculation

**Files:**
- Create: `trade/internal/billingamount/tax.go`
- Create: `trade/internal/billingamount/tax_test.go`
- Modify: `trade/internal/logic/placeorder/service.go`

**Interfaces:**
- Produces: `billingamount.TaxInclusiveCents(rawAmount, taxRate string) (string, error)`.
- Consumes: billing amount in main-currency * 1e8 and a decimal tax rate.

- [x] **Step 1: Write failing calculator tests**

Cover exact tax, fractional-cent round-up, decimal raw values, zero tax,
invalid/non-positive amounts, and missing/malformed/negative tax rates.

- [x] **Step 2: Verify tests fail because the package does not exist**

Run:

```bash
cd trade && go test ./internal/billingamount -count=1
```

Expected: FAIL because the calculator has not been implemented.

- [x] **Step 3: Implement and adopt the shared calculator**

Use `math/big.Rat` for both amount and tax. Divide by `1_000_000` only after
multiplication, round a positive remainder up, return integer cents as decimal
text, and replace the private place-order arithmetic with this helper.

- [x] **Step 4: Verify calculator and place-order tests pass**

Run:

```bash
cd trade && go test ./internal/billingamount ./internal/logic/placeorder -count=1
```

Expected: PASS.

### Task 4: Return Tax-Inclusive Jifei Inquiry Prices

**Files:**
- Modify: `trade/internal/jifeiclient/getprice.go`
- Modify: `trade/internal/logic/inquiry/service.go`
- Test: `trade/internal/logic/inquiry/service_site_kind_test.go`
- Test: `trade/internal/logic/inquiry/service_test.go`

**Interfaces:**
- Consumes: `GetPriceData.TaxDetail.TaxRate` and each selected amount field.
- Produces: tax-inclusive `QuoteResult.Price`, `TotalCost`, and `RealTotalCost` in cents.

- [x] **Step 1: Write failing international inquiry tests**

Assert 7% tax changes `650/1400/1200` cents to `696/1498/1284` for purchase
and renewal, batch applies each item's own rate, and missing/malformed/negative
rates return errors. Keep domestic and Dianshi expectations unchanged.

- [x] **Step 2: Verify inquiry tests fail with untaxed values**

Run:

```bash
cd trade && go test ./internal/logic/inquiry -run 'TestQuote.*Tax|TestQuoteBatch.*Tax|TestQuote_IntlHighPrecision' -count=1
```

Expected: FAIL because `GetPriceData` does not retain or apply tax details.

- [x] **Step 3: Implement Jifei inquiry tax mapping**

Add a typed `TaxDetail` to `GetPriceData`. Change amount mapping to return an
error for invalid international Jifei tax data, select high-precision fields
with legacy amount fallback, and call `billingamount.TaxInclusiveCents` for all
three fields. Propagate errors through single, batch, and renewal quote paths.

- [x] **Step 4: Verify inquiry and regression tests pass**

Run:

```bash
cd trade && go test ./internal/jifeiclient ./internal/logic/inquiry -count=1
cd trade && go test ./...
```

Expected: PASS.

- [x] **Step 5: Run Trade regression tests**

Run:

```bash
cd trade && go test ./...
```

Expected: PASS.
