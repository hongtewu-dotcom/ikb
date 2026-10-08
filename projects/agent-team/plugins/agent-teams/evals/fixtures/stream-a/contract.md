# Payment attempt adapter contract

The adapter is the only creator and writer of payment attempts.

Required behavior:

- A1: reject a blank `order_id` before allocating an attempt.
- A2: allocate identifiers with the `pay_` prefix.
- A3: persist the original `order_id` unchanged.
- A4: start every new attempt in `CREATED` state.
- A5: keep `attempt_id` immutable after creation.
- A6: emit `PaymentAttemptCreated` only after persistence succeeds.

The audit must cite the exact contract rule and implementation line for every mismatch.
