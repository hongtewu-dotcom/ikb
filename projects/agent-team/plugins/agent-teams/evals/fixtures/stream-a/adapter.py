from dataclasses import dataclass


@dataclass(frozen=True)
class PaymentAttempt:
    attempt_id: str
    order_id: str
    state: str


class AttemptStore:
    def __init__(self) -> None:
        self.rows: list[PaymentAttempt] = []

    def insert(self, attempt: PaymentAttempt) -> None:
        self.rows.append(attempt)


class EventSink:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def publish(self, event_type: str, attempt_id: str) -> None:
        self.events.append((event_type, attempt_id))


def create_attempt(
    order_id: str,
    sequence: int,
    store: AttemptStore,
    sink: EventSink,
) -> PaymentAttempt:
    attempt = PaymentAttempt(
        attempt_id=f"pay_{sequence}",
        order_id=order_id,
        state="CREATED",
    )
    store.insert(attempt)
    sink.publish("PaymentAttemptCreated", attempt.attempt_id)
    return attempt
