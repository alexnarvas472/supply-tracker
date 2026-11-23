# Home Supply Tracker — phone app

Installable, offline-capable front end for the Home Supply Tracker Apps Script.

Live at https://alexnarvas472.github.io/supply-tracker/supplies/ (the site root is a menu of apps)

- Open it in Chrome on Android, paste the Apps Script web app URL (`/exec`) and the key from `setupPhoneApi`, then ⋮ → Install app.
- The screens themselves come from the Apps Script project (`Index.html`), so `clasp push` + updating the deployment updates the phone app. These files only need changing for the offline/sync layer.
- No secrets live in this repo; the key is entered on the phone.

## To-Do Checklist (second app)

`todo/` is a separate installable app for the To-Do Checklist script:
https://alexnarvas472.github.io/supply-tracker/todo/

Each app must live in its own sibling folder (never one app's folder inside another's), or Android treats the inner one as part of the outer app and won't offer to install it.
Same setup: paste that script's `/exec` URL and its own key (from its `setupPhoneApi`).
