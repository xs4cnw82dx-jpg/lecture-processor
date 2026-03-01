def init_extensions(app) -> None:
    """Placeholder extension hook for future modularization batches.

    Batch R1 keeps behavior unchanged and does not reinitialize runtime services.
    """
    if app is None:
        return
    if not hasattr(app, 'extensions'):
        return
    app.extensions.setdefault('lecture_processor', {})
    app.extensions['lecture_processor']['factory_initialized'] = True
