"""Helpers for safe spreadsheet exports."""


def sanitize_csv_cell(value):
    if value is None:
        return ''
    if isinstance(value, (int, float, bool)):
        return value
    text = str(value)
    if text and text[0] in {'=', '+', '-', '@', '\t', '\r', '\n'}:
        return "'" + text
    return text


def sanitize_csv_row(values):
    return [sanitize_csv_cell(value) for value in (values or [])]


def sanitize_excel_cell(value):
    return sanitize_csv_cell(value)
