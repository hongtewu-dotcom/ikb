# Order confirmation consumer contract

The order service is the only writer of order state.

Required behavior:

- B1: ignore payment events whose status is not `CONFIRMED`.
- B2: transition `PENDING_PAYMENT` to `PAID` for the first confirmed attempt.
- B3: treat a duplicate confirmation for the same attempt as a no-op.
- B4: retain the confirming `attempt_id` as a reference.
- B5: never mutate payment-attempt data.
- B6: reject confirmation of a second attempt after the order is already paid.

The audit must cite the exact contract rule and implementation line for every mismatch.
