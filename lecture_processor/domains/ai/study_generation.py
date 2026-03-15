import json
import re

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.runtime.container import get_runtime

try:
    from google.genai import types as genai_types
except Exception:
    genai_types = None


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _get_types_module(runtime):
    return getattr(runtime, 'types', None) or genai_types


def resolve_auto_amount(kind, source_text, runtime=None):
    _ = runtime
    word_count = len((source_text or '').split())
    if kind == 'flashcards':
        if word_count < 1200:
            return 10
        if word_count < 2600:
            return 20
        return 30
    if word_count < 1200:
        return 5
    if word_count < 2600:
        return 10
    return 15


def resolve_study_amounts(flashcard_selection, question_selection, source_text, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    flashcard_amount = (
        resolve_auto_amount('flashcards', source_text, runtime=resolved_runtime)
        if flashcard_selection == 'auto'
        else int(flashcard_selection)
    )
    question_amount = (
        resolve_auto_amount('questions', source_text, runtime=resolved_runtime)
        if question_selection == 'auto'
        else int(question_selection)
    )
    return (flashcard_amount, question_amount)


def extract_json_payload(raw_text, runtime=None):
    _ = runtime
    if not raw_text:
        return None
    text = raw_text.strip()
    if text.startswith('```'):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[0].startswith('```') and (lines[-1].strip() == '```'):
            text = '\n'.join(lines[1:-1]).strip()
    start = text.find('{')
    if start == -1:
        return None
    decoder = json.JSONDecoder()
    try:
        parsed, _index = decoder.raw_decode(text[start:])
        return parsed
    except json.JSONDecodeError:
        end = text.rfind('}')
        if end == -1 or end <= start:
            return None
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None


def sanitize_flashcards(items, max_items, runtime=None):
    _ = runtime
    max_text_len = 2000
    if not isinstance(items, list):
        return []
    cleaned = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        front = normalize_flashcard_front(item.get('front', ''))[:max_text_len]
        back = str(item.get('back', '')).strip()[:max_text_len]
        if not front or not back:
            continue
        key = (front.lower(), back.lower())
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({'front': front, 'back': back})
        if len(cleaned) >= max_items:
            break
    return cleaned


def normalize_flashcard_front(raw_front):
    front = str(raw_front or '').strip()
    if not front:
        return ''
    if front.endswith('?'):
        return front

    compact = re.sub(r'\s+', ' ', front).strip()
    if not compact:
        return ''

    lower = compact.lower()
    question_starts = (
        'what ',
        'which ',
        'who ',
        'when ',
        'where ',
        'why ',
        'how ',
        'list ',
        'name ',
        'identify ',
        'describe ',
        'define ',
        'explain ',
        'give ',
    )
    if any(lower.startswith(prefix) for prefix in question_starts):
        return compact.rstrip('.!') + '?'

    article_match = re.match(r'^(?:the|a|an)\s+(.+)$', compact, flags=re.IGNORECASE)
    if article_match:
        compact = article_match.group(1).strip()

    if not compact:
        return ''

    if re.search(r'\b(?:components|parts|steps|stages|types|examples|causes|effects|symptoms|features)\b', lower):
        return f'List all {compact.rstrip(".!")}?'
    return f'What is {compact.rstrip(".!")}?' 


def sanitize_questions(items, max_items, runtime=None):
    _ = runtime
    max_text_len = 2000
    if not isinstance(items, list):
        return []
    cleaned = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        question = str(item.get('question', '')).strip()[:max_text_len]
        options = item.get('options', [])
        answer = str(item.get('answer', '')).strip()[:max_text_len]
        explanation = str(item.get('explanation', '')).strip()[:max_text_len]
        if not question or not isinstance(options, list) or len(options) != 4 or (not answer):
            continue
        option_strings = [str(option).strip()[:max_text_len] for option in options]
        if any((not option for option in option_strings)):
            continue
        if len(set(option_strings)) != 4:
            continue
        if answer not in option_strings:
            continue
        dedupe_key = question.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        cleaned.append(
            {
                'question': question,
                'options': option_strings,
                'answer': answer,
                'explanation': explanation,
            }
        )
        if len(cleaned) >= max_items:
            break
    return cleaned


def _build_user_content(prompt, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    types_module = _get_types_module(resolved_runtime)
    if types_module and hasattr(types_module, 'Content') and hasattr(types_module, 'Part'):
        return [types_module.Content(role='user', parts=[types_module.Part.from_text(text=prompt)])]
    return [prompt]


def generate_study_materials(
    source_text,
    flashcard_selection,
    question_selection,
    study_features='both',
    output_language='English',
    retry_tracker=None,
    runtime=None,
    include_usage=False,
):
    resolved_runtime = _resolve_runtime(runtime)
    empty_usage = {
        'token_usage_by_stage': {},
        'token_input_total': 0,
        'token_output_total': 0,
        'token_total': 0,
    }
    if study_features == 'none':
        if include_usage:
            return ([], [], None, empty_usage)
        return ([], [], None)

    flashcard_amount, question_amount = resolve_study_amounts(
        flashcard_selection,
        question_selection,
        source_text,
        runtime=resolved_runtime,
    )

    if study_features == 'flashcards':
        question_amount = 0
    elif study_features == 'test':
        flashcard_amount = 0

    max_source_text_len = 120000
    was_truncated = len(source_text) > max_source_text_len

    try:
        prompt = resolved_runtime.PROMPT_STUDY_TEMPLATE.format(
            flashcard_amount=flashcard_amount,
            question_amount=question_amount,
            output_language=output_language,
            source_text=source_text[:max_source_text_len],
        )
        response = ai_provider.generate_with_policy(
            resolved_runtime.MODEL_STUDY,
            _build_user_content(prompt, runtime=resolved_runtime),
            max_output_tokens=32768,
            retry_tracker=retry_tracker,
            operation_name='study_materials_generation',
            runtime=resolved_runtime,
        )
        usage = ai_provider.extract_token_usage(response, runtime=resolved_runtime)
        usage_payload = {
            'token_usage_by_stage': {
                'study_materials_generation': {
                    **usage,
                    'model': resolved_runtime.MODEL_STUDY,
                    'billing_mode': 'standard',
                    'input_modality': 'text',
                }
            },
            'token_input_total': int(usage.get('input_tokens', 0) or 0),
            'token_output_total': int(usage.get('output_tokens', 0) or 0),
            'token_total': int(usage.get('total_tokens', 0) or 0),
        }
        parsed = extract_json_payload(getattr(response, 'text', ''), runtime=resolved_runtime)
        if not isinstance(parsed, dict):
            if include_usage:
                return ([], [], 'Study materials JSON parsing failed.', usage_payload)
            return ([], [], 'Study materials JSON parsing failed.')

        flashcards = sanitize_flashcards(
            parsed.get('flashcards', []),
            flashcard_amount,
            runtime=resolved_runtime,
        )
        test_questions = sanitize_questions(
            parsed.get('test_questions', []),
            question_amount,
            runtime=resolved_runtime,
        )

        if not flashcards and (not test_questions) and (study_features != 'none'):
            if include_usage:
                return ([], [], 'Study materials were empty after validation.', usage_payload)
            return ([], [], 'Study materials were empty after validation.')

        error_msg = None
        if was_truncated:
            error_msg = 'Note: source text was very long and was truncated before study material generation.'
        if include_usage:
            return (flashcards, test_questions, error_msg, usage_payload)
        return (flashcards, test_questions, error_msg)
    except (KeyError, ValueError) as error:
        if include_usage:
            return ([], [], f'Study prompt template formatting failed: {error}', empty_usage)
        return ([], [], f'Study prompt template formatting failed: {error}')
    except Exception as error:
        if include_usage:
            return ([], [], f'Study materials generation failed: {error}', empty_usage)
        return ([], [], f'Study materials generation failed: {error}')


def generate_interview_enhancements(
    transcript_text,
    selected_features,
    output_language='English',
    retry_tracker=None,
    runtime=None,
    include_usage=False,
):
    resolved_runtime = _resolve_runtime(runtime)
    summary_text = None
    sectioned_text = None
    errors = []
    usage_by_stage = {}
    input_total = 0
    output_total = 0
    total_tokens = 0

    for feature in selected_features:
        try:
            if feature == 'summary':
                prompt = resolved_runtime.PROMPT_INTERVIEW_SUMMARY.format(
                    transcript=transcript_text[:120000],
                    output_language=output_language,
                )
                response = ai_provider.generate_with_optional_thinking(
                    resolved_runtime.MODEL_STUDY,
                    prompt,
                    max_output_tokens=8192,
                    thinking_budget=384,
                    retry_tracker=retry_tracker,
                    operation_name='interview_summary_generation',
                    runtime=resolved_runtime,
                )
                usage = ai_provider.extract_token_usage(response, runtime=resolved_runtime)
                usage_by_stage['interview_summary_generation'] = {
                    **usage,
                    'model': resolved_runtime.MODEL_STUDY,
                    'billing_mode': 'standard',
                    'input_modality': 'text',
                }
                input_total += int(usage.get('input_tokens', 0) or 0)
                output_total += int(usage.get('output_tokens', 0) or 0)
                total_tokens += int(usage.get('total_tokens', 0) or 0)
                summary_text = (getattr(response, 'text', '') or '').strip()
                if not summary_text:
                    errors.append('Summary generation returned empty output.')
            elif feature == 'sections':
                prompt = resolved_runtime.PROMPT_INTERVIEW_SECTIONED.format(
                    transcript=transcript_text[:120000],
                    output_language=output_language,
                )
                response = ai_provider.generate_with_optional_thinking(
                    resolved_runtime.MODEL_STUDY,
                    prompt,
                    max_output_tokens=32768,
                    thinking_budget=384,
                    retry_tracker=retry_tracker,
                    operation_name='interview_sections_generation',
                    runtime=resolved_runtime,
                )
                usage = ai_provider.extract_token_usage(response, runtime=resolved_runtime)
                usage_by_stage['interview_sections_generation'] = {
                    **usage,
                    'model': resolved_runtime.MODEL_STUDY,
                    'billing_mode': 'standard',
                    'input_modality': 'text',
                }
                input_total += int(usage.get('input_tokens', 0) or 0)
                output_total += int(usage.get('output_tokens', 0) or 0)
                total_tokens += int(usage.get('total_tokens', 0) or 0)
                sectioned_text = (getattr(response, 'text', '') or '').strip()
                if not sectioned_text:
                    errors.append('Sectioned transcript generation returned empty output.')
        except Exception as error:
            errors.append(f'{feature} generation failed: {error}')

    successful = []
    if summary_text:
        successful.append('summary')
    if sectioned_text:
        successful.append('sections')

    combined_text = None
    if summary_text and sectioned_text:
        combined_text = f'# Interview Summary\n\n{summary_text}\n\n# Structured Interview Transcript\n\n{sectioned_text}'

    failed_count = max(0, len(selected_features) - len(successful))
    response_payload = {
        'summary': summary_text,
        'sections': sectioned_text,
        'combined': combined_text,
        'successful_features': successful,
        'failed_count': failed_count,
        'error': '; '.join(errors) if errors else None,
        'token_usage_by_stage': usage_by_stage,
        'token_input_total': input_total,
        'token_output_total': output_total,
        'token_total': total_tokens,
    }
    if include_usage:
        return response_payload
    return response_payload
