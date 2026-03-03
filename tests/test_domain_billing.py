from lecture_processor.domains.billing import credits
from lecture_processor.domains.billing import purchases
from lecture_processor.runtime.container import get_runtime


def test_billing_dispatch_uses_explicit_runtime():
    class _Runtime:
        def grant_credits_to_user(self, uid, bundle):
            return f"grant:{uid}:{bundle}"

        def deduct_credit(self, uid, *credit_types):
            return f"deduct:{uid}:{','.join(credit_types)}"

        def deduct_interview_credit(self, uid):
            return f"interview:{uid}"

        def refund_credit(self, uid, credit_type):
            return f"refund:{uid}:{credit_type}"

        def deduct_slides_credits(self, uid, amount):
            return f"slides_deduct:{uid}:{amount}"

        def refund_slides_credits(self, uid, amount):
            return f"slides_refund:{uid}:{amount}"

        def save_purchase_record(self, session):
            return f"save:{session}"

        def purchase_record_exists_for_session(self, session_id):
            return session_id == "existing"

        def process_checkout_session_credits(self, session):
            return (True, f"processed:{session}")

    runtime = _Runtime()
    assert credits.grant_credits_to_user("u1", "lecture_5", runtime=runtime) == "grant:u1:lecture_5"
    assert credits.deduct_credit("u1", "slides_credits", runtime=runtime) == "deduct:u1:slides_credits"
    assert credits.deduct_interview_credit("u2", runtime=runtime) == "interview:u2"
    assert credits.refund_credit("u3", "slides_credits", runtime=runtime) == "refund:u3:slides_credits"
    assert credits.deduct_slides_credits("u4", 2, runtime=runtime) == "slides_deduct:u4:2"
    assert credits.refund_slides_credits("u4", 2, runtime=runtime) == "slides_refund:u4:2"
    assert purchases.save_purchase_record("sess-1", runtime=runtime) == "save:sess-1"
    assert purchases.purchase_record_exists_for_session("existing", runtime=runtime) is True
    assert purchases.process_checkout_session_credits("sess-2", runtime=runtime) == (True, "processed:sess-2")


def test_billing_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "deduct_credit", lambda uid, *credit_types: (uid, credit_types))
    monkeypatch.setattr(runtime.core, "process_checkout_session_credits", lambda session: (False, f"noop:{session}"))

    with app.app_context():
        assert credits.deduct_credit("u1", "lecture_credits_standard") == ("u1", ("lecture_credits_standard",))
        assert purchases.process_checkout_session_credits("sess-x") == (False, "noop:sess-x")
