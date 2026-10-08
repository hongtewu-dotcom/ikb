from dataclasses import dataclass


@dataclass
class Order:
    order_id: str
    state: str = "PENDING_PAYMENT"
    paid_attempt_id: str | None = None
    version: int = 0


def consume_confirmation(order: Order, attempt_id: str, status: str) -> bool:
    if status != "CONFIRMED":
        return False

    if order.state == "PAID" and order.paid_attempt_id != attempt_id:
        raise ValueError("order already paid by another attempt")

    if order.state == "PAID" and order.paid_attempt_id == attempt_id:
        order.version += 1
        return False

    order.state = "PAID"
    order.paid_attempt_id = attempt_id
    order.version += 1
    return True
