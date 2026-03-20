"""Focused media/file helpers used by the legacy runtime shell."""

import os

from lecture_processor.services import file_service


def get_ffmpeg_binary(*, which_func, imageio_ffmpeg_module=None):
    return file_service.get_ffmpeg_binary(
        which_func=which_func,
        imageio_ffmpeg_module=imageio_ffmpeg_module,
    )


def get_ffprobe_binary(*, ffmpeg_binary_getter):
    return file_service.get_ffprobe_binary(ffmpeg_binary_getter=ffmpeg_binary_getter)


def download_audio_from_video_url(
    source_url,
    file_prefix,
    *,
    upload_folder,
    max_audio_upload_bytes,
    ffmpeg_binary_getter,
    file_looks_like_audio_fn,
    get_saved_file_size_fn,
    which_func,
    subprocess_module,
):
    return file_service.download_audio_from_video_url(
        source_url,
        file_prefix,
        upload_folder=upload_folder,
        max_audio_upload_bytes=max_audio_upload_bytes,
        ffmpeg_binary_getter=ffmpeg_binary_getter,
        file_looks_like_audio_fn=file_looks_like_audio_fn,
        get_saved_file_size_fn=get_saved_file_size_fn,
        which_func=which_func,
        subprocess_module=subprocess_module,
    )


def get_soffice_binary(*, env_getter, which_func):
    return file_service.get_soffice_binary(env_getter=env_getter, which_func=which_func)


def convert_pptx_to_pdf(source_path, target_pdf_path, *, soffice_binary_getter, subprocess_module):
    return file_service.convert_pptx_to_pdf(
        source_path,
        target_pdf_path,
        soffice_binary_getter=soffice_binary_getter,
        subprocess_module=subprocess_module,
    )


def resolve_uploaded_slides_to_pdf(
    uploaded_file,
    job_id,
    *,
    upload_folder,
    allowed_slide_extensions,
    allowed_slide_mime_types,
    max_pdf_upload_bytes,
    cleanup_files_fn,
    secure_filename_fn,
    allowed_file_fn,
    file_has_pdf_signature_fn,
    file_has_pptx_signature_fn,
    convert_pptx_to_pdf_fn,
    get_saved_file_size_fn,
):
    return file_service.resolve_uploaded_slides_to_pdf(
        uploaded_file,
        job_id,
        upload_folder=upload_folder,
        allowed_slide_extensions=allowed_slide_extensions,
        allowed_slide_mime_types=allowed_slide_mime_types,
        max_pdf_upload_bytes=max_pdf_upload_bytes,
        cleanup_files_fn=cleanup_files_fn,
        secure_filename_fn=secure_filename_fn,
        allowed_file_fn=allowed_file_fn,
        file_has_pdf_signature_fn=file_has_pdf_signature_fn,
        file_has_pptx_signature_fn=file_has_pptx_signature_fn,
        convert_pptx_to_pdf_fn=convert_pptx_to_pdf_fn,
        get_saved_file_size_fn=get_saved_file_size_fn,
    )


def file_looks_like_audio(path, *, ffprobe_binary_getter, subprocess_module):
    return file_service.file_looks_like_audio(
        path,
        ffprobe_binary_getter=ffprobe_binary_getter,
        subprocess_module=subprocess_module,
    )


def wait_for_file_processing(
    uploaded_file,
    *,
    client,
    logger,
    time_module,
    is_transient_provider_error_fn,
    classify_provider_error_code_fn,
    max_wait_time=300,
    wait_interval=5,
):
    total_waited = 0
    while total_waited < max_wait_time:
        try:
            file_info = client.files.get(name=uploaded_file.name)
        except Exception as error:
            if not is_transient_provider_error_fn(error):
                raise
            logger.warning(
                'Transient error while checking file status for %s (code=%s): %s',
                getattr(uploaded_file, 'name', '<unknown>'),
                classify_provider_error_code_fn(error),
                error,
            )
            time_module.sleep(wait_interval)
            total_waited += wait_interval
            continue

        state_name = getattr(getattr(file_info, 'state', None), 'name', '')
        if state_name == 'ACTIVE':
            return True
        if state_name == 'FAILED':
            raise Exception(f'File processing failed: {uploaded_file.name}')

        time_module.sleep(wait_interval)
        total_waited += wait_interval

    raise Exception(f'File processing timed out after {max_wait_time} seconds')


def cleanup_files(local_paths, gemini_files, *, client, logger, os_module=os):
    for path in local_paths:
        try:
            if os_module.path.exists(path):
                os_module.remove(path)
        except Exception as error:
            logger.warning('Could not delete local file %s: %s', path, error)

    for gemini_file in gemini_files:
        try:
            client.files.delete(name=gemini_file.name)
        except Exception as error:
            logger.warning(
                'Could not delete Gemini file %s: %s',
                getattr(gemini_file, 'name', '<unknown>'),
                error,
            )
