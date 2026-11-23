r"""
AppsScript PC sync helper.

Keeps C:\Users\alexn\AppsScript in step with every Apps Script project in
your Google account:
  * downloads projects you don't have yet into "<name> - <id hash>" folders
  * updates projects that changed on Google (after running your backup script)
  * never overwrites a project you've edited on this PC but not deployed yet

Runs when you press "Back up to PC" in My App Register (it checks every
minute while the PC is on), or right away with sync-now.cmd.

Uses your existing clasp login (no extra sign-in).
"""

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

PROJECT_ROOT = Path.home() / "AppsScript"
BACKUP_ROOT = Path.home() / "app script backups"
BACKUP_SCRIPT = Path.home() / "Downloads" / "backup_apps_script.py"
HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "state.json"
REPORT_FILE = HERE / "sync-report.txt"
LOG_FILE = HERE / "helper.log"
CONFLICT_DIR = HERE / "conflicts"

REQUEST_NAME = "AppsScript PC Sync Request"   # made by My App Register
STATUS_PREFIX = "AppsScript PC Sync Status"   # made by this helper, one per PC
PC_NAME = socket.gethostname()
STATUS_NAME = f"{STATUS_PREFIX} - {PC_NAME}"
CHECK_EVERY_SECONDS = 60
LOCK_PORT = 47613

DRIVE = "https://www.googleapis.com/drive/v3"
SCRIPT = "https://script.googleapis.com/v1"
SCRIPT_MIME = "application/vnd.google-apps.script"


# ---------------------------------------------------------------- logging
def log(msg):
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------- Google login (clasp's)
class Auth:
    def __init__(self):
        self.token = None
        self.expires = 0
        self.refresh_token, self.client_id, self.client_secret = self._read_clasprc()

    @staticmethod
    def _read_clasprc():
        path = Path.home() / ".clasprc.json"
        if not path.is_file():
            raise RuntimeError("clasp isn't logged in on this PC (no .clasprc.json). Run: clasp login")
        data = json.loads(path.read_text(encoding="utf-8"))
        if "tokens" in data:  # clasp 3
            t = data["tokens"].get("default") or next(iter(data["tokens"].values()))
            return t["refresh_token"], t["client_id"], t["client_secret"]
        t = data.get("token", {})  # clasp 2
        s = data.get("oauth2ClientSettings", {})
        return t["refresh_token"], s["clientId"], s["clientSecret"]

    def get(self):
        if self.token and time.time() < self.expires - 60:
            return self.token
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": self.refresh_token,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }).encode()
        with urllib.request.urlopen("https://oauth2.googleapis.com/token", body, timeout=30) as r:
            data = json.loads(r.read())
        self.token = data["access_token"]
        self.expires = time.time() + int(data.get("expires_in", 3600))
        return self.token


class ApiError(Exception):
    def __init__(self, status, text):
        super().__init__(f"HTTP {status}: {text[:300]}")
        self.status = status


def api(auth, method, url, body=None, tries=5):
    """JSON request with retries for rate limits / network hiccups."""
    delay = 3
    for attempt in range(tries):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + auth.get())
        if data is not None:
            req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            if e.code == 401 and attempt < tries - 1:
                auth.token = None
                continue
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(delay if e.code != 429 else max(delay, 30))
                delay *= 2
                continue
            raise ApiError(e.code, text)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    raise RuntimeError("unreachable")


def q(s):
    return urllib.parse.quote(s, safe="")


# ---------------------------------------------------------------- Google side
def list_standalone(auth):
    """Every Apps Script file in Drive, following every page."""
    out, token = [], None
    while True:
        query = f"mimeType='{SCRIPT_MIME}' and trashed=false"
        url = (f"{DRIVE}/files?q={q(query)}"
               f"&fields={q('nextPageToken,files(id,name,modifiedTime)')}&pageSize=1000"
               f"&supportsAllDrives=true&includeItemsFromAllDrives=true")
        if token:
            url += "&pageToken=" + q(token)
        data = api(auth, "GET", url)
        out.extend(data.get("files", []))
        token = data.get("nextPageToken")
        if not token:
            return out


def find_file(auth, name):
    query = f"name='{name}' and trashed=false"
    url = (f"{DRIVE}/files?q={q(query)}"
           f"&fields={q('files(id,description,modifiedTime)')}&orderBy={q('modifiedTime desc')}&pageSize=5")
    files = api(auth, "GET", url).get("files", [])
    return files[0] if files else None


def get_content(auth, script_id):
    return api(auth, "GET", f"{SCRIPT}/projects/{q(script_id)}/content").get("files", [])


def get_update_time(auth, script_id):
    return api(auth, "GET", f"{SCRIPT}/projects/{q(script_id)}").get("updateTime", "")


def publish_status(auth, state, status):
    """Tell My App Register how the last backup went (best effort)."""
    desc = json.dumps(status, separators=(",", ":"))[:30000]
    try:
        fid = state.get("_status_file_id")
        if fid:
            try:
                api(auth, "PATCH", f"{DRIVE}/files/{fid}", {"name": STATUS_NAME, "description": desc}, tries=2)
                return
            except ApiError as e:
                if e.status != 404:
                    raise
        made = api(auth, "POST", f"{DRIVE}/files",
                   {"name": STATUS_NAME, "mimeType": "text/plain", "description": desc}, tries=2)
        state["_status_file_id"] = made["id"]
    except Exception as e:  # the backup itself still counts
        log(f"Couldn't update the status shown in My App Register: {e}")


# ---------------------------------------------------------------- local side
INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def folder_name(title, script_id):
    name = INVALID.sub("_", (title or "Untitled project")).strip().rstrip(". ") or "Untitled project"
    return f"{name[:120]} - {hashlib.sha256(script_id.encode()).hexdigest()[:12]}"


def local_projects():
    found = {}
    for d in sorted(PROJECT_ROOT.iterdir()):
        cfg = d / ".clasp.json"
        if d.is_dir() and cfg.is_file():
            try:
                data = json.loads(cfg.read_text(encoding="utf-8"))
                if data.get("scriptId"):
                    found[data["scriptId"]] = (d, data)
            except (OSError, ValueError):
                log(f"Unreadable .clasp.json in {d.name}")
    return found


def glob_to_regex(pattern):
    pattern = pattern.strip().lstrip("/")
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"; i += 3
        elif pattern.startswith("**", i):
            out += ".*"; i += 2
        elif pattern[i] == "*":
            out += "[^/]*"; i += 1
        elif pattern[i] == "?":
            out += "[^/]"; i += 1
        else:
            out += re.escape(pattern[i]); i += 1
    return re.compile("^" + out + "$")


def ignore_rules(project_dir):
    pats = ["**/node_modules/**", "**/.*"]
    f = project_dir / ".claspignore"
    if f.is_file():
        pats = [p for p in f.read_text(encoding="utf-8").splitlines() if p.strip() and not p.startswith("#")]
    return [glob_to_regex(p) for p in pats]


def code_root(project_dir, cfg):
    return project_dir / (cfg.get("rootDir") or "")


def local_files(project_dir, cfg):
    """Apps Script files clasp would push: {relative/posix/path: text}."""
    root = code_root(project_dir, cfg)
    rules = ignore_rules(project_dir)
    exts = set(cfg.get("scriptExtensions") or [".js", ".gs"]) | set(cfg.get("htmlExtensions") or [".html"])
    out = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if rel == ".clasp.json" or any(r.match(rel) for r in rules):
            continue
        if p.suffix in exts or rel == "appsscript.json":
            try:
                out[rel] = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                pass
    return out


def remote_files(remote, project_dir, cfg, existing):
    """Google's files mapped to the local paths clasp would use."""
    script_ext = (cfg.get("scriptExtensions") or [".js"])[0]
    html_ext = (cfg.get("htmlExtensions") or [".html"])[0]
    out = {}
    for f in remote:
        name, kind = f["name"], f["type"]
        if kind == "JSON":
            rel = name + ".json"
        elif kind == "HTML":
            rel = name + html_ext
        else:
            rel = name + ".gs" if (name + ".gs") in existing else name + script_ext
        out[rel] = f.get("source", "")
    return out


def norm(text):
    return text.replace("\r\n", "\n")


def digest(files):
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode()); h.update(b"\0"); h.update(norm(files[rel]).encode()); h.update(b"\0")
    return h.hexdigest()


def write_files(project_dir, cfg, files):
    root = code_root(project_dir, cfg)
    for rel, text in files.items():
        target = root / PurePosixPath(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="") as f:
            f.write(text)


def newest_mtime(project_dir, cfg, rels):
    """Newest edit time of the Apps Script code files only."""
    root = code_root(project_dir, cfg)
    times = [(root / PurePosixPath(r)).stat().st_mtime for r in rels]
    return max(times) if times else 0


def builtin_backup(project, backup_root):
    """Same as backup_apps_script.py: copy the folder into a dated backup folder."""
    import shutil, tempfile
    project, backup_root = Path(project).resolve(), Path(backup_root).resolve()
    files = [p for p in project.rglob("*") if p.is_file() and not p.is_symlink()]
    last = max((p.stat().st_mtime for p in files), default=time.time())
    stamp = dt.datetime.fromtimestamp(last).strftime("%Y-%m-%d_%H-%M-%S")
    dest_root = backup_root / project.name
    dest_root.mkdir(parents=True, exist_ok=True)
    dest, k = dest_root / stamp, 2
    while dest.exists():
        dest = dest_root / f"{stamp} ({k})"; k += 1
    with tempfile.TemporaryDirectory(prefix=".backup-", dir=dest_root) as tmp:
        staged = Path(tmp) / "project"
        shutil.copytree(project, staged, symlinks=True, copy_function=shutil.copy2)
        staged.rename(dest)
    return dest


def load_backup():
    if not BACKUP_SCRIPT.is_file():
        return builtin_backup
    spec = importlib.util.spec_from_file_location("backup_apps_script", BACKUP_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.backup_project


# ---------------------------------------------------------------- the sync
def sync(auth, state, bound):
    started = dt.datetime.now()
    backup = load_backup()
    result = {k: [] for k in ("downloaded", "updated", "unchanged", "not_deployed", "conflict", "failed", "notes")}

    log("Asking Google for every Apps Script project…")
    standalone = list_standalone(auth)
    wanted = {f["id"]: {"name": f["name"], "modified": f.get("modifiedTime", ""), "kind": "standalone"} for f in standalone}
    for sid, name in bound:
        wanted.setdefault(sid, {"name": name, "modified": "", "kind": "attached"})
    log(f"Google lists {len(standalone)} standalone + {len(bound)} attached = {len(wanted)} projects.")

    local = local_projects()
    log(f"Found {len(local)} project folders on this PC.")

    for n, (sid, info) in enumerate(sorted(wanted.items(), key=lambda kv: kv[1]["name"].lower()), 1):
        label = info["name"]
        try:
            prev = state.get(sid)
            if sid in local:
                project_dir, cfg = local[sid]
                label = project_dir.name
                local_now = local_files(project_dir, cfg)
                local_h = digest(local_now)
                # Fast path: nothing changed on either side since last time.
                if prev and info["modified"] and prev.get("modified") == info["modified"] and prev.get("local") == local_h:
                    result["unchanged"].append(label)
                    continue
                remote = get_content(auth, sid)
                remote_now = remote_files(remote, project_dir, cfg, local_now)
                remote_h = digest(remote_now)
                action = None

                if remote_h == local_h:
                    result["unchanged"].append(label)
                elif prev and prev.get("local") == local_h:
                    action = "update"                       # only Google changed
                elif prev and prev.get("remote") == remote_h:
                    result["not_deployed"].append(label)    # only this PC changed
                    state[sid] = {**prev, "modified": info["modified"]}
                    if prev.get("conflict_saved") != remote_h:  # Google's copy, once, to compare
                        save_conflict(project_dir, cfg, remote_now)
                        state[sid]["conflict_saved"] = remote_h
                    continue
                elif prev:
                    if prev.get("conflict_saved") != remote_h:
                        save_conflict(project_dir, cfg, remote_now)
                        state[sid] = {**prev, "conflict_saved": remote_h}
                    result["conflict"].append(label)
                    continue
                else:
                    # First time we've seen this folder: whichever side is newer wins.
                    upd = get_update_time(auth, sid)
                    upd_ts = dt.datetime.fromisoformat(upd.replace("Z", "+00:00")).timestamp() if upd else 0
                    if newest_mtime(project_dir, cfg, local_now) > upd_ts:
                        save_conflict(project_dir, cfg, remote_now)  # Google's copy, to compare
                        result["not_deployed"].append(label)
                        not_deployed_saved = remote_h
                        # Remember Google's version, but NOT this PC's as a synced copy,
                        # so these edits stay protected until they're deployed.
                        state[sid] = {"remote": remote_h, "local": None, "modified": info["modified"],
                                      "conflict_saved": not_deployed_saved}
                        continue
                    action = "update"

                if remote_h != local_h and action == "update":
                    if not backup:
                        result["failed"].append(f"{label}: not updated because the backup script wasn't found at {BACKUP_SCRIPT}")
                        continue
                    backup(project_dir, BACKUP_ROOT)
                    write_files(project_dir, cfg, remote_now)
                    gone = sorted(set(local_now) - set(remote_now))
                    if gone:
                        result["notes"].append(f"{label}: deleted on Google, kept on PC: {', '.join(gone)}")
                    result["updated"].append(label)
                state[sid] = {"remote": remote_h, "local": digest(local_files(project_dir, cfg)), "modified": info["modified"]}
            else:
                remote = get_content(auth, sid)
                project_dir = PROJECT_ROOT / folder_name(info["name"], sid)
                k = 2
                while project_dir.exists():
                    project_dir = PROJECT_ROOT / f"{folder_name(info['name'], sid)} ({k})"; k += 1
                cfg = {"scriptId": sid, "rootDir": "", "scriptExtensions": [".js", ".gs"],
                       "htmlExtensions": [".html"], "jsonExtensions": [".json"],
                       "filePushOrder": [], "skipSubdirectories": False}
                files = remote_files(remote, project_dir, cfg, {})
                project_dir.mkdir(parents=True)
                (project_dir / ".clasp.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
                write_files(project_dir, cfg, files)
                h = digest(files)
                state[sid] = {"remote": h, "local": h, "modified": info["modified"]}
                ensure_deploy_button(project_dir)
                result["downloaded"].append(project_dir.name)
                label = project_dir.name
        except ApiError as e:
            reason = {403: "no permission (or the Apps Script API is turned off)", 404: "not found on Google (deleted?)"}.get(e.status, str(e))
            result["failed"].append(f"{label}: {reason}")
        except Exception as e:
            result["failed"].append(f"{label}: {e}")
            log(traceback.format_exc())
        if n % 25 == 0:
            log(f"  …{n} of {len(wanted)} checked")
        time.sleep(0.15)

    # Folders on the PC that Google no longer lists.
    for d, _ in local.values():
        ensure_deploy_button(d)
    for sid, (d, _) in local.items():
        if sid not in wanted:
            result["notes"].append(f"{d.name}: on this PC but not found in your Google account (deleted, or an attached script not in the register)")

    result["total"] = len(wanted)
    result["seconds"] = round((dt.datetime.now() - started).total_seconds())
    return result


DEPLOY_CMD = "@echo off\r\ncd /d \"%~dp0\"\r\nnode deploy.cjs\r\necho.\r\npause\r\n"
DEPLOY_CJS = ("// Uses the shared deploy tool in ..\\_pc-sync (backup, safety check, push, update deployment).\n"
              "require(require('path').join(__dirname, '..', '_pc-sync', 'deploy.cjs'))(__dirname);\n")


def ensure_deploy_button(project_dir):
    try:
        if not (project_dir / "deploy.cmd").exists():
            (project_dir / "deploy.cmd").write_bytes(DEPLOY_CMD.encode())
        cjs = project_dir / "deploy.cjs"
        if not cjs.exists() or "_pc-sync" not in cjs.read_text(encoding="utf-8", errors="ignore"):
            cjs.write_text(DEPLOY_CJS, encoding="utf-8")
    except OSError:
        pass


def save_conflict(project_dir, cfg, files):
    dest = CONFLICT_DIR / project_dir.name / dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    for rel, text in files.items():
        p = dest / PurePosixPath(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


def write_report(result, request_id):
    lines = [
        f"AppsScript PC sync — {dt.datetime.now():%Y-%m-%d %H:%M}",
        f"Projects in your Google account: {result['total']}   (took {result['seconds']}s)",
        "",
        f"Downloaded (new):        {len(result['downloaded'])}",
        f"Updated from Google:     {len(result['updated'])}   (backed up first)",
        f"Already up to date:      {len(result['unchanged'])}",
        f"Changed on PC, not deployed yet (left alone): {len(result['not_deployed'])}",
        f"Changed in both places (left alone):          {len(result['conflict'])}",
        f"FAILED:                  {len(result['failed'])}",
        "",
    ]
    def section(title, items):
        if items:
            lines.append(title); lines.extend("  - " + i for i in items); lines.append("")
    section("Downloaded:", result["downloaded"])
    section("Updated:", result["updated"])
    section(f"Changed on this PC but not deployed yet (Google's version saved in {CONFLICT_DIR} to compare) — run deploy.cmd there to send your version, or delete your changes, then sync again:", result["not_deployed"])
    section(f"Changed on BOTH Google and this PC — Google's version was saved to {CONFLICT_DIR} so you can compare:", result["conflict"])
    section("FAILED (will be retried next sync):", result["failed"])
    section("Notes:", result["notes"])
    lines.append("Reminder: scripts attached to a Sheet/Doc are only included once they're added to My App Register (+ Attached project).")
    REPORT_FILE.write_text("\n".join(lines), encoding="utf-8")
    return "\n".join(lines)


def notify(title, text):
    if os.name != "nt":
        return
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$n=New-Object System.Windows.Forms.NotifyIcon;"
        "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;"
        f"$n.ShowBalloonTip(10000,'{title.replace(chr(39), '')}','{text.replace(chr(39), '')}',"
        "[System.Windows.Forms.ToolTipIcon]::Info);Start-Sleep -Seconds 11;$n.Dispose()"
    )
    try:
        subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        pass


# ---------------------------------------------------------------- running
def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    tmp.replace(STATE_FILE)


def parse_request(req):
    try:
        data = json.loads(req.get("description") or "{}")
    except ValueError:
        data = {}
    bound = [(b[0], b[1] if len(b) > 1 else "") for b in data.get("bound", []) if b and b[0]]
    return data.get("requestId") or req.get("modifiedTime"), bound


def run_once(auth, state, request_id=None, bound=None):
    if bound is None:
        req = find_file(auth, REQUEST_NAME)
        request_id, bound = parse_request(req) if req else (None, [])
        if not req:
            log("No request from My App Register yet, so only standalone projects (plus attached ones you already have) are included.")
            bound = list(state.get("_bound", []))
    state["_bound"] = bound
    publish_status(auth, state, {"requestId": request_id, "state": "running", "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    result = sync(auth, state, bound)
    state["_last_request"] = request_id
    save_state(state)
    text = write_report(result, request_id)
    log("\n" + text)
    summary = (f"{len(result['downloaded'])} new, {len(result['updated'])} updated, "
               f"{len(result['unchanged'])} unchanged"
               + (f", {len(result['failed'])} FAILED" if result["failed"] else "")
               + (f", {len(result['not_deployed']) + len(result['conflict'])} left alone" if result["not_deployed"] or result["conflict"] else ""))
    publish_status(auth, state, {
        "requestId": request_id, "state": "done", "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": summary, "total": result["total"],
        "failed": result["failed"][:50], "leftAlone": (result["not_deployed"] + result["conflict"])[:50],
        "downloaded": result["downloaded"][:50],
    })
    save_state(state)
    notify("Apps Script backup finished", summary)
    return result


def watch(auth):
    log("Helper started. Waiting for 'Back up to PC' from My App Register…")
    while True:
        try:
            state = load_state()
            req = find_file(auth, REQUEST_NAME)
            if req:
                request_id, bound = parse_request(req)
                if request_id and request_id != state.get("_last_request"):
                    log(f"Backup requested ({request_id}).")
                    run_once(auth, state, request_id, bound)
        except Exception as e:
            log(f"Check failed (will retry): {e}")
        time.sleep(CHECK_EVERY_SECONDS)


def project_at(folder):
    d = Path(folder).resolve()
    cfg = json.loads((d / ".clasp.json").read_text(encoding="utf-8"))
    return d, cfg, cfg["scriptId"]


def before_deploy(auth, folder):
    """Back up, then make sure Google hasn't changed since this PC last synced.
    Exit 0 = OK to push, 2 = Google is newer (stop), 1 = error."""
    d, cfg, sid = project_at(folder)
    backup = load_backup()
    print(f"Backup saved to: {backup(d, BACKUP_ROOT)}")
    local_now = local_files(d, cfg)
    local_h = digest(local_now)
    remote_now = remote_files(get_content(auth, sid), d, cfg, local_now)
    remote_h = digest(remote_now)
    prev = load_state().get(sid)
    if remote_h == local_h:
        print("Google already has exactly this code.")
        return 0
    if prev and prev.get("remote") == remote_h:
        print("Google hasn't changed since this PC last synced. Safe to deploy.")
        return 0
    # Never synced on this PC and Google's copy is different: we can't tell whose
    # changes are newer (file dates aren't reliable), so always stop and ask.
    save_conflict(d, cfg, remote_now)
    changed = sorted(k for k in set(remote_now) | set(local_now) if norm(remote_now.get(k, "")) != norm(local_now.get(k, "")))
    if not prev:
        print("\nSTOP: Google's copy of this project is DIFFERENT from this PC's, and this PC has never synced it,")
        print("so there's no way to tell which changes are newer (it may have been edited in the online editor).")
    else:
        print("\nSTOP: Google has a NEWER version of this project (changed on another PC or in the online editor).")
    print("Deploying now would overwrite it. Files that differ: " + ", ".join(changed))
    print(f"Google's version was saved to: {CONFLICT_DIR / d.name}")
    print("Run sync-now.cmd (or press Back up to PC) to get it, then make your changes again.")
    return 2


def download_versions(auth, folder):
    """Save every stored version of a project (plus Google's current copy) for recovery."""
    d, cfg, sid = project_at(folder)
    out = HERE / "versions" / d.name
    versions, token = [], None
    while True:
        url = f"{SCRIPT}/projects/{q(sid)}/versions?pageSize=50" + (f"&pageToken={q(token)}" if token else "")
        data = api(auth, "GET", url)
        versions += data.get("versions", [])
        token = data.get("nextPageToken")
        if not token:
            break
    targets = [("current-on-Google", None)] + [
        (f"v{v['versionNumber']}  {v.get('createTime', '')[:16].replace(':', '-')}  {v.get('description', '')[:40]}".strip(), v["versionNumber"])
        for v in sorted(versions, key=lambda v: v["versionNumber"])]
    print(f"{len(versions)} saved version(s) found for {d.name}.")
    for name, num in targets:
        url = f"{SCRIPT}/projects/{q(sid)}/content" + (f"?versionNumber={num}" if num else "")
        files = remote_files(api(auth, "GET", url).get("files", []), d, cfg, {})
        dest = out / INVALID.sub("_", name).strip()
        for rel, text in files.items():
            p = dest / PurePosixPath(rel)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        summaries = [m.strip() for f, t in files.items() if f.endswith(".html")
                     for m in re.findall(r"<summary[^>]*>(.*?)</summary>", t, re.S)]
        print(f"  {name}:  dropdowns = " + (", ".join(re.sub(r"<[^>]+>", "", x) for x in summaries) or "(none)"))
    print(f"\nSaved to: {out}")


def mark_deployed(folder):
    d, cfg, sid = project_at(folder)
    state = load_state()
    h = digest(local_files(d, cfg))
    state[sid] = {"remote": h, "local": h, "modified": ""}
    save_state(state)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--watch", action="store_true", help="keep running and wait for requests")
    ap.add_argument("--before-deploy", metavar="FOLDER", help="back up + check Google before deploying")
    ap.add_argument("--mark-deployed", metavar="FOLDER", help="record that FOLDER was just deployed")
    ap.add_argument("--versions", metavar="FOLDER", help="download every saved version of FOLDER's project")
    args = ap.parse_args()
    HERE.mkdir(parents=True, exist_ok=True)
    if args.mark_deployed:
        mark_deployed(args.mark_deployed)
        return 0
    if args.watch:
        lock = socket.socket()
        try:
            lock.bind(("127.0.0.1", LOCK_PORT))
        except OSError:
            log("The helper is already running.")
            return 0
    try:
        auth = Auth()
        auth.get()
    except Exception as e:
        log(f"Can't sign in to Google with your clasp login: {e}")
        notify("Apps Script backup", "Can't sign in. Run 'clasp login' and try again.")
        return 1
    if args.versions:
        download_versions(auth, args.versions)
        return 0
    if args.before_deploy:
        try:
            return before_deploy(auth, args.before_deploy)
        except Exception as e:
            print(f"Pre-deploy check failed: {e}")
            return 1
    if args.watch:
        watch(auth)
        return 0
    result = run_once(auth, load_state())
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
