"""Pure picture-reference rules shared by study pack writers."""

import re


IMAGE_ID = re.compile(r'^[a-f0-9]{64}$')
PENDING_PICTURES = 'picture_cleanup_pending_ids'


def _card_image_ids(cards):
    return {
        aid for card in (cards if isinstance(cards, list) else []) if isinstance(card, dict)
        for aid in (card.get('image_ids') if isinstance(card.get('image_ids'), list) else [])
        if isinstance(aid, str) and IMAGE_ID.fullmatch(aid)
    }
