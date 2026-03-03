from lecture_processor.domains.billing import receipts
from lecture_processor.runtime.container import get_runtime


def test_billing_receipts_dispatch_uses_explicit_runtime():
    class _Runtime:
        def normalize_credit_ledger(self, value):
            return {"normalized": value}

        def initialize_billing_receipt(self, charged):
            return {"charged": dict(charged), "refunded": {}}

        def ensure_job_billing_receipt(self, job):
            return {"job": job}

        def add_job_credit_refund(self, job, credit_type, amount=1):
            return {"job": job, "credit_type": credit_type, "amount": amount}

        def get_billing_receipt_snapshot(self, job):
            return {"charged": job.get("charged", {}), "refunded": job.get("refunded", {})}

    runtime = _Runtime()
    assert receipts.normalize_credit_ledger({"a": 1}, runtime=runtime) == {"normalized": {"a": 1}}
    assert receipts.initialize_billing_receipt({"slides_credits": 1}, runtime=runtime) == {
        "charged": {"slides_credits": 1},
        "refunded": {},
    }
    assert receipts.ensure_job_billing_receipt({"id": "j1"}, runtime=runtime) == {"job": {"id": "j1"}}
    assert receipts.add_job_credit_refund({"id": "j1"}, "slides_credits", amount=2, runtime=runtime) == {
        "job": {"id": "j1"},
        "credit_type": "slides_credits",
        "amount": 2,
    }
    assert receipts.get_billing_receipt_snapshot({"charged": {"x": 1}}, runtime=runtime) == {
        "charged": {"x": 1},
        "refunded": {},
    }


def test_billing_receipts_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "initialize_billing_receipt", lambda charged: {"charged": charged, "refunded": {"z": 1}})

    with app.app_context():
        assert receipts.initialize_billing_receipt({"lecture_credits_standard": 1}) == {
            "charged": {"lecture_credits_standard": 1},
            "refunded": {"z": 1},
        }
