from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def count_active_jobs_for_user(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).count_active_jobs_for_user(*args, **kwargs)


def list_docs_by_uid(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).list_docs_by_uid(*args, **kwargs)


def delete_docs_by_uid(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).delete_docs_by_uid(*args, **kwargs)


def remove_upload_artifacts_for_job_ids(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).remove_upload_artifacts_for_job_ids(*args, **kwargs)


def anonymize_purchase_docs_by_uid(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).anonymize_purchase_docs_by_uid(*args, **kwargs)


def collect_user_export_payload(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).collect_user_export_payload(*args, **kwargs)
