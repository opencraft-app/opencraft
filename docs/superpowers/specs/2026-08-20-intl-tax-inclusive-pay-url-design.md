# International Tax-Inclusive Pay URL Design

## Goal

When an international site generates a payment URL, pass a tax-inclusive
`ChargeAmount` to billing `CreatePayUrl`. Return tax-inclusive `price`,
`total_cost`, and `real_total_cost` for regular Jifei international inquiries.

## Confirmed Upstream Shape

A KR inquiry on 2026-08-20 returned the tax rate as a decimal string at
`taxDetail.taxRate` (for example, `"0.07"`). The implementation deliberately
uses this nested field instead of the separate top-level `taxRate` field.

An actual KR `DescribeOrderList` call on 2026-08-20 confirmed that each order's
`PriceDetail` is a JSON-encoded object string containing both the amount fields
and `taxDetail.taxRate`. There is no sibling `OrderInfos[].TaxDetail` field in
the observed response.

## Data Flow

1. Decode `OrderInfos[].PriceDetail` once and extract the amount fields plus
   `taxDetail.taxRate` into `cloudbillingclient.OrderInfo`, accepting either a
   JSON string or number for the rate itself.
2. Select the paid amount using the existing priority:
   `highPrecisionPrice.realTotalCostHigh`, then `realTotalCost`.
3. Calculate the tax-inclusive amount exactly as
   `paid amount * (1 + tax rate)` using rational arithmetic.
4. Convert the result from the billing high-precision unit to cents and round
   any positive fractional-cent remainder up to the next whole cent.
5. Pass the resulting integer cents as `CreatePayUrl.ChargeAmount`.

For regular Jifei international purchase, batch, and renewal inquiries, decode
`taxDetail.taxRate` from each `GetPrice` item and apply the same calculation to
all three high-precision amount fields before returning cents. Domestic inquiry
amounts remain unchanged. Dianshi activity inquiries remain unchanged because
their response does not currently provide a tax rate.

## Validation

- Missing, empty, malformed, or negative `taxDetail.taxRate` is an error.
- A zero tax rate is valid.
- Invalid or non-positive paid amounts remain errors.
- No `CreatePayUrl` request is sent when amount or tax validation fails.
- A regular Jifei international inquiry fails when its tax rate is missing or
  invalid; domestic and Dianshi inquiry paths do not require this field.

## Tests

- Decode `PriceDetail.taxDetail.taxRate` from string and numeric
  representations.
- Reject malformed tax details and tax rates.
- Calculate a tax-inclusive amount with exact decimal arithmetic.
- Round positive fractional cents up to the next whole cent.
- Preserve high-precision paid amount priority and legacy fallback behavior.
- Verify missing and negative tax rates fail before `CreatePayUrl`.
- Verify international purchase, batch, and renewal inquiry amounts include tax.
- Verify domestic and Dianshi inquiry amounts remain unchanged.
