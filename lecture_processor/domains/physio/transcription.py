"""Background transcription jobs for Physio Assistant."""

from __future__ import annotations

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.runtime.container import get_runtime

from . import prompts as physio_prompts


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def process_physio_transcription(job_id, audio_path, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    gemini_files = []
    local_paths = [audio_path]
    set_fields = lambda **fields: runtime_jobs_store.update_job_fields(job_id, runtime=resolved_runtime, **fields)
    get_fields = lambda: runtime_jobs_store.get_job_snapshot(job_id, runtime=resolved_runtime) or {}
    tokens = ai_provider.TokenAccumulator(runtime=resolved_runtime)
    retry_tracker = {}
    failed_stage = "initialization"

    try:
        set_fields(status="processing", step=1, step_description="Audio voorbereiden...")
        converted_audio_path, converted = resolved_runtime.convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_audio_path not in local_paths:
            local_paths.append(converted_audio_path)

        audio_mime_type = resolved_runtime.get_mime_type(converted_audio_path)
        failed_stage = "audio_upload"
        audio_file = ai_provider.run_with_provider_retry(
            "physio_audio_upload",
            lambda: resolved_runtime.client.files.upload(file=converted_audio_path, config={"mime_type": audio_mime_type}),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )
        gemini_files.append(audio_file)

        set_fields(step_description="Audio wordt verwerkt...")
        failed_stage = "audio_file_processing"
        ai_provider.run_with_provider_retry(
            "physio_audio_file_processing",
            lambda: resolved_runtime.wait_for_file_processing(audio_file),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )

        set_fields(step_description="Transcript genereren...")
        failed_stage = "physio_transcription"
        response = ai_provider.generate_with_policy(
            getattr(resolved_runtime, "MODEL_INTERVIEW", "gemini-2.5-pro"),
            [
                resolved_runtime.types.Content(
                    role="user",
                    parts=[
                        resolved_runtime.types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type),
                        resolved_runtime.types.Part.from_text(text=physio_prompts.PHYSIO_TRANSCRIPTION_PROMPT),
                    ],
                )
            ],
            max_output_tokens=65536,
            retry_tracker=retry_tracker,
            operation_name="physio_transcription",
            runtime=resolved_runtime,
        )
        tokens.record(
            "physio_transcription",
            response,
            model=getattr(resolved_runtime, "MODEL_INTERVIEW", "gemini-2.5-pro"),
            billing_mode="internal",
            input_modality="audio",
        )
        transcript_text = str(getattr(response, "text", "") or "").strip()
        if not transcript_text:
            raise ValueError("Transcript generation returned empty output.")
        set_fields(
            status="complete",
            step=2,
            step_description="Klaar",
            transcript=transcript_text,
            result=transcript_text,
        )
    except Exception as error:
        resolved_runtime.logger.exception("Physio transcription failed for job %s", job_id)
        set_fields(
            status="error",
            error=resolved_runtime.PROCESSING_PUBLIC_ERROR_MESSAGE,
            failed_stage=failed_stage,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            provider_error_code=ai_provider.classify_provider_error_code(error, runtime=resolved_runtime),
        )
    finally:
        resolved_runtime.cleanup_files(local_paths, gemini_files)
        finished_at = resolved_runtime.time.time()
        set_fields(
            finished_at=finished_at,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            **tokens.as_dict(),
        )
        final_job = get_fields()
        resolved_runtime.save_job_log(job_id, final_job, finished_at)
