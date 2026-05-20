import os
import sys
from google.cloud import firestore

# Point to the credentials if needed, but since it's running locally with the bot's env:
# We assume it has access to the default credentials or we can import from bot.heartbeat.
try:
    from bot.heartbeat import get_db
    db = get_db()
    if db:
        db.collection('botState').document('hmmEngine').delete()
        db.collection('botState').document('quantEngine').delete()
        print('Successfully wiped hmmEngine and quantEngine from Firestore.')
    else:
        print('Failed to get db connection.')
except Exception as e:
    print(f'Error: {e}')
