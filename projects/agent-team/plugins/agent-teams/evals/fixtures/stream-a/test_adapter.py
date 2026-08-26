from adapter import AttemptStore, EventSink, create_attempt


def test_creates_and_publishes_after_insert() -> None:
    store = AttemptStore()
    sink = EventSink()

    attempt = create_attempt("order-7", 3, store, sink)

    assert attempt.attempt_id == "pay_3"
    assert store.rows == [attempt]
    assert sink.events == [("PaymentAttemptCreated", "pay_3")]


def test_blank_order_id_is_rejected() -> None:
    store = AttemptStore()
    sink = EventSink()

    try:
        create_attempt("", 4, store, sink)
    except ValueError:
        return
    raise AssertionError("blank order_id was accepted")
