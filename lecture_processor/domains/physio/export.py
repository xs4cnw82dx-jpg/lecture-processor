"""Export helpers for Physio Assistant payloads."""

from __future__ import annotations

import io

from lecture_processor.domains.study import export as study_export
from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _titleize(key):
    text = str(key or "").strip().replace("_", " ")
    if not text:
        return "Item"
    return text[:1].upper() + text[1:]


def _stringify_scalar(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "ja" if value else "nee"
    return str(value)


def _append_markdown_lines(lines, value, heading_level, label=None):
    prefix = "#" * max(1, int(heading_level or 1))
    if isinstance(value, dict):
        if label:
            lines.append(f"{prefix} {label}")
        for key, item in value.items():
            _append_markdown_lines(lines, item, heading_level + 1, _titleize(key))
        return
    if isinstance(value, list):
        if label:
            lines.append(f"{prefix} {label}")
        if not value:
            lines.append("- Geen gegevens")
            return
        if all(not isinstance(item, (dict, list)) for item in value):
            for item in value:
                lines.append(f"- {_stringify_scalar(item)}")
            return
        for index, item in enumerate(value, start=1):
            item_label = f"{label or 'Item'} {index}"
            if isinstance(item, (dict, list)):
                _append_markdown_lines(lines, item, heading_level + 1, item_label)
            else:
                lines.append(f"- {item_label}: {_stringify_scalar(item)}")
        return
    if label:
        lines.append(f"{prefix} {label}")
    lines.append(_stringify_scalar(value))


def physio_payload_to_markdown(kind, payload, title="", runtime=None):
    _ = _resolve_runtime(runtime)
    safe_kind = str(kind or "Physio Export").strip()
    safe_title = str(title or safe_kind).strip() or safe_kind
    lines = [f"# {safe_title}", ""]
    _append_markdown_lines(lines, payload if isinstance(payload, (dict, list)) else {"inhoud": payload}, 2, safe_kind)
    return "\n".join(line for line in lines if line is not None).strip() + "\n"


def build_physio_docx_bytes(kind, payload, title="", runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    markdown = physio_payload_to_markdown(kind, payload, title=title, runtime=resolved_runtime)
    doc = study_export.markdown_to_docx(markdown, title=title or kind, runtime=resolved_runtime)
    buffer = io.BytesIO()
    doc.save(buffer)
    buffer.seek(0)
    return buffer.read()


def build_physio_pdf_bytes(kind, payload, title="", runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not getattr(study_export, "REPORTLAB_AVAILABLE", False):
        raise RuntimeError("PDF export is unavailable on this server.")

    markdown = physio_payload_to_markdown(kind, payload, title=title, runtime=resolved_runtime)
    pdf_buffer = io.BytesIO()
    styles = study_export.getSampleStyleSheet()
    doc = study_export.SimpleDocTemplate(
        pdf_buffer,
        pagesize=study_export.A4,
        leftMargin=16 * study_export.mm,
        rightMargin=16 * study_export.mm,
        topMargin=14 * study_export.mm,
        bottomMargin=14 * study_export.mm,
        title=str(title or kind or "Physio Export").strip() or "Physio Export",
    )
    style_map = {
        "pdfTitle": study_export.ParagraphStyle("PhysioPdfTitle", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=17, leading=21, spaceAfter=6, textColor=study_export.colors.HexColor("#111827")),
        "pdfSection": study_export.ParagraphStyle("PhysioPdfSection", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=16, spaceBefore=6, spaceAfter=6, textColor=study_export.colors.HexColor("#111827")),
        "pdfH1": study_export.ParagraphStyle("PhysioPdfH1", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=12, leading=15, textColor=study_export.colors.HexColor("#1F2937")),
        "pdfH2": study_export.ParagraphStyle("PhysioPdfH2", parent=styles["Heading3"], fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=study_export.colors.HexColor("#1F2937")),
        "pdfH3": study_export.ParagraphStyle("PhysioPdfH3", parent=styles["Heading4"], fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=study_export.colors.HexColor("#374151")),
        "pdfBody": study_export.ParagraphStyle("PhysioPdfBody", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.5, leading=13, textColor=study_export.colors.HexColor("#111827")),
    }
    story = [
        study_export.Paragraph(study_export.markdown_inline_to_pdf_html(str(title or kind or "Physio Export")), style_map["pdfTitle"]),
        study_export.Spacer(1, 6),
    ]
    study_export.append_notes_markdown_to_story(story, markdown, style_map, runtime=resolved_runtime)
    doc.build(story)
    pdf_buffer.seek(0)
    return pdf_buffer.read()
