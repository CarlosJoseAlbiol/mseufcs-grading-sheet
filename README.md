# MSEUF Concert Singers | Audition Rating

A static website (HTML, CSS, JavaScript) backed by Firebase. Host it free on GitHub Pages.

- **Masters of Initiation and Senior Members** sign in, rate trainees on the Student Audition Rating Sheet, leave comments, and reply.
- **Trainees** sign in, see only their own sheets, and can react and reply.

## Rating sheet

| Criteria | Excellent | Very Satisfactory | Satisfactory | Fair | Poor |
|---|---|---|---|---|---|
| Voice (Quality, Tone) | 30 | 24 | 18 | 12 | 6 |
| Musicality (Interpretation, Dynamics) | 30 | 24 | 18 | 12 | 6 |
| Pronunciation (Clarity, Enunciation) | 10 | 8 | 6 | 4 | 2 |
| Timing/Rhythm (Pace, Synchronization with music) | 10 | 8 | 6 | 4 | 2 |
| Stage Presence (Confidence, Expression) | 10 | 8 | 6 | 4 | 2 |
| Mastery of Lyrics (No error or lapses in memory) | 10 | 8 | 6 | 4 | 2 |

Total: 100 points. To change the rubric, edit `CRITERIA` at the top of `js/app.js` and the total check in `firestore.rules`.

## Setup

### 1. Create the Firebase project
1. Go to the [Firebase Console](https://console.firebase.google.com) and add a project.
2. **Build > Authentication > Get started > Sign-in method**: turn on **Email/Password**.
3. **Build > Firestore Database > Create database** (production mode).
4. **Firestore Database > Rules**: paste everything from `firestore.rules` and **Publish**.

### 2. Set the access code for Masters / Senior Members
This keeps trainees from signing up as graders.

1. **Firestore Database > Data > Start collection**
2. Collection ID: `config`, Document ID: `invite`
3. Field: `code`, type `string`, value: any secret phrase (for example `MSEUF-CS-2026`)

Give this code only to Masters of Initiation and Senior Members. Change it in the console any time; it only matters at sign-up.

### 3. Connect the site
1. **Project settings > General > Your apps > Web (`</>`)** and register an app.
2. Copy the `firebaseConfig` values into `js/firebase-config.js`.

### 4. Publish on GitHub Pages
1. Push this folder to a GitHub repository.
2. **Settings > Pages > Build and deployment**: Source `Deploy from a branch`, Branch `main`, folder `/ (root)`.
3. Copy your site address (`https://YOUR-USERNAME.github.io/REPO-NAME/`).
4. In Firebase: **Authentication > Settings > Authorized domains > Add domain**, and add `YOUR-USERNAME.github.io`.

Without step 4, sign-in fails on the live site.

### Run locally
Modules do not load from `file://`. From this folder run `python -m http.server 8000` and open `http://localhost:8000`. `localhost` is already authorized.

## How access works

| Who | Can do |
|---|---|
| Trainee | Read their own rating sheets. React and reply. |
| Master of Initiation / Senior Member | Read all sheets. Create sheets. Edit or delete their own sheets. Reply and react. |

These limits are enforced by `firestore.rules` on the server, not just hidden in the interface. The Firebase config values in `js/firebase-config.js` are meant to be public.

## Files

```
index.html            page shell (sign in + app)
css/style.css         theme (logo colors: oxblood and gold)
js/app.js             app logic
js/firebase-config.js your Firebase keys
firestore.rules       security rules
assets/logo.jpg       MSEUF Concert Singers logo
```
