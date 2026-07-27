"""Prompt templates and inventory helpers for Lecture Processor."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

PROMPT_REGISTRY_VERSION = "2026-03-05"


PROMPT_SLIDE_EXTRACTION = """Extract all textual content from the attached slide deck PDF and identify the role of visual elements.
Instructions:
1. Clearly label each slide by number (for example: "Slide 1:").
2. Include the slide title.
3. Include all textual content (bullet points, paragraphs) from each slide.
4. Identify where images or tables appear, using strict rules:
   - Informative: Use this placeholder ONLY when the image/table contains text, data, charts, diagrams, flowcharts, formulas, labels, or a scientific/technical visual that is essential for understanding.
     Format: [Informative Image/Table: neutral description of what is visible or the topic]
   - Decorative: Use this placeholder for photos of people/landscapes, logos, background illustrations, stock photos, or mood visuals. If uncertain, classify as decorative.
     Format: [Decorative Image]
5. For every informative visual, also extract any readable embedded text, table values, chart axes, legends, and figure labels into plain text under that slide.
6. If an informative visual exists but text is not readable, still include the placeholder and append "(text unreadable)".
7. Never classify a chart/diagram/table as decorative.
8. Omit the phrase "Share Your talent move the world" if present.
9. Return plain text only, without Word-specific formatting beyond slide labels and placeholders."""

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

PROMPT_VOICE_NOTE_TRANSCRIPTION = """Transcribe this voice note and create lightweight organizer metadata.

Return ONLY valid JSON, without markdown or extra text, in exactly this shape:
{{
  "title": "Short title based on what was said",
  "tags": ["tag one", "tag two"],
  "transcript": "The clean transcript text"
}}

Rules:
- The transcript must contain only the spoken content. Do not start with phrases like "Here is the transcript".
- Keep the transcript faithful to the audio; clean filler words only when it improves readability without changing meaning.
- Use paragraphs for natural breaks.
- Create a short, useful title from the content. If the content is unclear, use "Voice note".
- Create 0-5 short lowercase tags from the content.
- Do not invent details not present in the audio.
- Write transcript, title, and tags fully in this language: {output_language}.

Optional user instruction:
{custom_instruction}"""

PROMPT_INTERVIEW_TRANSCRIPTION = """Transcribe this interview, in the format: timecode (mm:ss), speaker, transcript:
•⁠  ⁠Use ‘Onderzoeker’ and ‘Geïnterviewde’ to identify speakers
•⁠  ⁠Put a '-' between the time, the speaker name and the transcript"""

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

PROMPT_INTERVIEW_CODING = """You are a qualitative research coding assistant helping a researcher review an interview transcript.

Your task is first-cycle qualitative coding, not final analysis. Use descriptive, in-vivo, and thematic codes grounded strictly in the transcript. Reuse existing codes when they are semantically equivalent. Create concise parent codes and subcodes only when they improve organization. A quotation may receive multiple codes when multiple concepts are genuinely present.

Rules:
- Do not invent participant meaning beyond the transcript.
- Preserve exact quoted text from the transcript.
- Prefer useful, human-readable code names of 2-6 words.
- Use in-vivo wording when a participant phrase is especially revealing.
- Avoid generic codes such as "interview", "topic", or "answer".
- Return only strict JSON. No Markdown fences or commentary.

Existing codebook:
{existing_codes_json}

Transcript segments:
{segments_json}

Required JSON shape:
{{
  "codes": [
    {{
      "temp_id": "c1",
      "name": "short code name",
      "description": "why this code is useful",
      "color": "teal",
      "parent_temp_id": "",
      "existing_code_id": ""
    }}
  ],
  "quotations": [
    {{
      "segment_id": "seg-1",
      "quote": "exact text copied from the segment",
      "code_refs": ["c1"],
      "comment": "brief analytic memo, or empty string"
    }}
  ]
}}"""

PROMPT_VOICE_NOTE_NOTES = """You are an expert study-note editor. Turn this voice-note transcript into clean, study-ready Markdown notes.

GOAL:
- Preserve the meaning and useful details from the transcript.
- Remove filler, repetition, false starts, and small talk.
- Organize the material so it is easy to review on a phone.
- Do not invent facts, examples, numbers, citations, or claims not supported by the transcript.

OUTPUT FORMAT:
1. Start directly with Markdown content, with no assistant preface.
2. First line must be a concise `#` title based on the transcript.
3. Use `##` and `###` headings for clear sections.
4. Use bullets only where they make scanning easier.
5. End with `## Key Takeaways` containing 5-12 concrete bullets.
6. Write fully in this language: {output_language}.

OPTIONAL USER INSTRUCTIONS:
{custom_instruction}

TRANSCRIPT:
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

PROMPT_TEXT_COMBINE_BOTH_TEMPLATE = """Doel: Creëer een volledige, integrale en goed leesbare uitwerking van een college door de slide-tekst en het audio-transcript naadloos te combineren. Het eindresultaat moet een compleet naslagwerk zijn dat direct in een Word-document geplakt kan worden.

Input:
1. Slide-tekst: de output van de slide-tekstextractie staat onderaan deze prompt.
2. Audio-transcript: de output van de audiotranscriptie staat onderaan deze prompt.

Kernprincipe:
Jouw taak is niet om samen te vatten, maar om te completeren. Het doel is volledigheid, niet beknoptheid. Combineer alle relevante informatie van de slides en de audio tot één compleet, doorlopend en goed gestructureerd document. Wees niet terughoudend met de lengte; de output moet zo lang zijn als nodig is om alle inhoud te dekken. Beschouw het als het uitschrijven van een college voor iemand die er niet bij kon zijn en geen detail mag missen.

Instructies voor verwerking:
1. Integreer in plaats van te synthetiseren:
   - Gebruik de slide-tekst als de ruggengraat en de structuur van het document.
   - Verweef de gesproken tekst uit het audio-transcript op de juiste logische plek in de slide-tekst.
   - Voeg alle aanvullende uitleg, context, voorbeelden, nuanceringen en zijsporen uit de audio toe.
   - Behoud details. Verwijder geen informatie omdat het een detail lijkt.
2. Redigeer voor leesbaarheid, niet voor beknoptheid:
   - Verwijder alleen letterlijke herhalingen waarbij de audio exact hetzelfde zegt als de slide-tekst.
   - Als de audio iets anders verwoordt, behoud die uitleg wanneer die inhoudelijke waarde heeft.
   - Verwijder overbodige conversationele zinnen en directe instructies aan studenten, tenzij ze cruciaal zijn voor de context.
   - Herschrijf zinnen waar nodig om vloeiende overgangen te maken.
3. Structuur en opmaak:
   - Gebruik de slide-titels als H1- of H2-koppen.
   - Creëer waar nodig subkoppen voor subonderwerpen die in de audio worden besproken.
   - Gebruik alinea's en bullet points om de tekst overzichtelijk te maken.
   - Gebruik absoluut geen labels zoals "Audio:", "Spreker:" of "Slide:".
   - Zorg voor een professionele, informatieve en neutrale toon.
4. Visuele elementen:
   - Neem placeholders voor `[Informatieve Afbeelding/Tabel: ...]` op de juiste plek in de tekst op.
   - Laat placeholders voor `[Decoratieve Afbeelding]` volledig weg.
5. Trouw aan bronmateriaal:
   - Voeg geen nieuwe feiten, getallen, bronnen, richtlijnen, diagnoses of claims toe die niet uit de input volgen.
   - Als iets onzeker is, formuleer neutraal of laat het weg.
6. Taal:
   - Schrijf de volledige output in: {output_language}.

Output:
- Start direct met de uiteindelijke Markdown-tekst.
- De eerste regel moet een titel zijn met `#`.
- Geef alleen het einddocument terug, zonder voorwoord of uitleg over de taak.

Slide-tekst:
{slide_text}

Audio-transcript:
{transcript}"""

PROMPT_TEXT_COMBINE_SLIDES_ONLY_TEMPLATE = """Doel: Creëer een volledige, integrale en goed leesbare uitwerking van een college op basis van de beschikbare slide-tekst. Er is geen audio-transcript beschikbaar. Het eindresultaat moet een compleet naslagwerk zijn dat direct in een Word-document geplakt kan worden.

Kernprincipe:
Jouw taak is niet om samen te vatten, maar om de beschikbare slide-tekst zo volledig, helder en bruikbaar mogelijk uit te werken. Gebruik uitsluitend de informatie die in de slide-tekst staat. Verzin geen gesproken uitleg, voorbeelden of details die niet uit de input volgen.

Instructies voor verwerking:
1. Gebruik de slide-tekst als ruggengraat en structuur van het document.
2. Behoud alle inhoudelijke details uit de slide-tekst.
3. Redigeer voor leesbaarheid, niet voor beknoptheid:
   - Maak zinnen vloeiend waar de slide-tekst fragmentarisch is.
   - Voeg alleen korte verbindende formuleringen toe wanneer die direct door de input worden ondersteund.
4. Structuur en opmaak:
   - Gebruik de slide-titels als H1- of H2-koppen.
   - Creëer waar nodig subkoppen voor subonderwerpen uit de slide-tekst.
   - Gebruik alinea's en bullet points om de tekst overzichtelijk te maken.
   - Gebruik absoluut geen labels zoals "Audio:", "Spreker:" of "Slide:".
   - Zorg voor een professionele, informatieve en neutrale toon.
5. Visuele elementen:
   - Neem placeholders voor `[Informatieve Afbeelding/Tabel: ...]` op de juiste plek in de tekst op.
   - Laat placeholders voor `[Decoratieve Afbeelding]` volledig weg.
6. Trouw aan bronmateriaal:
   - Voeg geen nieuwe feiten, getallen, bronnen, richtlijnen, diagnoses of claims toe die niet uit de input volgen.
7. Taal:
   - Schrijf de volledige output in: {output_language}.

Output:
- Start direct met de uiteindelijke Markdown-tekst.
- De eerste regel moet een titel zijn met `#`.
- Geef alleen het einddocument terug, zonder voorwoord of uitleg over de taak.

Slide-tekst:
{slide_text}"""

PROMPT_TEXT_COMBINE_TRANSCRIPT_ONLY_TEMPLATE = """Doel: Creëer een volledige, integrale en goed leesbare uitwerking van een college op basis van het beschikbare audio-transcript. Er is geen slide-tekst beschikbaar. Het eindresultaat moet een compleet naslagwerk zijn dat direct in een Word-document geplakt kan worden.

Kernprincipe:
Jouw taak is niet om samen te vatten, maar om het transcript volledig om te zetten naar een doorlopend, goed gestructureerd document. Gebruik uitsluitend de informatie die in het transcript staat. Verzin geen slide-inhoud, visuele elementen, voorbeelden of details die niet uit de input volgen.

Instructies voor verwerking:
1. Gebruik de volgorde en inhoudelijke opbouw van het transcript als ruggengraat.
2. Behoud alle aanvullende uitleg, context, voorbeelden, nuanceringen en zijsporen uit het transcript.
3. Redigeer voor leesbaarheid, niet voor beknoptheid:
   - Verwijder overbodige conversationele zinnen, filler en directe instructies aan studenten, tenzij ze cruciaal zijn voor de context.
   - Herschrijf gesproken classroom phrasing naar vloeiende informatieve tekst zonder inhoud te verliezen.
4. Structuur en opmaak:
   - Maak zelf logische H1- en H2-koppen op basis van de onderwerpen in het transcript.
   - Creëer waar nodig subkoppen voor subonderwerpen.
   - Gebruik alinea's en bullet points om de tekst overzichtelijk te maken.
   - Gebruik absoluut geen labels zoals "Audio:", "Spreker:" of "Slide:".
   - Zorg voor een professionele, informatieve en neutrale toon.
5. Trouw aan bronmateriaal:
   - Voeg geen nieuwe feiten, getallen, bronnen, richtlijnen, diagnoses of claims toe die niet uit de input volgen.
   - Als iets onzeker is, formuleer neutraal of laat het weg.
6. Taal:
   - Schrijf de volledige output in: {output_language}.

Output:
- Start direct met de uiteindelijke Markdown-tekst.
- De eerste regel moet een titel zijn met `#`.
- Geef alleen het einddocument terug, zonder voorwoord of uitleg over de taak.

Audio-transcript:
{transcript}"""

PROMPT_STUDY_TEMPLATE = """You are an expert university professor creating study materials. I will provide you with the complete text of a lecture or slide deck.

Your task is to generate {flashcard_amount} flashcards and {question_amount} multiple-choice test questions based strictly on the provided text. Do not invent outside information.
Write all generated output fully in this language: {output_language}.

RULES FOR FLASHCARDS:
- The 'front' must always be a direct study question ending with a question mark.
- Prefer formats like "What is [Term]?", "What is the definition of [Concept]?", "List all [key components of Concept].", or "Name all [examples of Category]."
- Choose the question style that best matches the underlying source text. Do not use vague prompts like "Explain this concept".
- The 'back' should be a concise, accurate definition/explanation.

RULES FOR TEST QUESTIONS:
- Create challenging, university-level multiple-choice questions.
- Provide exactly 4 options (A, B, C, D) as an array of strings.
- Provide the correct answer (must match one option exactly).
- Provide a brief 'explanation' of WHY the answer is correct.

REQUIRED OUTPUT FORMAT:
You must respond with strictly valid JSON matching this structure:
{{
  "flashcards": [{{"front": "string", "back": "string"}}],
  "test_questions": [{{"question": "string", "options": ["string", "string", "string", "string"], "answer": "string", "explanation": "string"}}]
}}

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
    PromptRecord("voice_note_transcription", "Voice note transcription and metadata", PROMPT_VOICE_NOTE_TRANSCRIPTION),
    PromptRecord("interview_transcription", "Interview transcription", PROMPT_INTERVIEW_TRANSCRIPTION),
    PromptRecord("interview_summary", "Interview summary", PROMPT_INTERVIEW_SUMMARY),
    PromptRecord("interview_sectioned", "Interview sectioned", PROMPT_INTERVIEW_SECTIONED),
    PromptRecord("interview_coding", "Interview AI coding", PROMPT_INTERVIEW_CODING),
    PromptRecord("voice_note_notes", "Voice note notes", PROMPT_VOICE_NOTE_NOTES),
    PromptRecord("merge_template", "Lecture merge template", PROMPT_MERGE_TEMPLATE),
    PromptRecord("merge_with_audio_markers", "Lecture merge with audio markers", PROMPT_MERGE_WITH_AUDIO_MARKERS),
    PromptRecord("text_combine_both", "Text combine prompt with slides and transcript", PROMPT_TEXT_COMBINE_BOTH_TEMPLATE),
    PromptRecord("text_combine_slides_only", "Text combine prompt with slides only", PROMPT_TEXT_COMBINE_SLIDES_ONLY_TEMPLATE),
    PromptRecord("text_combine_transcript_only", "Text combine prompt with transcript only", PROMPT_TEXT_COMBINE_TRANSCRIPT_ONLY_TEMPLATE),
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
