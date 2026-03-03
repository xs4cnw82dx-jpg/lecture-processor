from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def markdown_to_docx(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).markdown_to_docx(*args, **kwargs)


def normalize_exam_date(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).normalize_exam_date(*args, **kwargs)


def markdown_inline_to_pdf_html(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).markdown_inline_to_pdf_html(*args, **kwargs)


def append_notes_markdown_to_story(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).append_notes_markdown_to_story(*args, **kwargs)


def build_study_pack_pdf(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_study_pack_pdf(*args, **kwargs)
