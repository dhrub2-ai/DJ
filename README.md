# DJ — Live chat, voice/video calls and media sharing

DJ is a responsive, room-based website with:

- Real-time group text chat (Cloud Firestore)
- Image uploads (up to 15 MB) and video uploads (up to 100 MB) (Cloud Storage for Firebase)
- One-to-one microphone and camera calls (WebRTC) between people in the same room
- Shareable, randomly generated, 20-character invitation codes/links
- Anonymous sign-in, so visitors only need to provide a display name
- Phone, tablet and desktop layouts
- Rules files to restrict database and file access to room members

**This is a deployable source-code project, not a hosted website yet.** Live communication needs a Firebase project, the setup below, and HTTPS hosting. The welcome screen will display a setup notice until you fill in `config.js`.

## 1. Create a Firebase project

1. Open <https://console.firebase.google.com/> and select **Add project**. Name it `DJ` or another name you prefer.
2. Under **Project settings > General > Your apps**, add a **Web** app (`</>` icon).
3. Copy the `firebaseConfig` values for that web app into the included **`config.js`** file. Keep the `window.DJ_FIREBASE_CONFIG = { ... };` structure, but replace all placeholders. **Do not paste a Firebase admin/service account private key here.**
4. Go to **Build > Authentication > Sign-in method** and enable **Anonymous**.
5. Go to **Build > Firestore Database > Create database**. Choose a database location. You may use production/locked mode; paste the supplied rules in the next step.
6. Go to **Build > Storage** and create a Cloud Storage bucket. Its actual name must match `storageBucket` in `config.js` (new buckets typically end in `.firebasestorage.app`).

**Important: Cloud Storage requires Firebase's Blaze (pay-as-you-go) plan in 2026**, even though some usage can fall within no-cost quotas. This means enabling billing to support persistent photo/video uploads. Set up budget alerts. Text chat and call signaling use Firestore and may remain within free-tier allowances if usage is modest, but Firebase charges can apply above the free quotas. Voice/video media flows directly between peers and does not travel through Firebase Storage.

## 2. Publish security rules — required

- Open **Firestore Database > Rules**, replace the editor's contents with **`firestore.rules`**, and click **Publish**.
- Open **Storage > Rules**, replace the editor's contents with **`storage.rules`**, and click **Publish**.
- When prompted, allow Firebase Storage rules to access Firestore for the membership checks. Firebase may need a connected service agent/permission for this.

Never set the rules to `allow read, write: if true` in a public project.

## 3. Publish using GitHub Pages

1. Create a GitHub repository named `DJ` and upload the **contents** of the `DJ-Website` folder to the **root** of the repository, including `index.html`, `app.js`, `styles.css`, `config.js`, `firestore.rules`, `storage.rules` and the `assets` directory.
2. Open your GitHub repository > **Settings > Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, set branch to `main` and folder to `/ (root)`, then click **Save**.
4. GitHub Pages will provide a link, usually `https://YOUR_GITHUB_USERNAME.github.io/DJ/`.
5. In Firebase **Authentication > Settings > Authorized domains**, ensure that `YOUR_GITHUB_USERNAME.github.io` is permitted if Authentication reports an unauthorized domain. Use the domain **without** `https://` or `/DJ/`.

Alternative: Firebase Hosting also serves the same static files with HTTPS. Do not upload the ZIP itself as a website; extract it, and upload the actual project files.

## 4. Use DJ

1. Open the published URL in a browser.
2. Enter a display name and click **Create a new room**.
3. Click **Invite**, then share the copied URL with another person.
4. They enter their display name; their invite link populates the room code automatically. Click **Join a room**.
5. Enter and send messages, click the paperclip to share photos/videos, or choose **Voice**/**Video** to call another room member.
6. For calls, both parties must have DJ open in their browsers. Accept browser requests for microphone/camera access. Incoming calls do not generate push notifications when DJ is closed.

## 5. Local test (optional)

Opening `index.html` by double-clicking it is not recommended. Use a local web server:

```bash
cd DJ-Website
python -m http.server 8000
```

Then visit `http://localhost:8000`.

**Test with two different browsers/devices** and preferably with two separate private/incognito profiles, using the same room invite link. If using the same signed-in anonymous browser profile in two tabs, both tabs represent the same user.

## Troubleshooting

| Problem | Solution |
|---|---|
| “One-time Firebase setup needed” | Replace placeholder keys in `config.js` and republish. |
| “Enable Anonymous sign-in” | Firebase Authentication > Sign-in method > Anonymous > Enable. |
| “Missing or insufficient permissions” | Publish both supplied rules and verify the database/bucket are from the same Firebase project. |
| Images/video fail while chat works | Firebase Storage needs a bucket **and Blaze billing**. Check `storageBucket` and `storage.rules`. |
| Microphone/camera cannot be accessed | Use `https://` hosting or `http://localhost` and grant browser permissions. |
| Calls connect on home Wi-Fi but not office/mobile networks | The starter has STUN only. To support restrictive NAT/firewalls reliably, configure a **TURN** service in `ICE_SERVERS` in `app.js`. TURN traffic can incur costs. |
| Site loads but calls don't ring | Both parties must be in the **same room**, on **different authenticated sessions**, with the website open. |
| Chat shows old people | Room membership is kept until a participant chooses **Leave room**. Closing the tab doesn't delete membership. Member list means “joined members,” not verified online users. |

## Important privacy and usage notes

- Invite links are hard to guess but **anyone who obtains an invitation can join the room** and see its retained messages and uploaded media. There is no password, moderator panel, invitation expiration, user blocking, or abuse reporting in this starter.
- Text/media is stored on Firebase and **is not end-to-end encrypted**. WebRTC voice/video channels are encrypted in transit, but connectivity is not guaranteed without TURN.
- File download links generated by Firebase contain bearer tokens. Someone who receives a media download URL could forward it beyond the room; don't share sensitive files.
- This starter retains messages, call signaling metadata, and media indefinitely; a real public launch should add deletion/retention policies, anti-spam controls, app-check/rate limits, moderation/reporting, and consent/privacy notices.
- Firebase anonymous identities depend on local browser storage. Clearing it produces a different identity. Names alone are not verified identity.
- Avoid sharing banking/customer details or other confidential information in this sample app.

## Files

- `index.html`: UI structure
- `styles.css`: desktop/tablet/mobile styling
- `app.js`: Firebase messaging, room membership, media uploads and WebRTC signaling
- `config.js`: **your** Firebase web configuration (placeholders initially)
- `firestore.rules`: Firestore access restrictions
- `storage.rules`: Cloud Storage access restrictions
- `assets/favicon.svg`: DJ icon

Designed for 1-to-1 voice/video **within a group chat room**. Multi-party conferences, true online presence, and push notifications are out of scope of this starter.
