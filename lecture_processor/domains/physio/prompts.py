"""Prompt templates for Physio Assistant."""

from __future__ import annotations

import json


PHYSIO_TRANSCRIPTION_PROMPT = """Transcribeer dit fysiotherapieconsult in het Nederlands.

Regels:
- Gebruik waar mogelijk sprekerlabels zoals [Therapeut] en [Patiënt].
- Behoud klinische termen zo letterlijk mogelijk.
- Noteer alleen hoorbare informatie; verzin niets.
- Markeer onduidelijke passages als [onverstaanbaar].
- Houd het transcript goed leesbaar met korte alinea's.
"""


SOAP_RESPONSE_SHAPE = {
    "subjective": {
        "hulpvraag": None,
        "hoofdklacht": None,
        "pijn_beschrijving": None,
        "functionele_beperkingen": None,
        "voorgeschiedenis": None,
        "medicatie": None,
        "beloop": None,
        "verwachtingen_patient": None,
        "overig_subjectief": None,
    },
    "objective": {
        "inspectie": None,
        "palpatie": None,
        "actief_bewegingsonderzoek": None,
        "passief_bewegingsonderzoek": None,
        "spierkracht": None,
        "speciale_testen": None,
        "neurologisch_onderzoek": None,
        "functionele_testen": None,
        "meetinstrumenten": None,
        "overig_objectief": None,
    },
    "assessment": {
        "fysiotherapeutische_diagnose": None,
        "betrokken_structuren": None,
        "fase_herstel": None,
        "belemmerende_factoren": None,
        "bevorderende_factoren": None,
        "prognose": None,
    },
    "plan": {
        "behandeldoelen": None,
        "behandelplan": None,
        "frequentie": None,
        "thuisoefeningen": None,
        "adviezen": None,
        "evaluatie": None,
        "verwijzing": None,
    },
}


RPS_RESPONSE_SHAPE = {
    "header": {
        "naam_patient": None,
        "leeftijd": None,
        "geslacht": None,
        "datum": None,
        "pathologie": None,
        "medicatie": None,
    },
    "volgens_patient": {
        "functies_stoornissen": None,
        "activiteiten": None,
        "participatie": None,
    },
    "volgens_therapeut": {
        "functies_stoornissen": {
            "pijn": {
                "type": None,
                "nprs_score": None,
                "locatie": None,
                "provocatie": None,
            },
            "mobiliteit": {
                "arom": None,
                "prom": None,
            },
            "spierfunctie": {
                "kracht": None,
                "uithoudingsvermogen": None,
                "snelheid": None,
                "coordinatie": None,
                "lenigheid": None,
            },
            "sensibiliteit_proprioceptie": None,
            "tonus": None,
            "stabiliteit": {
                "passief": None,
                "actief": None,
            },
        },
        "activiteiten": {
            "reiken": None,
            "grijpen": None,
            "schrijven": None,
            "dragen": None,
            "tillen": None,
            "haarkammen": None,
            "aankleden": None,
            "wassen": None,
            "deur_open_maken": None,
            "lopen": None,
            "overige_activiteiten": None,
        },
        "participatie": {
            "deelname_verkeer": None,
            "deelname_werk": None,
            "deelname_hobbys": None,
            "sport": None,
        },
    },
    "persoonlijke_factoren": {
        "cognitief": None,
        "emotioneel": None,
        "sociaal": None,
    },
    "omgevingsfactoren": {
        "beschrijving": None,
    },
    "differentiaal_diagnostiek": {
        "hypothese_1": None,
        "hypothese_2": None,
        "hypothese_3": None,
        "hulpvraag": None,
    },
}


REASONING_RESPONSE_SHAPE = {
    "stap_1_onduidelijke_termen": [],
    "stap_2_3_probleemdefinitie": {
        "persoonsgegevens": None,
        "verwijzing": None,
        "patientencategorie": None,
        "additioneel_onderzoek": None,
        "icf_classificatie": {
            "volgens_patient": {
                "functies_stoornissen": None,
                "activiteiten": None,
                "participatie": None,
            },
            "volgens_therapeut": {
                "functies_stoornissen": None,
                "activiteiten": None,
                "participatie": None,
            },
            "persoonlijke_factoren": None,
            "externe_factoren": None,
        },
    },
    "stap_4_gezondheidsprobleem": {
        "horizontale_relaties": [],
        "persoonlijke_factor_invloed": None,
        "externe_factor_invloed": None,
        "medisch_biologische_processen": None,
    },
    "stap_5_diagnostisch_proces": {
        "screening": {
            "rode_vlaggen": None,
            "gele_vlaggen": None,
        },
        "medische_diagnose_type": None,
        "indicatie_fysiotherapie": None,
        "voorgesteld_onderzoek": {
            "anamnese_vragen": [],
            "inspectie": None,
            "palpatie": None,
            "functieonderzoek": None,
            "speciale_testen": [],
            "meetinstrumenten": [],
        },
        "fysiotherapeutische_conclusie": None,
    },
    "stap_6_therapeutisch_proces": {
        "hoofddoel": None,
        "subdoelen": [],
        "evaluatieve_meetinstrumenten": [],
        "behandelmethoden": {
            "informeren_adviseren": None,
            "interventies": [],
        },
        "hulpmiddelen": None,
        "multidisciplinair": None,
    },
    "stap_7_effect_therapie": {
        "verwacht_effect_informeren": None,
        "verwacht_effect_interventies": [],
    },
}


DIFFERENTIAL_RESPONSE_SHAPE = {
    "hypothesen": [
        {"titel": None, "onderbouwing": None},
        {"titel": None, "onderbouwing": None},
        {"titel": None, "onderbouwing": None},
    ],
    "hulpvraag": None,
}


def _json_shape(data):
    return json.dumps(data, ensure_ascii=False, indent=2)


def build_context_block(*, body_region="", session_type="", case_context=None):
    parts = []
    if body_region:
        parts.append(f"Lichaamsregio: {body_region}")
    if session_type:
        parts.append(f"Type consult: {session_type}")
    if isinstance(case_context, dict) and case_context:
        parts.append("Casuscontext:")
        for key in ("display_label", "patient_name", "primary_complaint", "referral_source", "notes"):
            value = str(case_context.get(key, "") or "").strip()
            if value:
                parts.append(f"- {key}: {value}")
    return "\n".join(parts).strip()


def soap_prompt(transcript, *, body_region="", session_type="", case_context=None):
    return f"""Je bent een klinisch documentatie-assistent voor een fysiotherapeut in opleiding in Nederland.

Extra context:
{build_context_block(body_region=body_region, session_type=session_type, case_context=case_context) or "Geen extra context."}

Gegeven het transcript hieronder, vul een SOAP-notitie in.
- Gebruik alleen informatie uit het transcript of de expliciete context.
- Vul onbekende velden met null.
- Verzin geen informatie.
- Retourneer uitsluitend geldige JSON met exact deze structuur:

{_json_shape(SOAP_RESPONSE_SHAPE)}

TRANSCRIPT:
{transcript}
"""


def rps_prompt(transcript, *, body_region="", session_type="", case_context=None):
    return f"""Je bent een klinisch documentatie-assistent voor een fysiotherapeut in opleiding in Nederland.

Extra context:
{build_context_block(body_region=body_region, session_type=session_type, case_context=case_context) or "Geen extra context."}

Gegeven het transcript hieronder, vul het RPS-formulier in.
- Houd het onderscheid tussen 'volgens_patient' en 'volgens_therapeut' scherp aan.
- Vul onbekende velden met null.
- Verzin geen informatie.
- Retourneer uitsluitend geldige JSON met exact deze structuur:

{_json_shape(RPS_RESPONSE_SHAPE)}

TRANSCRIPT:
{transcript}
"""


def reasoning_prompt(transcript, *, body_region="", session_type="", case_context=None):
    return f"""Je bent een klinisch redeneer-assistent voor een fysiotherapeut in opleiding in Nederland.

Extra context:
{build_context_block(body_region=body_region, session_type=session_type, case_context=case_context) or "Geen extra context."}

Vul het vereenvoudigde 7-stappenmodel in op basis van het transcript.
- Blijf dicht bij het transcript.
- Zet ontbrekende tekstvelden op null en ontbrekende lijsten op [].
- Noem bij stap 5 expliciet welk aanvullend onderzoek nog nodig is.
- Gebruik Nederlandse fysiotherapeutische terminologie.
- Retourneer uitsluitend geldige JSON met exact deze structuur:

{_json_shape(REASONING_RESPONSE_SHAPE)}

TRANSCRIPT:
{transcript}
"""


def differential_prompt(transcript, *, body_region="", session_type="", case_context=None):
    return f"""Je bent een fysiotherapeutisch redeneer-assistent.

Extra context:
{build_context_block(body_region=body_region, session_type=session_type, case_context=case_context) or "Geen extra context."}

Formuleer maximaal drie hypothesen voor differentiaaldiagnostiek en benoem de hulpvraag.
- Gebruik alleen informatie die direct uit het transcript en de context volgt.
- Als iets ontbreekt, gebruik null.
- Retourneer uitsluitend geldige JSON met exact deze structuur:

{_json_shape(DIFFERENTIAL_RESPONSE_SHAPE)}

TRANSCRIPT:
{transcript}
"""


def red_flags_prompt(transcript, *, body_region="", session_type="", case_context=None):
    return f"""Analyseer dit transcript op rode vlaggen voor fysiotherapie.

Extra context:
{build_context_block(body_region=body_region, session_type=session_type, case_context=case_context) or "Geen extra context."}

Zoek naar algemene rode vlaggen en regio-specifieke alarmsignalen.
Retourneer uitsluitend geldige JSON als array van objecten:
[
  {{
    "vlag": "korte beschrijving",
    "ernst": "hoog | matig",
    "actie": "aanbevolen vervolgstap"
  }}
]

Gebruik [] als er geen duidelijke rode vlaggen zijn.

TRANSCRIPT:
{transcript}
"""


def knowledge_prompt(question, context_blocks, *, body_region="", context_text=""):
    context_text_block = str(context_text or "").strip()
    extra_context = f"\nStudentcontext:\n{context_text_block}\n" if context_text_block else ""
    return f"""Je bent een klinisch redeneer-assistent voor een fysiotherapeut in opleiding in Nederland.

Beantwoord de vraag uitsluitend met behulp van de aangeleverde kennisbankfragmenten.
- Als de context onvoldoende is, zeg dat duidelijk.
- Gebruik heldere kopjes.
- Verwijs in de tekst naar de relevante bronlabels.
- Benoem rode vlaggen of contra-indicaties duidelijk als die in de context voorkomen.
- Gebruik Nederlandse terminologie.

Lichaamsregio: {body_region or "onbekend"}{extra_context}

KENNISBANKFRAGMENTEN:
{context_blocks}

VRAAG:
{question}
"""
