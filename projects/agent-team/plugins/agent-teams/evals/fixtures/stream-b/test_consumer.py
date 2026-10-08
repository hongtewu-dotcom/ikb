from consumer import Order, consume_confirmation


def test_first_confirmation_pays_order() -> None:
    order = Order("order-7")

    assert consume_confirmation(order, "pay_3", "CONFIRMED") is True
    assert order.state == "PAID"
    assert order.paid_attempt_id == "pay_3"


def test_duplicate_confirmation_is_a_no_op() -> None:
    order = Order("order-7")
    consume_confirmation(order, "pay_3", "CONFIRMED")
    version = order.version

    assert consume_confirmation(order, "pay_3", "CONFIRMED") is False
    assert order.version == version
