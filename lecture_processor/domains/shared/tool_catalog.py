"""The shared, public catalog used by tool discovery and account favorites."""

TOOL_CATEGORIES = (
    ('create', 'Create study material', 'Turn your lectures and slides into something you can study.'),
    ('read', 'Read sources', 'Find the information you need in documents, images, and articles.'),
    ('transcribe', 'Transcribe audio', 'Turn recordings and conversations into clear text.'),
    ('batch', 'Batch processing', 'Save time when you have several files to work through.'),
    ('media', 'Media and creative', 'Download, illustrate, and bring your material to life.'),
)

# Icons are trusted SVG path data; labels and URLs have one source of truth.
ICONS = {
    'book': 'M12 5C8 2 4 3 2 4v15c3-2 7-2 10 0 3-2 7-2 10 0V4c-3-1-7-2-10 1Zm0 0v14',
    'document': 'M14 3H6v18h12V7l-4-4Zm0 0v5h4M8 12h8M8 16h6',
    'screen': 'M3 4h18v14H3zM8 22h8M12 18v4M7 8h10M7 12h6',
    'microphone': 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-4 5v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    'image': 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M8 7h.01',
    'link': 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
    'batch': 'M3 3h14v14H3zM7 21h14V7M7 7h6M7 11h4',
    'download': 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
}

TOOLS = (
    ('lecture-notes', 'Lecture Notes', '/lecture-notes', 'create', 'book', 'Turn slides and audio into notes, flashcards, and practice tests.'),
    ('slides-extraction', 'Slides Extraction', '/slides-extraction', 'create', 'screen', 'Extract clear study text from your slide decks.'),
    ('document-reader', 'Document Reader', '/document-reader', 'read', 'document', 'Ask questions about a PDF, PowerPoint, or Word document.'),
    ('image-reader', 'Image Reader', '/image-reader', 'read', 'image', 'Extract text from up to five images at once.'),
    ('url-reader', 'URL Reader', '/url-reader', 'read', 'link', 'Understand articles and simplify complex findings.'),
    ('general-transcriber', 'General Transcriber', '/general-transcriber', 'transcribe', 'microphone', 'Create a clean transcript from an audio recording.'),
    ('interview-transcription', 'Interview Transcription', '/interview-transcription', 'transcribe', 'microphone', 'Transcribe conversations with timestamps and optional summaries.'),
    ('batch-mode', 'Batch Mode', '/batch_mode', 'batch', 'batch', 'Process several lectures together and download one ZIP.'),
    ('instant-batch', 'Instant Batch', '/instant_batch_mode', 'batch', 'batch', 'Start lecture rows as you add them and follow their progress.'),
    ('batch-transcriber', 'Batch Transcriber', '/batch_mode_audio_transcription', 'batch', 'microphone', 'Transcribe multiple recordings in a single batch.'),
    ('batch-combine-text', 'Batch Combine Text', '/batch_mode_text_combine', 'batch', 'document', 'Combine extracted slide text and transcripts into lecture notes.'),
    ('lecture-downloader', 'Lecture Downloader', '/lecture-downloader', 'media', 'download', 'Save a supported lecture link as video, audio, or both.'),
    ('video-overlay-builder', 'Video Overlay Builder', '/video-overlay-builder', 'media', 'screen', 'Add timed cards, diagrams, and images to lecture videos.'),
    ('book-studio', 'Book Studio', '/books', 'media', 'book', 'Create illustrated stories, sketchbooks, and journals.'),
)
TOOL_IDS = frozenset(tool[0] for tool in TOOLS)
TOOL_CATALOG = tuple(dict(zip(('id', 'name', 'url', 'category', 'icon', 'description'), tool)) for tool in TOOLS)


def sanitize_favorite_tools(value):
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(item for item in value if isinstance(item, str) and item in TOOL_IDS))
