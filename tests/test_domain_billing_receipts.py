from lecture_processor.domains.billing import receipts
from lecture_processor.runtime.container import get_runtime


def test_normalize_credit_ledger_filters_invalid_values():
    assert receipts.normalize_credit_ledger({"a": 1, "b": 0, "": 9, "c": "x"}) == {"a": 1}


def test_ensure_job_billing_receipt_and_refunds_update_receipt(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.time, "time", lambda: 123.0)

    job = {}
    receipt = receipts.ensure_job_billing_receipt(job, {"slides_credits": 1}, runtime=runtime)
    assert receipt["charged"] == {"slides_credits": 1}
    assert receipt["refunded"] == {}

    receipts.add_job_credit_refund(job, "slides_credits", amount=2, runtime=runtime)
    assert job["billing_receipt"]["refunded"] == {"slides_credits": 2}

    snapshot = receipts.get_billing_receipt_snapshot(job, runtime=runtime)
    assert snapshot["charged"] == {"slides_credits": 1}
    assert snapshot["refunded"] == {"slides_credits": 2}
