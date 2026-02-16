import os
import uuid
import threading
import time
import io
from flask import Flask, request, jsonify, render_template, send_file
from google import genai
from google.genai import types
from dotenv import load_dotenv
from werkzeug.utils import secure_filename
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

# Load environment variables from .env file
load_dotenv()

# Initialize Flask app
app = Flask(__name__)

# Configuration
UPLOAD_FOLDER = 'uploads'
ALLOWED_PDF_EXTENSIONS = {'pdf'}
ALLOWED_AUDIO_EXTENSIONS = {'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'}
MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500 MB max upload size

# Create uploads folder if it doesn't exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Initialize Gemini client
client = genai.Client(api_key=os.getenv('GEMINI_API_KEY'))

# Store job status and results in memory
jobs = {}

# ============== MODEL CONFIGURATION ==============
# Change these model names when Google releases new versions
# Current models (February 2026):
#   - gemini-2.5-flash-lite (cheapest, good for simple extraction)
#   - gemini-2.5-flash (balanced, good for transcription)
#   - gemini-2.5-pro (best quality, needed for complex integration)
# 
# Find current model names at: https://ai.google.dev/gemini-api/docs/models

MODEL_SLIDES = 'gemini-2.5-flash-lite'  # For extracting text from PDF slides
MODEL_AUDIO = 'gemini-2.5-flash'         # For transcribing audio
MODEL_INTEGRATION = 'gemini-2.5-pro'     # For merging into complete notes
MODEL_INTERVIEW = 'gemini-2.5-pro'       # For interview transcription (needs Pro for Dutch)

# ============== PROMPTS ==============

PROMPT_SLIDE_EXTRACTION = """Extraheer alle tekst van de slides uit het bijgevoegde PDF-bestand en identificeer de functie van visuele elementen.

Instructies:
1. Geef per slide duidelijk aan welk slide-nummer het betreft (bv. "Slide 1:").
2. Neem de titel van de slide over.
3. Neem alle tekstuele inhoud (bullet points, paragrafen) van de slide over.
4. Identificeer waar afbeeldingen of tabellen staan. Maak een inschatting van de functie:
   - Informatief: Als het een grafiek, diagram, model of relevante foto is die inhoudelijke informatie toevoegt, gebruik de placeholder: [Informatieve Afbeelding/Tabel: Geef een neutrale beschrijving van wat zichtbaar is of het onderwerp]
   - Decoratief: Als het een sfeerbeeld, stockfoto of logo is zonder directe informatieve waarde, gebruik de placeholder: [Decoratieve Afbeelding]
5. Laat de zin "Share Your talent move the world" weg, indien aanwezig.
6. Lever de output als platte tekst, zonder specifieke Word-opmaak anders dan de slide-indicatie en de placeholders."""

PROMPT_AUDIO_TRANSCRIPTION = """Maak een nauwkeurig en 'schoon' transcript van het bijgevoegde audiobestand.

Instructies:
1. Transcribeer de gesproken tekst zo letterlijk mogelijk.
2. Verwijder stopwoorden en aarzelingen (zoals "eh," "uhm," "nou ja," "weet je wel") om de leesbaarheid te verhogen, maar behoud de volledige inhoudelijke boodschap. Verander geen zinsconstructies.
3. Gebruik geen tijdcodes.
4. Gebruik alinea's om langere spreekbeurten op te delen."""

PROMPT_INTERVIEW_TRANSCRIPTION = """Transcribe this interview, in the format of timecode (mm:ss), speaker, caption. Put a '-' between the time, the speaker name and the transcript. Use speaker A, speaker B, etc. to identify speakers."""

PROMPT_MERGE_TEMPLATE = """Creëer een volledige, integrale en goed leesbare uitwerking van een college door de slide-tekst en het audio-transcript naadloos te combineren. Het eindresultaat moet een compleet naslagwerk zijn.

Kernprincipe:
Jouw taak is niet om samen te vatten, maar om te completeren. Het doel is volledigheid, niet beknoptheid. Combineer alle relevante informatie van de slides en de audio tot één compleet, doorlopend en goed gestructureerd document. Wees niet terughoudend met de lengte; de output moet zo lang zijn als nodig is om alle inhoud te dekken. Beschouw het als het uitschrijven van een college voor iemand die er niet bij kon zijn en geen detail mag missen.

Instructies voor Verwerking:
1. Integreer in plaats van te synthetiseren:
   - Gebruik de slide-tekst als de ruggengraat en de structuur van het document.
   - Verweef de gesproken tekst uit het audio-transcript op de juiste logische plek in de slide-tekst.
   - Voeg alle aanvullende uitleg, context, voorbeelden, nuanceringen en zijsporen uit de audio toe. Als de spreker een concept van de slide verder uitlegt, moet die volledige uitleg in de tekst komen.
   - Behoud details: Verwijder geen informatie omdat het een 'detail' lijkt. Alle inhoudelijke informatie uit de audio is relevant.
2. Redigeer voor Leesbaarheid (niet voor beknoptheid):
   - Verwijder alleen letterlijke herhalingen waarbij de audio exact hetzelfde zegt als de slide-tekst. Als de audio het anders verwoordt, behoud dan de audio-versie omdat deze vaak natuurlijker is.
   - Zorg ervoor dat alle overbodige conversationele zinnen (bv. "Oké, dan gaan we nu naar de volgende slide," "Hebben jullie hier vragen over?") en directe instructies aan studenten ("Noteer dit goed," "Dit komt op het tentamen") worden verwijderd, tenzij ze cruciaal zijn voor de context.
   - Herschrijf zinnen waar nodig om een vloeiende overgang te creëren tussen de slide-informatie en de toegevoegde audio-uitleg. De tekst moet lezen als één coherent geheel.
3. Structuur en Opmaak:
   - Gebruik de slide-titels als koppen. Creëer waar nodig subkoppen voor subonderwerpen die in de audio worden besproken.
   - Gebruik alinea's en bullet points om de tekst overzichtelijk en leesbaar te maken.
   - Gebruik absoluut geen labels zoals "Audio:", "Spreker:" of "Slide:".
   - Zorg voor een professionele, informatieve en neutrale toon.
4. Omgaan met Visuele Elementen:
   - Neem de placeholders voor [Informatieve Afbeelding/Tabel: ...] op de juiste plek in de tekst op.
   - Laat placeholders voor [Decoratieve Afbeelding] volledig weg uit de uiteindelijke output.

Input:
1. Slide-tekst:
{slide_text}

2. Audio-transcript:
{transcript}"""

# ============== HELPER FUNCTIONS ==============

def allowed_file(filename, allowed_extensions):
    """Check if a file has an allowed extension."""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in allowed_extensions

def get_mime_type(filename):
    """Get the MIME type based on file extension."""
    ext = filename.rsplit('.', 1)[1].lower()
    mime_types = {
        'pdf': 'application/pdf',
        'mp3': 'audio/mpeg',
        'm4a': 'audio/mp4',
        'wav': 'audio/wav',
        'aac': 'audio/aac',
        'ogg': 'audio/ogg',
        'flac': 'audio/flac'
    }
    return mime_types.get(ext, 'application/octet-stream')

def wait_for_file_processing(uploaded_file):
    """Wait for Gemini to finish processing an uploaded file."""
    max_wait_time = 300  # 5 minutes maximum wait
    wait_interval = 5    # Check every 5 seconds
    total_waited = 0
    
    while total_waited < max_wait_time:
        # Get the current file status
        file_info = client.files.get(name=uploaded_file.name)
        
        if file_info.state.name == 'ACTIVE':
            return True
        elif file_info.state.name == 'FAILED':
            raise Exception(f"File processing failed: {uploaded_file.name}")
        
        # Still processing, wait and check again
        time.sleep(wait_interval)
        total_waited += wait_interval
    
    raise Exception(f"File processing timed out after {max_wait_time} seconds")

def cleanup_files(local_paths, gemini_files):
    """Delete local files and Gemini uploaded files."""
    # Delete local files
    for path in local_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            print(f"Warning: Could not delete local file {path}: {e}")
    
    # Delete files from Gemini
    for gemini_file in gemini_files:
        try:
            client.files.delete(name=gemini_file.name)
        except Exception as e:
            print(f"Warning: Could not delete Gemini file {gemini_file.name}: {e}")

def markdown_to_docx(markdown_text, title="Document"):
    """Convert markdown text to a Word document."""
    doc = Document()
    
    # Set up styles
    style = doc.styles['Normal']
    style.font.name = 'Calibri'
    style.font.size = Pt(11)
    
    lines = markdown_text.split('\n')
    i = 0
    
    while i < len(lines):
        line = lines[i].strip()
        
        if not line:
            i += 1
            continue
        
        # Handle headers
        if line.startswith('### '):
            heading = doc.add_heading(line[4:], level=3)
        elif line.startswith('## '):
            heading = doc.add_heading(line[3:], level=2)
        elif line.startswith('# '):
            heading = doc.add_heading(line[2:], level=1)
        # Handle bullet points
        elif line.startswith('- ') or line.startswith('* '):
            doc.add_paragraph(line[2:], style='List Bullet')
        # Handle numbered lists
        elif len(line) > 2 and line[0].isdigit() and line[1] == '.' and line[2] == ' ':
            doc.add_paragraph(line[3:], style='List Number')
        # Regular paragraph
        else:
            # Collect consecutive non-empty, non-special lines into one paragraph
            paragraph_lines = [line]
            while i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                if (next_line and 
                    not next_line.startswith('#') and 
                    not next_line.startswith('- ') and 
                    not next_line.startswith('* ') and
                    not (len(next_line) > 2 and next_line[0].isdigit() and next_line[1] == '.')):
                    paragraph_lines.append(next_line)
                    i += 1
                else:
                    break
            
            paragraph_text = ' '.join(paragraph_lines)
            p = doc.add_paragraph()
            
            # Handle bold and italic within the paragraph
            parts = paragraph_text.split('**')
            for j, part in enumerate(parts):
                if j % 2 == 1:  # Bold text
                    run = p.add_run(part)
                    run.bold = True
                else:
                    # Handle italic within non-bold parts
                    italic_parts = part.split('*')
                    for k, italic_part in enumerate(italic_parts):
                        run = p.add_run(italic_part)
                        if k % 2 == 1:
                            run.italic = True
        
        i += 1
    
    return doc

# ============== PROCESSING FUNCTIONS ==============

def process_lecture_notes(job_id, pdf_path, audio_path):
    """Process PDF + Audio into complete lecture notes."""
    gemini_files = []
    local_paths = [pdf_path, audio_path]
    
    try:
        # ========== STEP 1: Extract Slide Text ==========
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Extracting text from slides...'
        
        pdf_file = client.files.upload(
            file=pdf_path,
            config={'mime_type': 'application/pdf'}
        )
        gemini_files.append(pdf_file)
        wait_for_file_processing(pdf_file)
        
        response = client.models.generate_content(
            model=MODEL_SLIDES,
            contents=[
                types.Content(
                    role='user',
                    parts=[
                        types.Part.from_uri(
                            file_uri=pdf_file.uri,
                            mime_type='application/pdf'
                        ),
                        types.Part.from_text(text=PROMPT_SLIDE_EXTRACTION)
                    ]
                )
            ],
            config=types.GenerateContentConfig(
                max_output_tokens=65536
            )
        )
        
        slide_text = response.text
        jobs[job_id]['slide_text'] = slide_text  # Store for later access
        
        # ========== STEP 2: Transcribe Audio ==========
        jobs[job_id]['step'] = 2
        jobs[job_id]['step_description'] = 'Transcribing audio...'
        
        audio_mime_type = get_mime_type(audio_path)
        audio_file = client.files.upload(
            file=audio_path,
            config={'mime_type': audio_mime_type}
        )
        gemini_files.append(audio_file)
        
        jobs[job_id]['step_description'] = 'Processing audio file (this may take a few minutes)...'
        wait_for_file_processing(audio_file)
        
        jobs[job_id]['step_description'] = 'Generating transcript...'
        
        response = client.models.generate_content(
            model=MODEL_AUDIO,
            contents=[
                types.Content(
                    role='user',
                    parts=[
                        types.Part.from_uri(
                            file_uri=audio_file.uri,
                            mime_type=audio_mime_type
                        ),
                        types.Part.from_text(text=PROMPT_AUDIO_TRANSCRIPTION)
                    ]
                )
            ],
            config=types.GenerateContentConfig(
                max_output_tokens=65536
            )
        )
        
        transcript = response.text
        jobs[job_id]['transcript'] = transcript  # Store for later access
        
        # ========== STEP 3: Merge Into Complete Notes ==========
        jobs[job_id]['step'] = 3
        jobs[job_id]['step_description'] = 'Creating complete lecture notes...'
        
        merge_prompt = PROMPT_MERGE_TEMPLATE.format(
            slide_text=slide_text,
            transcript=transcript
        )
        
        response = client.models.generate_content(
            model=MODEL_INTEGRATION,
            contents=[
                types.Content(
                    role='user',
                    parts=[
                        types.Part.from_text(text=merge_prompt)
                    ]
                )
            ],
            config=types.GenerateContentConfig(
                max_output_tokens=65536
            )
        )
        
        merged_notes = response.text
        
        # ========== DONE ==========
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = 3
        jobs[job_id]['step_description'] = 'Complete!'
        jobs[job_id]['result'] = merged_notes
        
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        print(f"Error processing job {job_id}: {e}")
    
    finally:
        cleanup_files(local_paths, gemini_files)


def process_slides_only(job_id, pdf_path):
    """Process PDF slides into extracted text."""
    gemini_files = []
    local_paths = [pdf_path]
    
    try:
        # ========== STEP 1: Extract Slide Text ==========
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Extracting text from slides...'
        
        pdf_file = client.files.upload(
            file=pdf_path,
            config={'mime_type': 'application/pdf'}
        )
        gemini_files.append(pdf_file)
        wait_for_file_processing(pdf_file)
        
        response = client.models.generate_content(
            model=MODEL_SLIDES,
            contents=[
                types.Content(
                    role='user',
                    parts=[
                        types.Part.from_uri(
                            file_uri=pdf_file.uri,
                            mime_type='application/pdf'
                        ),
                        types.Part.from_text(text=PROMPT_SLIDE_EXTRACTION)
                    ]
                )
            ],
            config=types.GenerateContentConfig(
                max_output_tokens=65536
            )
        )
        
        slide_text = response.text
        
        # ========== DONE ==========
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Complete!'
        jobs[job_id]['result'] = slide_text
        
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        print(f"Error processing job {job_id}: {e}")
    
    finally:
        cleanup_files(local_paths, gemini_files)


def process_interview_transcription(job_id, audio_path):
    """Process audio into timestamped interview transcript."""
    gemini_files = []
    local_paths = [audio_path]
    
    try:
        # ========== STEP 1: Transcribe Interview ==========
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Processing audio file...'
        
        audio_mime_type = get_mime_type(audio_path)
        audio_file = client.files.upload(
            file=audio_path,
            config={'mime_type': audio_mime_type}
        )
        gemini_files.append(audio_file)
        
        jobs[job_id]['step_description'] = 'Processing audio file (this may take a few minutes)...'
        wait_for_file_processing(audio_file)
        
        jobs[job_id]['step_description'] = 'Generating transcript with timestamps...'
        
        response = client.models.generate_content(
            model=MODEL_INTERVIEW,
            contents=[
                types.Content(
                    role='user',
                    parts=[
                        types.Part.from_uri(
                            file_uri=audio_file.uri,
                            mime_type=audio_mime_type
                        ),
                        types.Part.from_text(text=PROMPT_INTERVIEW_TRANSCRIPTION)
                    ]
                )
            ],
            config=types.GenerateContentConfig(
                max_output_tokens=65536
            )
        )
        
        transcript = response.text
        
        # ========== DONE ==========
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Complete!'
        jobs[job_id]['result'] = transcript
        
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        print(f"Error processing job {job_id}: {e}")
    
    finally:
        cleanup_files(local_paths, gemini_files)

# ============== FLASK ROUTES ==============

@app.route('/')
def index():
    """Serve the main page."""
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_files():
    """Handle file upload and start processing."""
    # Get the processing mode
    mode = request.form.get('mode', 'lecture-notes')
    
    if mode == 'lecture-notes':
        # Need both PDF and audio
        if 'pdf' not in request.files or 'audio' not in request.files:
            return jsonify({'error': 'Both PDF and audio files are required for lecture notes'}), 400
        
        pdf_file = request.files['pdf']
        audio_file = request.files['audio']
        
        if pdf_file.filename == '' or audio_file.filename == '':
            return jsonify({'error': 'Both files must be selected'}), 400
        
        if not allowed_file(pdf_file.filename, ALLOWED_PDF_EXTENSIONS):
            return jsonify({'error': 'Invalid PDF file. Please upload a .pdf file'}), 400
        
        if not allowed_file(audio_file.filename, ALLOWED_AUDIO_EXTENSIONS):
            return jsonify({'error': 'Invalid audio file. Supported formats: MP3, M4A, WAV, AAC, OGG, FLAC'}), 400
        
        job_id = str(uuid.uuid4())
        
        pdf_filename = f"{job_id}_{secure_filename(pdf_file.filename)}"
        audio_filename = f"{job_id}_{secure_filename(audio_file.filename)}"
        
        pdf_path = os.path.join(UPLOAD_FOLDER, pdf_filename)
        audio_path = os.path.join(UPLOAD_FOLDER, audio_filename)
        
        pdf_file.save(pdf_path)
        audio_file.save(audio_path)
        
        jobs[job_id] = {
            'status': 'starting',
            'step': 0,
            'step_description': 'Starting...',
            'total_steps': 3,
            'mode': 'lecture-notes',
            'result': None,
            'slide_text': None,
            'transcript': None,
            'error': None
        }
        
        thread = threading.Thread(
            target=process_lecture_notes,
            args=(job_id, pdf_path, audio_path)
        )
        thread.start()
        
    elif mode == 'slides-only':
        # Need only PDF
        if 'pdf' not in request.files:
            return jsonify({'error': 'PDF file is required'}), 400
        
        pdf_file = request.files['pdf']
        
        if pdf_file.filename == '':
            return jsonify({'error': 'PDF file must be selected'}), 400
        
        if not allowed_file(pdf_file.filename, ALLOWED_PDF_EXTENSIONS):
            return jsonify({'error': 'Invalid PDF file. Please upload a .pdf file'}), 400
        
        job_id = str(uuid.uuid4())
        
        pdf_filename = f"{job_id}_{secure_filename(pdf_file.filename)}"
        pdf_path = os.path.join(UPLOAD_FOLDER, pdf_filename)
        pdf_file.save(pdf_path)
        
        jobs[job_id] = {
            'status': 'starting',
            'step': 0,
            'step_description': 'Starting...',
            'total_steps': 1,
            'mode': 'slides-only',
            'result': None,
            'error': None
        }
        
        thread = threading.Thread(
            target=process_slides_only,
            args=(job_id, pdf_path)
        )
        thread.start()
        
    elif mode == 'interview':
        # Need only audio
        if 'audio' not in request.files:
            return jsonify({'error': 'Audio file is required'}), 400
        
        audio_file = request.files['audio']
        
        if audio_file.filename == '':
            return jsonify({'error': 'Audio file must be selected'}), 400
        
        if not allowed_file(audio_file.filename, ALLOWED_AUDIO_EXTENSIONS):
            return jsonify({'error': 'Invalid audio file. Supported formats: MP3, M4A, WAV, AAC, OGG, FLAC'}), 400
        
        job_id = str(uuid.uuid4())
        
        audio_filename = f"{job_id}_{secure_filename(audio_file.filename)}"
        audio_path = os.path.join(UPLOAD_FOLDER, audio_filename)
        audio_file.save(audio_path)
        
        jobs[job_id] = {
            'status': 'starting',
            'step': 0,
            'step_description': 'Starting...',
            'total_steps': 1,
            'mode': 'interview',
            'result': None,
            'error': None
        }
        
        thread = threading.Thread(
            target=process_interview_transcription,
            args=(job_id, audio_path)
        )
        thread.start()
        
    else:
        return jsonify({'error': 'Invalid processing mode'}), 400
    
    return jsonify({'job_id': job_id})

@app.route('/status/<job_id>')
def get_status(job_id):
    """Get the status of a processing job."""
    if job_id not in jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    job = jobs[job_id]
    
    response = {
        'status': job['status'],
        'step': job['step'],
        'step_description': job['step_description'],
        'total_steps': job.get('total_steps', 3),
        'mode': job.get('mode', 'lecture-notes')
    }
    
    if job['status'] == 'complete':
        response['result'] = job['result']
        # Include intermediate results for lecture-notes mode
        if job.get('mode') == 'lecture-notes':
            response['slide_text'] = job.get('slide_text')
            response['transcript'] = job.get('transcript')
    elif job['status'] == 'error':
        response['error'] = job['error']
    
    return jsonify(response)

@app.route('/download-docx/<job_id>')
def download_docx(job_id):
    """Download results as a Word document."""
    if job_id not in jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    job = jobs[job_id]
    
    if job['status'] != 'complete':
        return jsonify({'error': 'Job not complete'}), 400
    
    # Get the content type from query parameter
    content_type = request.args.get('type', 'result')
    
    if content_type == 'slides' and job.get('slide_text'):
        content = job['slide_text']
        filename = 'extracted-slides.docx'
        title = 'Extracted Slides'
    elif content_type == 'transcript' and job.get('transcript'):
        content = job['transcript']
        filename = 'transcript.docx'
        title = 'Lecture Transcript'
    else:
        content = job['result']
        mode = job.get('mode', 'lecture-notes')
        if mode == 'lecture-notes':
            filename = 'lecture-notes.docx'
            title = 'Lecture Notes'
        elif mode == 'slides-only':
            filename = 'extracted-slides.docx'
            title = 'Extracted Slides'
        else:
            filename = 'interview-transcript.docx'
            title = 'Interview Transcript'
    
    # Create the Word document
    doc = markdown_to_docx(content, title)
    
    # Save to BytesIO
    docx_io = io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    
    return send_file(
        docx_io,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=filename
    )

# ============== RUN THE APP ==============

if __name__ == '__main__':
    print("\n" + "="*50)
    print("Lecture Processor is running!")
    print("="*50)
    print(f"Models configured:")
    print(f"  - Slides:      {MODEL_SLIDES}")
    print(f"  - Audio:       {MODEL_AUDIO}")
    print(f"  - Integration: {MODEL_INTEGRATION}")
    print(f"  - Interview:   {MODEL_INTERVIEW}")
    print("="*50)
    print("Processing modes available:")
    print("  - Lecture Notes (PDF + Audio)")
    print("  - Slides Only (PDF)")
    print("  - Interview Transcription (Audio)")
    print("="*50)
    print("Open your browser and go to: http://127.0.0.1:5000")
    print("Press Ctrl+C to stop the server")
    print("="*50 + "\n")
    app.run(debug=True, port=5000)
