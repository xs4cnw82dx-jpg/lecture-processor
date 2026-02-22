import os
import uuid
import threading
import time
import io
import json
import csv
from datetime import datetime, timedelta
import stripe
from flask import Flask, request, jsonify, render_template, send_file
from google import genai
from google.genai import types
from dotenv import load_dotenv
from werkzeug.utils import secure_filename
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
import firebase_admin
from firebase_admin import credentials, auth, firestore

load_dotenv()
app = Flask(__name__)

UPLOAD_FOLDER = 'uploads'
ALLOWED_PDF_EXTENSIONS = {'pdf'}
ALLOWED_AUDIO_EXTENSIONS = {'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'}
MAX_CONTENT_LENGTH = 500 * 1024 * 1024

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
client = genai.Client(api_key=os.getenv('GEMINI_API_KEY'))

# --- Firebase Setup ---
if os.path.exists('firebase-credentials.json'):
    cred = credentials.Certificate('firebase-credentials.json')
else:
    firebase_creds = json.loads(os.getenv('FIREBASE_CREDENTIALS', '{}'))
    cred = credentials.Certificate(firebase_creds)

firebase_admin.initialize_app(cred)
db = firestore.client()

# --- Stripe Setup ---
stripe.api_key = os.getenv('STRIPE_SECRET_KEY')
STRIPE_PUBLISHABLE_KEY = os.getenv('STRIPE_PUBLISHABLE_KEY', '')
STRIPE_WEBHOOK_SECRET = os.getenv('STRIPE_WEBHOOK_SECRET', '')
ADMIN_EMAILS = {email.strip().lower() for email in os.getenv('ADMIN_EMAILS', '').split(',') if email.strip()}
ADMIN_UIDS = {uid.strip() for uid in os.getenv('ADMIN_UIDS', '').split(',') if uid.strip()}

# --- In-Memory Storage (jobs only — credits are in Firestore now) ---
jobs = {}

# --- Credit Bundles (what users can buy) ---
CREDIT_BUNDLES = {
    'lecture_5': {
        'name': 'Lecture Notes — 5 Pack',
        'description': '5 standard lecture credits',
        'credits': {'lecture_credits_standard': 5},
        'price_cents': 999,
        'currency': 'eur',
    },
    'lecture_10': {
        'name': 'Lecture Notes — 10 Pack',
        'description': '10 standard lecture credits (best value)',
        'credits': {'lecture_credits_standard': 10},
        'price_cents': 1699,
        'currency': 'eur',
    },
    'slides_10': {
        'name': 'Slides Extraction — 10 Pack',
        'description': '10 slides extraction credits',
        'credits': {'slides_credits': 10},
        'price_cents': 499,
        'currency': 'eur',
    },
    'slides_25': {
        'name': 'Slides Extraction — 25 Pack',
        'description': '25 slides extraction credits (best value)',
        'credits': {'slides_credits': 25},
        'price_cents': 999,
        'currency': 'eur',
    },
    'interview_3': {
        'name': 'Interview Transcription — 3 Pack',
        'description': '3 interview transcription credits',
        'credits': {'interview_credits_short': 3},
        'price_cents': 799,
        'currency': 'eur',
    },
    'interview_8': {
        'name': 'Interview Transcription — 8 Pack',
        'description': '8 interview transcription credits (best value)',
        'credits': {'interview_credits_short': 8},
        'price_cents': 1799,
        'currency': 'eur',
    },
}

# --- Email Allowlist ---
ALLOWED_EMAIL_DOMAINS = {
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'yahoo.com', 'yahoo.nl',
    'student.tudelft.nl', 'tudelft.nl', 'uva.nl', 'student.uva.nl', 'vu.nl', 'student.vu.nl', 'eur.nl', 'student.eur.nl',
    'uu.nl', 'students.uu.nl', 'ru.nl', 'student.ru.nl', 'utwente.nl', 'student.utwente.nl', 'tue.nl', 'student.tue.nl',
    'maastrichtuniversity.nl', 'student.maastrichtuniversity.nl', 'leidenuniv.nl', 'student.leidenuniv.nl', 'rug.nl',
    'student.rug.nl', 'tilburguniversity.edu', 'uvt.nl', 'han.nl', 'student.han.nl', 'hva.nl', 'student.hva.nl', 'hr.nl',
    'student.hr.nl', 'fontys.nl', 'student.fontys.nl', 'saxion.nl', 'student.saxion.nl', 'avans.nl', 'student.avans.nl',
    'inholland.nl', 'student.inholland.nl', 'hanze.nl', 'student.hanze.nl', 'zuyd.nl', 'student.zuyd.nl', 'hu.nl',
    'student.hu.nl', 'windesheim.nl', 'student.windesheim.nl', 'nhlstenden.com', 'student.nhlstenden.com',
}

ALLOWED_EMAIL_PATTERNS = ['.edu', '.ac.uk', '.edu.nl']

def is_email_allowed(email):
    if not email: return False
    email = email.lower()
    domain = email.split('@')[-1] if '@' in email else ''
    if domain in ALLOWED_EMAIL_DOMAINS: return True
    for pattern in ALLOWED_EMAIL_PATTERNS:
        if domain.endswith(pattern): return True
    return False

# --- AI Model Config ---
MODEL_SLIDES = 'gemini-2.5-flash-lite'
MODEL_AUDIO = 'gemini-3-flash-preview'
MODEL_INTEGRATION = 'gemini-2.5-pro'
MODEL_INTERVIEW = 'gemini-2.5-pro'

FREE_LECTURE_CREDITS = 1
FREE_SLIDES_CREDITS = 2
FREE_INTERVIEW_CREDITS = 0

# --- Prompts ---
PROMPT_SLIDE_EXTRACTION = """Extraheer alle tekst van de slides uit het bijgevoegde PDF-bestand en identificeer de functie van visuele elementen.
Instructies:
1. Geef per slide duidelijk aan welk slide-nummer het betreft (bv. "Slide 1:").
2. Neem de titel van de slide over.
3. Neem alle tekstuele inhoud (bullet points, paragrafen) van de slide over.
4. Identificeer waar afbeeldingen of tabellen staan. Gebruik strikte criteria:
   - Informatief: Gebruik de placeholder ALLEEN als de afbeelding tekst, data, grafieken, diagrammen, flowcharts, of een specifiek wetenschappelijk/technisch diagram bevat dat cruciaal is voor begrip van de slide. Formaat: [Informatieve Afbeelding/Tabel: Geef een neutrale beschrijving van wat zichtbaar is of het onderwerp]
   - Decoratief: Gebruik de placeholder voor ALLE foto's van mensen, landschappen, bedrijfslogo's, universiteitslogo's, achtergrondillustraties, stockfoto's, of sfeerbeelden. Bij twijfel, classificeer het als decoratief! Formaat: [Decoratieve Afbeelding]
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

# =============================================
# FIRESTORE USER FUNCTIONS
# =============================================

def get_or_create_user(uid, email):
    """Get a user from Firestore, or create them with free credits if they don't exist."""
    user_ref = db.collection('users').document(uid)
    user_doc = user_ref.get()

    if user_doc.exists:
        user_data = user_doc.to_dict()
        # Update email if it changed
        if user_data.get('email') != email and email:
            user_ref.update({'email': email})
            user_data['email'] = email
        return user_data
    else:
        # New user — create with free credits
        user_data = {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': FREE_LECTURE_CREDITS,
            'lecture_credits_extended': 0,
            'slides_credits': FREE_SLIDES_CREDITS,
            'interview_credits_short': FREE_INTERVIEW_CREDITS,
            'interview_credits_medium': 0,
            'interview_credits_long': 0,
            'total_processed': 0,
            'created_at': time.time(),
        }
        user_ref.set(user_data)
        print(f"New user created: {uid} ({email})")
        return user_data

def grant_credits_to_user(uid, bundle_id):
    """Grant credits from a purchased bundle to a user in Firestore."""
    bundle = CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        print(f"Warning: Unknown bundle_id '{bundle_id}' in grant_credits_to_user")
        return False

    user_ref = db.collection('users').document(uid)
    user_doc = user_ref.get()

    if not user_doc.exists:
        # User not in Firestore yet — create with defaults first
        user_data = {
            'uid': uid,
            'email': '',
            'lecture_credits_standard': FREE_LECTURE_CREDITS,
            'lecture_credits_extended': 0,
            'slides_credits': FREE_SLIDES_CREDITS,
            'interview_credits_short': FREE_INTERVIEW_CREDITS,
            'interview_credits_medium': 0,
            'interview_credits_long': 0,
            'total_processed': 0,
            'created_at': time.time(),
        }
        user_ref.set(user_data)

    # Add the purchased credits
    for credit_key, credit_amount in bundle['credits'].items():
        user_ref.update({credit_key: firestore.Increment(credit_amount)})
        print(f"Granted {credit_amount} '{credit_key}' credits to user {uid}.")

    return True

def deduct_credit(uid, credit_type_primary, credit_type_fallback=None):
    """Deduct one credit from the user. Returns the credit type that was deducted, or None if no credits."""
    user_ref = db.collection('users').document(uid)
    user_doc = user_ref.get()

    if not user_doc.exists:
        return None

    user_data = user_doc.to_dict()

    if user_data.get(credit_type_primary, 0) > 0:
        user_ref.update({
            credit_type_primary: firestore.Increment(-1),
            'total_processed': firestore.Increment(1),
        })
        return credit_type_primary
    elif credit_type_fallback and user_data.get(credit_type_fallback, 0) > 0:
        user_ref.update({
            credit_type_fallback: firestore.Increment(-1),
            'total_processed': firestore.Increment(1),
        })
        return credit_type_fallback
    else:
        return None

def deduct_interview_credit(uid):
    """Deduct one interview credit, checking short -> medium -> long. Returns the credit type deducted, or None."""
    user_ref = db.collection('users').document(uid)
    user_doc = user_ref.get()

    if not user_doc.exists:
        return None

    user_data = user_doc.to_dict()

    if user_data.get('interview_credits_short', 0) > 0:
        user_ref.update({
            'interview_credits_short': firestore.Increment(-1),
            'total_processed': firestore.Increment(1),
        })
        return 'interview_credits_short'
    elif user_data.get('interview_credits_medium', 0) > 0:
        user_ref.update({
            'interview_credits_medium': firestore.Increment(-1),
            'total_processed': firestore.Increment(1),
        })
        return 'interview_credits_medium'
    elif user_data.get('interview_credits_long', 0) > 0:
        user_ref.update({
            'interview_credits_long': firestore.Increment(-1),
            'total_processed': firestore.Increment(1),
        })
        return 'interview_credits_long'
    else:
        return None

def refund_credit(uid, credit_type):
    """Refund one credit back to the user after a failed processing job."""
    if not uid or not credit_type:
        return
    try:
        user_ref = db.collection('users').document(uid)
        user_ref.update({
            credit_type: firestore.Increment(1),
            'total_processed': firestore.Increment(-1),
        })
        print(f"✅ Refunded 1 '{credit_type}' credit to user {uid} due to processing failure.")
    except Exception as e:
        print(f"❌ Failed to refund credit '{credit_type}' to user {uid}: {e}")

def save_purchase_record(uid, bundle_id, stripe_session_id):
    """Save a purchase record to Firestore for purchase history."""
    bundle = CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        return
    try:
        db.collection('purchases').add({
            'uid': uid,
            'bundle_id': bundle_id,
            'bundle_name': bundle['name'],
            'price_cents': bundle['price_cents'],
            'currency': bundle['currency'],
            'credits': bundle['credits'],
            'stripe_session_id': stripe_session_id,
            'created_at': time.time(),
        })
        print(f"📝 Saved purchase record for user {uid}: {bundle['name']}")
    except Exception as e:
        print(f"❌ Failed to save purchase record for user {uid}: {e}")

def save_job_log(job_id, job_data, finished_at):
    """Save a processing job log to Firestore for analytics."""
    try:
        started_at = job_data.get('started_at', 0)
        duration = round(finished_at - started_at, 1) if started_at else 0
        db.collection('job_logs').document(job_id).set({
            'job_id': job_id,
            'uid': job_data.get('user_id', ''),
            'email': job_data.get('user_email', ''),
            'mode': job_data.get('mode', ''),
            'status': job_data.get('status', ''),
            'credit_deducted': job_data.get('credit_deducted', ''),
            'credit_refunded': job_data.get('credit_refunded', False),
            'error_message': job_data.get('error', ''),
            'started_at': started_at,
            'finished_at': finished_at,
            'duration_seconds': duration,
        })
        print(f"📊 Logged job {job_id}: mode={job_data.get('mode')}, status={job_data.get('status')}, duration={duration}s")
    except Exception as e:
        print(f"❌ Failed to log job {job_id}: {e}")

# =============================================
# HELPER FUNCTIONS
# =============================================

def verify_firebase_token(request):
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '): return None
    token = auth_header.split('Bearer ')[1]
    try:
        return auth.verify_id_token(token)
    except Exception as e:
        print(f"Token verification failed: {e}")
        return None

def is_admin_user(decoded_token):
    if not decoded_token:
        return False
    uid = decoded_token.get('uid', '')
    email = decoded_token.get('email', '').lower()
    return uid in ADMIN_UIDS or email in ADMIN_EMAILS

def get_admin_window(window_key):
    windows = {
        '24h': 24 * 60 * 60,
        '7d': 7 * 24 * 60 * 60,
        '30d': 30 * 24 * 60 * 60,
    }
    safe_key = window_key if window_key in windows else '7d'
    return safe_key, windows[safe_key]

def get_timestamp(value):
    return value if isinstance(value, (int, float)) else 0

def build_time_buckets(window_key, now_ts):
    labels = []
    keys = []
    if window_key == '24h':
        now_dt = datetime.utcfromtimestamp(now_ts).replace(minute=0, second=0, microsecond=0)
        start_dt = now_dt - timedelta(hours=23)
        for i in range(24):
            current = start_dt + timedelta(hours=i)
            labels.append(current.strftime('%H:%M'))
            keys.append(current.strftime('%Y-%m-%d %H:00'))
        granularity = 'hour'
    else:
        days = 7 if window_key == '7d' else 30
        now_dt = datetime.utcfromtimestamp(now_ts).replace(hour=0, minute=0, second=0, microsecond=0)
        start_dt = now_dt - timedelta(days=days - 1)
        for i in range(days):
            current = start_dt + timedelta(days=i)
            labels.append(current.strftime('%d %b'))
            keys.append(current.strftime('%Y-%m-%d'))
        granularity = 'day'
    return labels, keys, granularity

def get_bucket_key(timestamp, window_key):
    dt = datetime.utcfromtimestamp(timestamp)
    if window_key == '24h':
        return dt.replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%d %H:00')
    return dt.replace(hour=0, minute=0, second=0, microsecond=0).strftime('%Y-%m-%d')

def allowed_file(filename, allowed_extensions):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed_extensions

def get_mime_type(filename):
    ext = filename.rsplit('.', 1)[1].lower()
    mime_types = {'pdf': 'application/pdf', 'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'wav': 'audio/wav', 'aac': 'audio/aac', 'ogg': 'audio/ogg', 'flac': 'audio/flac'}
    return mime_types.get(ext, 'application/octet-stream')

def wait_for_file_processing(uploaded_file):
    max_wait_time = 300
    wait_interval = 5
    total_waited = 0
    while total_waited < max_wait_time:
        file_info = client.files.get(name=uploaded_file.name)
        if file_info.state.name == 'ACTIVE': return True
        elif file_info.state.name == 'FAILED': raise Exception(f"File processing failed: {uploaded_file.name}")
        time.sleep(wait_interval)
        total_waited += wait_interval
    raise Exception(f"File processing timed out after {max_wait_time} seconds")

def cleanup_files(local_paths, gemini_files):
    for path in local_paths:
        try:
            if os.path.exists(path): os.remove(path)
        except Exception as e: print(f"Warning: Could not delete local file {path}: {e}")
    for gemini_file in gemini_files:
        try:
            client.files.delete(name=gemini_file.name)
        except Exception as e: print(f"Warning: Could not delete Gemini file {gemini_file.name}: {e}")

def markdown_to_docx(markdown_text, title="Document"):
    doc = Document()
    style = doc.styles['Normal']
    style.font.name = 'Calibri'
    style.font.size = Pt(11)
    lines = markdown_text.split('\n')
    i = 0
    is_transcript = any(len(line.strip()) > 3 and line.strip()[0].isdigit() and ':' in line.strip()[:6] and ' - ' in line for line in lines[:20])
    
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith('### '): doc.add_heading(line[4:], level=3)
        elif line.startswith('## '): doc.add_heading(line[3:], level=2)
        elif line.startswith('# '): doc.add_heading(line[2:], level=1)
        elif line.startswith('- ') or line.startswith('* '): doc.add_paragraph(line[2:], style='List Bullet')
        elif len(line) > 2 and line[0].isdigit() and line[1] == '.' and line[2] == ' ': doc.add_paragraph(line[3:], style='List Number')
        elif is_transcript and len(line) > 3 and line[0].isdigit() and ':' in line[:6]: doc.add_paragraph(line)
        else:
            if is_transcript:
                p = doc.add_paragraph()
                parts = line.split('**')
                for j, part in enumerate(parts):
                    if j % 2 == 1:
                        run = p.add_run(part)
                        run.bold = True
                    else:
                        italic_parts = part.split('*')
                        for k, italic_part in enumerate(italic_parts):
                            run = p.add_run(italic_part)
                            if k % 2 == 1: run.italic = True
            else:
                paragraph_lines = [line]
                while i + 1 < len(lines):
                    next_line = lines[i + 1].strip()
                    if (next_line and not next_line.startswith('#') and not next_line.startswith('- ') and not next_line.startswith('* ') and not (len(next_line) > 2 and next_line[0].isdigit() and next_line[1] == '.')):
                        paragraph_lines.append(next_line)
                        i += 1
                    else: break
                paragraph_text = ' '.join(paragraph_lines)
                p = doc.add_paragraph()
                parts = paragraph_text.split('**')
                for j, part in enumerate(parts):
                    if j % 2 == 1:
                        run = p.add_run(part)
                        run.bold = True
                    else:
                        italic_parts = part.split('*')
                        for k, italic_part in enumerate(italic_parts):
                            run = p.add_run(italic_part)
                            if k % 2 == 1: run.italic = True
        i += 1
    return doc

# =============================================
# AI PROCESSING FUNCTIONS
# =============================================

def process_lecture_notes(job_id, pdf_path, audio_path):
    gemini_files = []
    local_paths = [pdf_path, audio_path]
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Extracting text from slides...'
        pdf_file = client.files.upload(file=pdf_path, config={'mime_type': 'application/pdf'})
        gemini_files.append(pdf_file)
        wait_for_file_processing(pdf_file)
        response = client.models.generate_content(model=MODEL_SLIDES, contents=[types.Content(role='user', parts=[types.Part.from_uri(file_uri=pdf_file.uri, mime_type='application/pdf'), types.Part.from_text(text=PROMPT_SLIDE_EXTRACTION)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        slide_text = response.text
        jobs[job_id]['slide_text'] = slide_text
        
        jobs[job_id]['step'] = 2
        jobs[job_id]['step_description'] = 'Transcribing audio...'
        audio_mime_type = get_mime_type(audio_path)
        audio_file = client.files.upload(file=audio_path, config={'mime_type': audio_mime_type})
        gemini_files.append(audio_file)
        jobs[job_id]['step_description'] = 'Processing audio file (this may take a few minutes)...'
        wait_for_file_processing(audio_file)
        jobs[job_id]['step_description'] = 'Generating transcript...'
        response = client.models.generate_content(model=MODEL_AUDIO, contents=[types.Content(role='user', parts=[types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type), types.Part.from_text(text=PROMPT_AUDIO_TRANSCRIPTION)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        transcript = response.text
        jobs[job_id]['transcript'] = transcript
        
        jobs[job_id]['step'] = 3
        jobs[job_id]['step_description'] = 'Creating complete lecture notes...'
        merge_prompt = PROMPT_MERGE_TEMPLATE.format(slide_text=slide_text, transcript=transcript)
        response = client.models.generate_content(model=MODEL_INTEGRATION, contents=[types.Content(role='user', parts=[types.Part.from_text(text=merge_prompt)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        merged_notes = response.text
        
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = 3
        jobs[job_id]['step_description'] = 'Complete!'
        jobs[job_id]['result'] = merged_notes
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        # Refund the credit since processing failed
        uid = jobs[job_id].get('user_id')
        credit_type = jobs[job_id].get('credit_deducted')
        refund_credit(uid, credit_type)
        jobs[job_id]['credit_refunded'] = True
    finally:
        cleanup_files(local_paths, gemini_files)
        # Log the job to Firestore
        save_job_log(job_id, jobs[job_id], time.time())

def process_slides_only(job_id, pdf_path):
    gemini_files = []
    local_paths = [pdf_path]
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Extracting text from slides...'
        pdf_file = client.files.upload(file=pdf_path, config={'mime_type': 'application/pdf'})
        gemini_files.append(pdf_file)
        wait_for_file_processing(pdf_file)
        response = client.models.generate_content(model=MODEL_SLIDES, contents=[types.Content(role='user', parts=[types.Part.from_uri(file_uri=pdf_file.uri, mime_type='application/pdf'), types.Part.from_text(text=PROMPT_SLIDE_EXTRACTION)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Complete!'
        jobs[job_id]['result'] = response.text
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        # Refund the credit since processing failed
        uid = jobs[job_id].get('user_id')
        credit_type = jobs[job_id].get('credit_deducted')
        refund_credit(uid, credit_type)
        jobs[job_id]['credit_refunded'] = True
    finally:
        cleanup_files(local_paths, gemini_files)
        # Log the job to Firestore
        save_job_log(job_id, jobs[job_id], time.time())

def process_interview_transcription(job_id, audio_path):
    gemini_files = []
    local_paths = [audio_path]
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Processing audio file...'
        audio_mime_type = get_mime_type(audio_path)
        audio_file = client.files.upload(file=audio_path, config={'mime_type': audio_mime_type})
        gemini_files.append(audio_file)
        jobs[job_id]['step_description'] = 'Processing audio file (this may take a few minutes)...'
        wait_for_file_processing(audio_file)
        jobs[job_id]['step_description'] = 'Generating transcript with timestamps...'
        response = client.models.generate_content(model=MODEL_INTERVIEW, contents=[types.Content(role='user', parts=[types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type), types.Part.from_text(text=PROMPT_INTERVIEW_TRANSCRIPTION)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Complete!'
        jobs[job_id]['result'] = response.text
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        # Refund the credit since processing failed
        uid = jobs[job_id].get('user_id')
        credit_type = jobs[job_id].get('credit_deducted')
        refund_credit(uid, credit_type)
        jobs[job_id]['credit_refunded'] = True
    finally:
        cleanup_files(local_paths, gemini_files)
        # Log the job to Firestore
        save_job_log(job_id, jobs[job_id], time.time())

# =============================================
# ROUTES
# =============================================

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/admin')
def admin_dashboard():
    return render_template('admin.html')

@app.route('/api/verify-email', methods=['POST'])
def verify_email():
    email = request.get_json().get('email', '')
    if is_email_allowed(email):
        return jsonify({'allowed': True})
    return jsonify({'allowed': False, 'message': 'Please use your university email or a major email provider (Gmail, Outlook, iCloud, Yahoo).'})

@app.route('/api/auth/user', methods=['GET'])
def get_user():
    decoded_token = verify_firebase_token(request)
    if not decoded_token: return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not is_email_allowed(email): return jsonify({'error': 'Email not allowed', 'message': 'Please use your university email.'}), 403
    user = get_or_create_user(uid, email)
    return jsonify({
        'uid': user['uid'], 'email': user['email'],
        'credits': {
            'lecture_standard': user.get('lecture_credits_standard', 0),
            'lecture_extended': user.get('lecture_credits_extended', 0),
            'slides': user.get('slides_credits', 0),
            'interview_short': user.get('interview_credits_short', 0),
            'interview_medium': user.get('interview_credits_medium', 0),
            'interview_long': user.get('interview_credits_long', 0),
        },
        'total_processed': user.get('total_processed', 0)
    })

# --- Stripe Routes ---

@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        'stripe_publishable_key': STRIPE_PUBLISHABLE_KEY,
        'bundles': {
            bundle_id: {
                'name': bundle['name'],
                'description': bundle['description'],
                'price_cents': bundle['price_cents'],
                'currency': bundle['currency'],
                'credits': bundle['credits'],
            }
            for bundle_id, bundle in CREDIT_BUNDLES.items()
        }
    })

@app.route('/api/create-checkout-session', methods=['POST'])
def create_checkout_session():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')

    data = request.get_json()
    bundle_id = data.get('bundle_id', '')

    if bundle_id not in CREDIT_BUNDLES:
        return jsonify({'error': 'Invalid bundle selected'}), 400

    bundle = CREDIT_BUNDLES[bundle_id]

    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card', 'ideal'],
            line_items=[{
                'price_data': {
                    'currency': bundle['currency'],
                    'product_data': {
                        'name': bundle['name'],
                        'description': bundle['description'],
                    },
                    'unit_amount': bundle['price_cents'],
                },
                'quantity': 1,
            }],
            mode='payment',
            success_url=request.host_url.rstrip('/') + '?payment=success',
            cancel_url=request.host_url.rstrip('/') + '?payment=cancelled',
            customer_email=email,
            metadata={
                'uid': uid,
                'bundle_id': bundle_id,
            },
        )
        return jsonify({'checkout_url': checkout_session.url})
    except Exception as e:
        print(f"Stripe checkout error: {e}")
        return jsonify({'error': 'Could not create checkout session. Please try again.'}), 500

@app.route('/api/stripe-webhook', methods=['POST'])
def stripe_webhook():
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature', '')

    if STRIPE_WEBHOOK_SECRET:
        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, STRIPE_WEBHOOK_SECRET
            )
        except ValueError:
            print("Stripe webhook: Invalid payload")
            return 'Invalid payload', 400
        except Exception as e:
            print(f"Stripe webhook signature verification failed: {e}")
            return 'Invalid signature', 400
    else:
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            return 'Invalid payload', 400

    if event.get('type') == 'checkout.session.completed':
        session = event['data']['object']
        metadata = session.get('metadata', {})
        uid = metadata.get('uid', '')
        bundle_id = metadata.get('bundle_id', '')
        stripe_session_id = session.get('id', '')

        if uid and bundle_id:
            success = grant_credits_to_user(uid, bundle_id)
            if success:
                print(f"✅ Payment successful! Granted bundle '{bundle_id}' to user '{uid}'")
                # Save purchase record for history
                save_purchase_record(uid, bundle_id, stripe_session_id)
            else:
                print(f"❌ Failed to grant bundle '{bundle_id}' to user '{uid}'")
        else:
            print(f"⚠️ Webhook received but missing metadata. uid='{uid}', bundle_id='{bundle_id}'")

    return '', 200

# --- Purchase History Route ---

@app.route('/api/purchase-history', methods=['GET'])
def get_purchase_history():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']

    try:
        purchases_ref = db.collection('purchases').where('uid', '==', uid).order_by('created_at', direction=firestore.Query.DESCENDING).limit(50)
        purchases = []
        for doc in purchases_ref.stream():
            p = doc.to_dict()
            purchases.append({
                'id': doc.id,
                'bundle_name': p.get('bundle_name', 'Unknown'),
                'price_cents': p.get('price_cents', 0),
                'currency': p.get('currency', 'eur'),
                'credits': p.get('credits', {}),
                'created_at': p.get('created_at', 0),
            })
        return jsonify({'purchases': purchases})
    except Exception as e:
        print(f"Error fetching purchase history: {e}")
        return jsonify({'purchases': []})

@app.route('/api/admin/overview', methods=['GET'])
def get_admin_overview():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    if not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403

    try:
        window_key, window_seconds = get_admin_window(request.args.get('window', '7d'))
        now_ts = time.time()
        window_start = now_ts - window_seconds

        users_docs = list(db.collection('users').stream())
        purchases_docs = list(db.collection('purchases').stream())
        jobs_docs = list(db.collection('job_logs').stream())

        total_users = len(users_docs)
        new_users = 0
        for doc in users_docs:
            created_at = get_timestamp(doc.to_dict().get('created_at'))
            if created_at >= window_start:
                new_users += 1
        total_processed = sum((doc.to_dict().get('total_processed', 0) or 0) for doc in users_docs)

        total_revenue_cents = 0
        purchase_count = 0
        filtered_purchases = []
        for doc in purchases_docs:
            purchase = doc.to_dict()
            created_at = get_timestamp(purchase.get('created_at'))
            if created_at < window_start:
                continue
            filtered_purchases.append(purchase)
            purchase_count += 1
            total_revenue_cents += purchase.get('price_cents', 0) or 0

        job_count = 0
        success_jobs = 0
        failed_jobs = 0
        refunded_jobs = 0
        durations = []
        filtered_jobs = []
        for doc in jobs_docs:
            job = doc.to_dict()
            finished_at = get_timestamp(job.get('finished_at'))
            if finished_at < window_start:
                continue
            filtered_jobs.append(job)
            job_count += 1
            status = job.get('status', '')
            if status == 'complete':
                success_jobs += 1
            elif status == 'error':
                failed_jobs += 1
            if job.get('credit_refunded'):
                refunded_jobs += 1
            duration = job.get('duration_seconds')
            if isinstance(duration, (int, float)):
                durations.append(duration)

        avg_duration_seconds = round(sum(durations) / len(durations), 1) if durations else 0

        mode_breakdown = {
            'lecture-notes': {'label': 'Lecture Notes', 'total': 0, 'complete': 0, 'error': 0},
            'slides-only': {'label': 'Slides Only', 'total': 0, 'complete': 0, 'error': 0},
            'interview': {'label': 'Interview Transcript', 'total': 0, 'complete': 0, 'error': 0},
            'other': {'label': 'Other', 'total': 0, 'complete': 0, 'error': 0},
        }
        for job in filtered_jobs:
            mode = job.get('mode', '')
            key = mode if mode in mode_breakdown else 'other'
            status = job.get('status', '')
            mode_breakdown[key]['total'] += 1
            if status == 'complete':
                mode_breakdown[key]['complete'] += 1
            elif status == 'error':
                mode_breakdown[key]['error'] += 1

        recent_jobs_sorted = sorted(
            filtered_jobs,
            key=lambda j: get_timestamp(j.get('finished_at')),
            reverse=True
        )[:20]
        recent_jobs = []
        for job in recent_jobs_sorted:
            recent_jobs.append({
                'job_id': job.get('job_id', ''),
                'email': job.get('email', ''),
                'mode': job.get('mode', ''),
                'status': job.get('status', ''),
                'duration_seconds': job.get('duration_seconds', 0),
                'credit_refunded': job.get('credit_refunded', False),
                'finished_at': job.get('finished_at', 0),
            })

        recent_purchases_sorted = sorted(
            filtered_purchases,
            key=lambda p: get_timestamp(p.get('created_at')),
            reverse=True
        )[:20]
        recent_purchases = []
        for purchase in recent_purchases_sorted:
            recent_purchases.append({
                'uid': purchase.get('uid', ''),
                'bundle_name': purchase.get('bundle_name', 'Unknown'),
                'price_cents': purchase.get('price_cents', 0),
                'currency': purchase.get('currency', 'eur'),
                'created_at': purchase.get('created_at', 0),
            })

        trend_labels, trend_keys, trend_granularity = build_time_buckets(window_key, now_ts)
        success_by_bucket = {key: {'complete': 0, 'error': 0} for key in trend_keys}
        revenue_by_bucket = {key: 0 for key in trend_keys}

        for job in filtered_jobs:
            timestamp = get_timestamp(job.get('finished_at'))
            bucket_key = get_bucket_key(timestamp, window_key)
            if bucket_key not in success_by_bucket:
                continue
            status = job.get('status', '')
            if status == 'complete':
                success_by_bucket[bucket_key]['complete'] += 1
            elif status == 'error':
                success_by_bucket[bucket_key]['error'] += 1

        for purchase in filtered_purchases:
            timestamp = get_timestamp(purchase.get('created_at'))
            bucket_key = get_bucket_key(timestamp, window_key)
            if bucket_key not in revenue_by_bucket:
                continue
            revenue_by_bucket[bucket_key] += purchase.get('price_cents', 0) or 0

        success_trend = []
        revenue_trend = []
        for key in trend_keys:
            complete_count = success_by_bucket[key]['complete']
            error_count = success_by_bucket[key]['error']
            total_count = complete_count + error_count
            success_rate = round((complete_count / total_count) * 100, 1) if total_count > 0 else 0
            success_trend.append(success_rate)
            revenue_trend.append(revenue_by_bucket[key])

        return jsonify({
            'window': {
                'key': window_key,
                'start': window_start,
                'end': now_ts,
            },
            'metrics': {
                'total_users': total_users,
                'new_users': new_users,
                'total_processed': total_processed,
                'total_revenue_cents': total_revenue_cents,
                'purchase_count': purchase_count,
                'job_count': job_count,
                'success_jobs': success_jobs,
                'failed_jobs': failed_jobs,
                'refunded_jobs': refunded_jobs,
                'avg_duration_seconds': avg_duration_seconds,
            },
            'trends': {
                'labels': trend_labels,
                'success_rate': success_trend,
                'revenue_cents': revenue_trend,
                'granularity': trend_granularity,
            },
            'mode_breakdown': mode_breakdown,
            'recent_jobs': recent_jobs,
            'recent_purchases': recent_purchases,
        })
    except Exception as e:
        print(f"Error fetching admin overview: {e}")
        return jsonify({'error': 'Could not fetch admin dashboard data'}), 500

@app.route('/api/admin/export', methods=['GET'])
def export_admin_csv():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    if not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403

    export_type = request.args.get('type', 'jobs')
    if export_type not in {'jobs', 'purchases'}:
        return jsonify({'error': 'Invalid export type'}), 400

    window_key, window_seconds = get_admin_window(request.args.get('window', '7d'))
    now_ts = time.time()
    window_start = now_ts - window_seconds

    output = io.StringIO()
    writer = csv.writer(output)

    try:
        if export_type == 'jobs':
            writer.writerow([
                'job_id', 'uid', 'email', 'mode', 'status', 'credit_deducted',
                'credit_refunded', 'error_message', 'started_at', 'finished_at', 'duration_seconds'
            ])
            for doc in db.collection('job_logs').stream():
                job = doc.to_dict()
                finished_at = get_timestamp(job.get('finished_at'))
                if finished_at < window_start:
                    continue
                writer.writerow([
                    job.get('job_id', doc.id),
                    job.get('uid', ''),
                    job.get('email', ''),
                    job.get('mode', ''),
                    job.get('status', ''),
                    job.get('credit_deducted', ''),
                    job.get('credit_refunded', False),
                    job.get('error_message', ''),
                    job.get('started_at', 0),
                    job.get('finished_at', 0),
                    job.get('duration_seconds', 0),
                ])
        else:
            writer.writerow([
                'uid', 'bundle_id', 'bundle_name', 'price_cents', 'currency',
                'credits', 'stripe_session_id', 'created_at'
            ])
            for doc in db.collection('purchases').stream():
                purchase = doc.to_dict()
                created_at = get_timestamp(purchase.get('created_at'))
                if created_at < window_start:
                    continue
                writer.writerow([
                    purchase.get('uid', ''),
                    purchase.get('bundle_id', ''),
                    purchase.get('bundle_name', ''),
                    purchase.get('price_cents', 0),
                    purchase.get('currency', 'eur'),
                    json.dumps(purchase.get('credits', {}), ensure_ascii=True),
                    purchase.get('stripe_session_id', ''),
                    purchase.get('created_at', 0),
                ])

        filename = f"admin-{export_type}-{window_key}.csv"
        response = app.response_class(output.getvalue(), mimetype='text/csv')
        response.headers['Content-Disposition'] = f'attachment; filename={filename}'
        return response
    except Exception as e:
        print(f"Error exporting admin CSV ({export_type}): {e}")
        return jsonify({'error': 'Could not export CSV'}), 500

# --- Upload & Processing Routes ---

@app.route('/upload', methods=['POST'])
def upload_files():
    decoded_token = verify_firebase_token(request)
    if not decoded_token: return jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not is_email_allowed(email): return jsonify({'error': 'Email not allowed'}), 403
    user = get_or_create_user(uid, email)
    mode = request.form.get('mode', 'lecture-notes')
    
    if mode == 'lecture-notes':
        total_lecture = user.get('lecture_credits_standard', 0) + user.get('lecture_credits_extended', 0)
        if total_lecture <= 0:
            return jsonify({'error': 'No lecture credits remaining. Please purchase more credits.'}), 402
        if 'pdf' not in request.files or 'audio' not in request.files: return jsonify({'error': 'Both PDF and audio files are required'}), 400
        pdf_file = request.files['pdf']
        audio_file = request.files['audio']
        if pdf_file.filename == '' or audio_file.filename == '': return jsonify({'error': 'Both files must be selected'}), 400
        if not allowed_file(pdf_file.filename, ALLOWED_PDF_EXTENSIONS): return jsonify({'error': 'Invalid PDF file'}), 400
        if not allowed_file(audio_file.filename, ALLOWED_AUDIO_EXTENSIONS): return jsonify({'error': 'Invalid audio file'}), 400
        job_id = str(uuid.uuid4())
        pdf_path = os.path.join(UPLOAD_FOLDER, f"{job_id}_{secure_filename(pdf_file.filename)}")
        audio_path = os.path.join(UPLOAD_FOLDER, f"{job_id}_{secure_filename(audio_file.filename)}")
        pdf_file.save(pdf_path)
        audio_file.save(audio_path)
        deducted = deduct_credit(uid, 'lecture_credits_standard', 'lecture_credits_extended')
        if not deducted:
            return jsonify({'error': 'No lecture credits remaining.'}), 402
        jobs[job_id] = {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': 3, 'mode': 'lecture-notes', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': time.time(), 'result': None, 'slide_text': None, 'transcript': None, 'error': None}
        thread = threading.Thread(target=process_lecture_notes, args=(job_id, pdf_path, audio_path))
        thread.start()
        
    elif mode == 'slides-only':
        if user.get('slides_credits', 0) <= 0:
            return jsonify({'error': 'No slides credits remaining. Please purchase more credits.'}), 402
        if 'pdf' not in request.files: return jsonify({'error': 'PDF file is required'}), 400
        pdf_file = request.files['pdf']
        if pdf_file.filename == '': return jsonify({'error': 'PDF file must be selected'}), 400
        if not allowed_file(pdf_file.filename, ALLOWED_PDF_EXTENSIONS): return jsonify({'error': 'Invalid PDF file'}), 400
        job_id = str(uuid.uuid4())
        pdf_path = os.path.join(UPLOAD_FOLDER, f"{job_id}_{secure_filename(pdf_file.filename)}")
        pdf_file.save(pdf_path)
        deducted = deduct_credit(uid, 'slides_credits')
        if not deducted:
            return jsonify({'error': 'No slides credits remaining.'}), 402
        jobs[job_id] = {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': 1, 'mode': 'slides-only', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': time.time(), 'result': None, 'error': None}
        thread = threading.Thread(target=process_slides_only, args=(job_id, pdf_path))
        thread.start()
        
    elif mode == 'interview':
        total_interview = user.get('interview_credits_short', 0) + user.get('interview_credits_medium', 0) + user.get('interview_credits_long', 0)
        if total_interview <= 0:
            return jsonify({'error': 'No interview credits remaining. Please purchase more credits.'}), 402
        if 'audio' not in request.files: return jsonify({'error': 'Audio file is required'}), 400
        audio_file = request.files['audio']
        if audio_file.filename == '': return jsonify({'error': 'Audio file must be selected'}), 400
        if not allowed_file(audio_file.filename, ALLOWED_AUDIO_EXTENSIONS): return jsonify({'error': 'Invalid audio file'}), 400
        job_id = str(uuid.uuid4())
        audio_path = os.path.join(UPLOAD_FOLDER, f"{job_id}_{secure_filename(audio_file.filename)}")
        audio_file.save(audio_path)
        deducted = deduct_interview_credit(uid)
        if not deducted:
            return jsonify({'error': 'No interview credits remaining.'}), 402
        jobs[job_id] = {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': 1, 'mode': 'interview', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': time.time(), 'result': None, 'error': None}
        thread = threading.Thread(target=process_interview_transcription, args=(job_id, audio_path))
        thread.start()
        
    return jsonify({'job_id': job_id})

@app.route('/status/<job_id>')
def get_status(job_id):
    if job_id not in jobs: return jsonify({'error': 'Job not found'}), 404
    job = jobs[job_id]
    response = {'status': job['status'], 'step': job['step'], 'step_description': job['step_description'], 'total_steps': job.get('total_steps', 3), 'mode': job.get('mode', 'lecture-notes')}
    if job['status'] == 'complete':
        response['result'] = job['result']
        if job.get('mode') == 'lecture-notes':
            response['slide_text'] = job.get('slide_text')
            response['transcript'] = job.get('transcript')
    elif job['status'] == 'error':
        response['error'] = job['error']
        response['credit_refunded'] = job.get('credit_refunded', False)
    return jsonify(response)

@app.route('/download-docx/<job_id>')
def download_docx(job_id):
    if job_id not in jobs: return jsonify({'error': 'Job not found'}), 404
    job = jobs[job_id]
    if job['status'] != 'complete': return jsonify({'error': 'Job not complete'}), 400
    content_type = request.args.get('type', 'result')
    
    if content_type == 'slides' and job.get('slide_text'):
        content, filename, title = job['slide_text'], 'extracted-slides.docx', 'Extracted Slides'
    elif content_type == 'transcript' and job.get('transcript'):
        content, filename, title = job['transcript'], 'transcript.docx', 'Lecture Transcript'
    else:
        content = job['result']
        mode = job.get('mode', 'lecture-notes')
        if mode == 'lecture-notes': filename, title = 'lecture-notes.docx', 'Lecture Notes'
        elif mode == 'slides-only': filename, title = 'extracted-slides.docx', 'Extracted Slides'
        else: filename, title = 'interview-transcript.docx', 'Interview Transcript'
        
    doc = markdown_to_docx(content, title)
    docx_io = io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    return send_file(docx_io, mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document', as_attachment=True, download_name=filename)

if __name__ == '__main__':
    app.run(debug=True, port=5000)
