from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def build_admin_deployment_info(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_admin_deployment_info(*args, **kwargs)


def build_admin_runtime_checks(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_admin_runtime_checks(*args, **kwargs)


def get_admin_window(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_admin_window(*args, **kwargs)


def get_timestamp(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_timestamp(*args, **kwargs)


def build_time_buckets(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_time_buckets(*args, **kwargs)


def get_bucket_key(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_bucket_key(*args, **kwargs)


def mark_admin_data_warning(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).mark_admin_data_warning(*args, **kwargs)


def get_admin_data_warnings(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_admin_data_warnings(*args, **kwargs)


def safe_query_docs_in_window(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).safe_query_docs_in_window(*args, **kwargs)


def safe_count_collection(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).safe_count_collection(*args, **kwargs)


def safe_count_window(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).safe_count_window(*args, **kwargs)


def build_admin_funnel_steps(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_admin_funnel_steps(*args, **kwargs)


def build_admin_funnel_daily_rows(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_admin_funnel_daily_rows(*args, **kwargs)


def get_model_pricing_config(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_model_pricing_config(*args, **kwargs)
