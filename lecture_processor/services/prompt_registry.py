"""Prompt templates and inventory helpers for Lecture Processor."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List


PROMPT_REGISTRY_VERSION = "2026-03-02"


PROMPT_SLIDE_EXTRACTION = """Extract all textual content from the attached slide deck PDF and identify the role of visual elements.
Instructions:
1. Clearly label each slide by number (for example: "Slide 1:").
2. Include the slide title.
3. Include all textual content (bullet points, paragraphs) from each slide.
4. Identify where images or tables appear, using strict rules:
   - Informative: Use this placeholder ONLY when the image/table contains text, data, charts, diagrams, flowcharts, or a specific scientific/technical visual that is essential for understanding. Format: [Informative Image/Table: neutral description of what is visible or the topic]
   - Decorative: Use this placeholder for photos of people/landscapes, logos, background illustrations, stock photos, or mood visuals. If uncertain, classify as decorative. Format: [Decorative Image]
5. Omit the phrase "Share Your talent move the world" if present.
6. Return plain text only, without Word-specific formatting beyond slide labels and placeholders."""

PROMPT_AUDIO_TRANSCRIPTION = """Create an accurate and clean transcript of the attached audio file.
Instructions:
1. Transcribe the spoken text as literally as possible.
2. Remove filler words and hesitations (such as "uh", "um", "you know") to improve readability while preserving the full meaning. Do not rewrite sentence structure.
3. Do not include timestamps.
4. Use paragraphs to split up longer speaking turns.
5. Write the final output fully in this language: {output_language}."""

PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED = """Create an accurate transcript with time segments from the attached audio file.

Return ONLY valid JSON, without markdown or extra text, in exactly this format:
{{
  "transcript_segments": [
    {{
      "start_ms": 0,
      "end_ms": 10000,
      "text": "..."
    }}
  ],
  "full_transcript": "..."
}}

Rules:
- Use natural segments of about 5-25 seconds.
- start_ms and end_ms are milliseconds from the beginning.
- Remove filler words and hesitations to improve readability without losing content.
- full_transcript contains the complete transcript as continuous text.
- Write transcript text fully in this language: {output_language}."""

PROMPT_INTERVIEW_TRANSCRIPTION = """Transcribe this interview in the format: timecode (mm:ss) - speaker - caption.
Rules:
- Use speaker A, speaker B, etc. to identify speakers.
- Keep timestamps in each line.
- Write the output fully in this language: {output_language}."""

PROMPT_INTERVIEW_SUMMARY = """You are an expert interviewer analyst.
Create a concise summary of this interview.
Rules:
- Maximum one page equivalent (about 400-600 words).
- Focus only on the most important points, commitments, and conclusions.
- Use short headings and bullet points where useful.
- Do not invent information outside the transcript.
- Write the output fully in this language: {output_language}.
Transcript:
{transcript}
"""

PROMPT_INTERVIEW_SECTIONED = """You are an expert transcript editor.
Rewrite this interview transcript into a structured version with clear headings.
Rules:
- Keep timestamps and speaker labels from the source where possible.
- Split content into relevant sections (for example: Introduction, Background, Key Discussion, Decisions, Next Steps).
- Use meaningful heading titles based on actual content.
- Do not invent information outside the transcript.
- Write the output fully in this language: {output_language}.
Transcript:
{transcript}
"""

PROMPT_MERGE_TEMPLATE = """Create one complete, consistent, study-ready lecture document by combining slide text and audio transcript.

GOAL:
- Produce a full reference document (not a brief summary).
- Make the text immediately useful for exam preparation.
- Integrate all relevant content from both sources into one coherent narrative.

OUTPUT FORMAT (REQUIRED):
1. Start directly with Markdown content (no assistant preface).
2. First line must be a title using `#`.
3. Use `##` and `###` headings with clear logical structure.
4. Do not use transcript/dialog format (no speaker labels or Q&A style).
5. Return only the final document text.

CONTENT RULES:
1. Integration:
   - Use slide order as the backbone.
   - Insert audio explanations at the correct conceptual points.
   - Keep details with learning value.
2. Editing:
   - Remove conversational noise (small talk, startup chatter, repetitive filler).
   - Rewrite spoken classroom phrasing into fluent instructional prose.
3. Structure:
   - Per topic: brief definition/scope -> explanation/mechanism -> practical/clinical relevance.
   - Use bullets only where scanability improves.
   - Preserve cases/exercises as dedicated sections when present.
4. Visual placeholders:
   - Keep only `[Informative Image/Table: ...]` at appropriate locations.
   - Omit decorative placeholders.
5. Language:
   - Write fully in: {output_language}.
   - Keep tone professional, neutral, and didactic.

FAITHFULNESS:
- Slide text + transcript are the primary source of truth.
- Allowed:
  - Short connective phrasing for readability.
  - Careful rewording/inference directly supported by the input.
- Not allowed:
  - New numbers, guidelines, sources, diagnoses, or treatment claims not present in input.
  - New facts not traceable to slide text or transcript.
- If unsure: omit or phrase neutrally without adding claims.

REQUIRED END SECTION:
- Add a final section: `## Key Exam Points`.
- Include 8-15 concrete bullet points with the most important takeaways.

INPUT SLIDE TEXT:
{slide_text}

INPUT AUDIO TRANSCRIPT:
{transcript}"""

PROMPT_MERGE_WITH_AUDIO_MARKERS = """Create a complete, readable lecture document by combining slide text and timestamped audio transcript.

IMPORTANT - AUDIO MARKERS:
For each major section, place this marker format directly below the heading:
<!-- audio:START_MS-END_MS -->
where START_MS and END_MS are the relevant transcript time bounds.

Rules:
1. Do not summarize; write a complete integrated lecture text.
2. Use headings and subheadings for clear structure.
3. Remove only irrelevant spoken filler while preserving substantive explanations.
4. Do not use labels like "Audio:" or "Slide:".
5. Write fully in this language: {output_language}.

Input slide text:
{slide_text}

Input timestamped transcript:
{transcript}"""

PROMPT_STUDY_TEMPLATE = """You are an expert university professor creating study materials. I will provide you with the complete text of a lecture or slide deck.

Your task is to generate {flashcard_amount} flashcards and {question_amount} multiple-choice test questions based strictly on the provided text. Do not invent outside information.
Write all generated output fully in this language: {output_language}.

RULES FOR FLASHCARDS:
- The 'front' should be a clear term or concept.
- The 'back' should be a concise, accurate definition/explanation.

RULES FOR TEST QUESTIONS:
- Create challenging, university-level multiple-choice questions.
- Provide exactly 4 options (A, B, C, D) as an array of strings.
- Provide the correct answer (must match one option exactly).
- Provide a brief 'explanation' of WHY the answer is correct.

REQUIRED OUTPUT FORMAT:
You must respond with strictly valid JSON matching this structure:
{
  "flashcards": [{"front": "string", "back": "string"}],
  "test_questions": [{"question": "string", "options": ["string", "string", "string", "string"], "answer": "string", "explanation": "string"}]
}

LECTURE TEXT:
{source_text}
"""


@dataclass(frozen=True)
class PromptRecord:
    prompt_id: str
    name: str
    template: str


PROMPT_RECORDS: List[PromptRecord] = [
    PromptRecord("slide_extraction", "Slide extraction", PROMPT_SLIDE_EXTRACTION),
    PromptRecord("audio_transcription", "Audio transcription", PROMPT_AUDIO_TRANSCRIPTION),
    PromptRecord("audio_transcription_timestamped", "Audio transcription (timestamped JSON)", PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED),
    PromptRecord("interview_transcription", "Interview transcription", PROMPT_INTERVIEW_TRANSCRIPTION),
    PromptRecord("interview_summary", "Interview summary", PROMPT_INTERVIEW_SUMMARY),
    PromptRecord("interview_sectioned", "Interview sectioned", PROMPT_INTERVIEW_SECTIONED),
    PromptRecord("merge_template", "Lecture merge template", PROMPT_MERGE_TEMPLATE),
    PromptRecord("merge_with_audio_markers", "Lecture merge with audio markers", PROMPT_MERGE_WITH_AUDIO_MARKERS),
    PromptRecord("study_template", "Study tools generation", PROMPT_STUDY_TEMPLATE),
]


def get_prompt_inventory() -> List[Dict[str, str]]:
    return [
        {
            "id": record.prompt_id,
            "name": record.name,
            "version": PROMPT_REGISTRY_VERSION,
            "template": record.template,
        }
        for record in PROMPT_RECORDS
    ]


def get_prompt_template(prompt_id: str) -> str:
    safe_id = str(prompt_id or "").strip()
    for record in PROMPT_RECORDS:
        if record.prompt_id == safe_id:
            return record.template
    raise KeyError(f"Unknown prompt id: {safe_id}")


def get_prompt_metadata() -> Dict[str, object]:
    return {
        "version": PROMPT_REGISTRY_VERSION,
        "count": len(PROMPT_RECORDS),
        "ids": [record.prompt_id for record in PROMPT_RECORDS],
    }


def get_prompt_inventory_markdown() -> str:
    lines = [
        "# Prompt Inventory",
        "",
        f"Version: {PROMPT_REGISTRY_VERSION}",
        "",
    ]
    for record in PROMPT_RECORDS:
        lines.append(f"## {record.name} (`{record.prompt_id}`)")
        lines.append("")
        lines.append("```text")
        lines.append(record.template)
        lines.append("```")
        lines.append("")
    return "\n".join(lines).strip() + "\n"
