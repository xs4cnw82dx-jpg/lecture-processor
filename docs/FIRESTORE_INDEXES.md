# Firestore Index Deployment

This project now versions composite indexes in:

- `firestore.indexes.json`

Deploy indexes with:

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
firebase deploy --only firestore:indexes
```

If Firebase asks to create a missing index from an error link, add it to `firestore.indexes.json` so CI and environments stay consistent.
