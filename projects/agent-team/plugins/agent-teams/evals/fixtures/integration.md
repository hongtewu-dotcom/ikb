# Integration boundary

`PaymentAttemptCreated` is not a payment confirmation and must not advance an order.
The order consumer receives a later immutable confirmation message containing
`order_id`, `attempt_id`, and `status`. It stores only `attempt_id` as a reference and
does not call back into the payment adapter during the order-state transition.

The final audit should distinguish independent local defects from a cross-boundary
ownership conflict.
