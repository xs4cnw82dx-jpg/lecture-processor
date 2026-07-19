"""Typed runtime-job persistence contract.

Keep this module dependency-free so both the legacy runtime adapter and the
domain store can share one authoritative allowlist.
"""

from typing import Any, Protocol, TypedDict


class RuntimeJobRecord(TypedDict, total=False):
    job_id: str
    status: str
    step: int
    step_description: str
    total_steps: int
    mode: str
    job_scope: str
    user_id: str
    user_email: str
    started_at: float
    finished_at: float
    result: Any
    error: str
    failed_stage: str
    provider_error_code: str
    retry_attempts: int
    file_size_mb: float
    source_type: str
    source_name: str
    prompt_template_key: str
    prompt_source: str
    custom_prompt_length: int
    billing_receipt: dict[str, Any]


class RuntimeJobsCapability(Protocol):
    """Minimum explicit capability used by runtime-job consumers."""

    def get_job_snapshot(self, job_id: str) -> RuntimeJobRecord | None: ...

    def update_job_fields(self, job_id: str, **fields: Any) -> RuntimeJobRecord | None: ...

    def set_job(self, job_id: str, value: RuntimeJobRecord) -> RuntimeJobRecord | None: ...

    def delete_job(self, job_id: str) -> bool: ...


PERSISTED_RUNTIME_JOB_FIELDS = frozenset({
    'status', 'step', 'step_description', 'total_steps', 'mode', 'job_scope',
    'tool_source_type', 'tool_input_name', 'user_id', 'user_email',
    'credit_deducted', 'credit_refunded', 'credit_refund_method',
    'started_at', 'finished_at', 'result', 'slide_text', 'transcript',
    'flashcards', 'test_questions', 'flashcard_selection', 'question_selection',
    'study_features', 'output_language', 'study_generation_error',
    'study_pack_id', 'study_pack_title', 'folder_id', 'folder_name', 'error',
    'billing_receipt', 'interview_features', 'interview_features_successful',
    'interview_summary', 'interview_sections', 'interview_combined',
    'interview_features_cost', 'extra_slides_refunded',
    'extra_slides_refund_pending', 'audio_storage_key', 'notes_audio_map',
    'transcript_segments', 'token_usage_by_stage', 'token_input_total',
    'token_output_total', 'token_total', 'export_manifest', 'is_batch',
    'batch_parent_id', 'batch_row_id', 'processing_strategy', 'billing_mode',
    'billing_multiplier', 'stage_costs', 'voice_note_tags', 'voice_note_pinned',
    'voice_note_archived', 'voice_note_custom_instruction',
    'voice_note_append_to_pack_id', 'study_tools_credit_cost',
    # Operational and admin fields must survive a process restart too.
    'failed_stage', 'provider_error_code', 'retry_attempts', 'file_size_mb',
    'source_type', 'source_name', 'prompt_template_key', 'prompt_source',
    'custom_prompt_length', 'last_heartbeat_at', 'recovery_claimed_at',
})
