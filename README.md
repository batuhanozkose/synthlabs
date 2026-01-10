<div align="center">
<img width="1200" height="auto" alt="GHBanner" src="assets/synthlabs.jpeg" />
</div>

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set your keys in .env & .env.local to your API keys (see the .env.example file for more info)
3. Run the app:
   `npm run dev`

## Firebase Setup

To allow the application to save logs to Firestore, you need to set up the following Security Rules in your Firebase Console (Firestore Database > Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /synth_logs/{document=**} {
      allow read, write: if true;
    }

    match /synth_sessions/{document=**} {
      allow read, write: if true;
    }
  }
}
```
