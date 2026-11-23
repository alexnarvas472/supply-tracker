/*
 * My Apps — runs one of your Apps Script apps inside the installed phone app.
 * Replaces google.script.run so the app talks to Google over the internet,
 * keeps a copy of what it has loaded, and (for apps that support it) saves
 * changes made offline and sends them when you're back online.
 */
if (!window.__pa) (function () {
  const LIST_KEY = "myapps:list";
  const appId = new URLSearchParams(location.search).get("app");

  // ---------- storage ----------
  const raw = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn("storage full?", e); return false; } }
  };
  const apps = () => raw.get(LIST_KEY, []);
  const app = () => apps().find(a => a.id === appId);
  const TYPE = () => (window.MYAPPS_TYPES || {})[(app() || {}).type] || (window.MYAPPS_TYPES || {}).generic || {};
  const NS = "myapps:" + appId + ":";
  const LS = { get: (k, d) => raw.get(NS + k, d), set: (k, v) => raw.set(NS + k, v) };

  // ---------- talking to Google ----------
  class NetError extends Error {}
  async function api(payload, timeoutMs) {
    const a = app();
    if (!a) throw new Error("This app isn't set up in My Apps.");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
    let res;
    try {
      res = await fetch(a.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },   // no CORS preflight
        body: JSON.stringify(Object.assign({ key: a.key }, payload)),
        signal: ctrl.signal, redirect: "follow"
      });
    } catch (e) { throw new NetError("No connection"); }
    finally { clearTimeout(timer); }
    let data;
    try { data = await res.json(); }
    catch (e) { throw new NetError("Unexpected reply from Google (" + res.status + ")"); }
    if (data && data.auth === false) {
      const err = new Error("The key for this app was rejected. Go back to My Apps and edit the app's key.");
      err.auth = true; throw err;
    }
    return data;
  }
  async function callServer(fn, args) {
    const data = await api({ fn, args });
    if (!data.ok) throw new Error(data.error || "Something went wrong.");
    return data.result;
  }

  // ---------- cache ----------
  const ck = (fn, args) => "cache:" + fn + "|" + JSON.stringify(args || []);
  const cache = {
    read: (fn, args) => { const c = LS.get(ck(fn, args), null); return c ? c.result : undefined; },
    write: (fn, args, result) => { LS.set(ck(fn, args), { t: Date.now(), result }); LS.set("lastSync", Date.now()); },
    store: (k, v) => v === undefined ? LS.get("store:" + k, undefined) : LS.set("store:" + k, v)
  };

  // ---------- queue of offline changes ----------
  const queue = () => LS.get("queue", []);
  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const failed = [];
      let q = queue();
      while (q.length) {
        const job = q[0];
        try { await callServer(job.fn, job.args); }
        catch (e) {
          if (e instanceof NetError || e.auth) break;
          failed.push(job.fn + ": " + e.message);
        }
        q = queue().filter(j => j.id !== job.id);
        LS.set("queue", q);
        updateStatus();
      }
      if (failed.length) alert("Some changes made offline couldn't be saved:\n\n" + failed.join("\n"));
    })().finally(() => { flushing = null; updateStatus(); });
    return flushing;
  }

  // ---------- the google.script.run replacement ----------
  const isRead = fn => (TYPE().isRead ? TYPE().isRead(fn) : TYPE().reads ? TYPE().reads.indexOf(fn) !== -1 : /^(get|load|list|fetch|read|find|search|show)/i.test(fn));
  const canQueue = fn => (TYPE().offlineWrites || []).indexOf(fn) !== -1;

  async function call(fn, args) {
    const T = TYPE();
    if (T.prepareArgs) args = T.prepareArgs(fn, args) || args;

    if (isRead(fn)) {
      if (navigator.onLine) {
        try {
          if (queue().length) await flush();
          const result = await callServer(fn, args);
          cache.write(fn, args, result);
          if (T.onResult) try { T.onResult(fn, args, result, cache); } catch (e) { console.warn(e); }
          return result;
        } catch (e) { if (!(e instanceof NetError)) throw e; }
      }
      if (T.offlineRead) { const r = T.offlineRead(fn, args, cache); if (r !== undefined) { markStale(); return r; } }
      const c = cache.read(fn, args);
      if (c !== undefined) { markStale(); return c; }
      throw new Error("You're offline, and this hasn't been opened with internet yet.");
    }

    if (navigator.onLine) {
      try {
        if (queue().length) await flush();
        const result = await callServer(fn, args);
        if (T.applyOffline) try { T.applyOffline(fn, args, cache); } catch (e) { console.warn(e); }
        refreshSoon();
        return result;
      } catch (e) { if (!(e instanceof NetError)) throw e; }
    }
    if (!canQueue(fn)) throw new Error("You're offline. This needs an internet connection.");
    const q = queue();
    q.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2), fn, args, t: Date.now() });
    LS.set("queue", q);
    let result = true;
    if (T.applyOffline) { const r = T.applyOffline(fn, args, cache); if (r !== undefined) result = r; }
    updateStatus();
    if (typeof window.showToast === "function") try { window.showToast("Saved offline — will sync later"); } catch (e) {}
    return result;
  }

  function runner(onOk, onFail, userObj) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === "withSuccessHandler") return f => runner(f, onFail, userObj);
        if (prop === "withFailureHandler") return f => runner(onOk, f, userObj);
        if (prop === "withUserObject") return o => runner(onOk, onFail, o);
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args) => {
          const clean = JSON.parse(JSON.stringify(args));
          call(prop, clean).then(r => onOk && onOk(r, userObj),
            e => { if (onFail) onFail(e, userObj); else alert(e.message); });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = runner();
  window.google.script.host = { close() {}, setHeight() {}, setWidth() {}, editor: { focus() {} } };

  // ---------- keep a fresh copy for offline ----------
  let warming = false;
  async function warm() {
    const T = TYPE();
    const calls = typeof T.warm === "function" ? T.warm() : (T.warm || []).map(fn => ({ fn, args: [] }));
    if (warming || !navigator.onLine || !app() || !calls.length) return;
    warming = true; updateStatus();
    try {
      if (queue().length) await flush();
      const data = await api({ batch: calls }, 180000);
      (data.results || []).forEach((r, i) => {
        if (!r.ok) return;
        cache.write(calls[i].fn, calls[i].args, r.result);
        if (T.onResult) try { T.onResult(calls[i].fn, calls[i].args, r.result, cache); } catch (e) { console.warn(e); }
      });
      stale = false;
    } catch (e) { console.warn("background refresh failed", e); }
    finally { warming = false; updateStatus(); }
  }
  let refreshTimer;
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(warm, 4000); }

  // ---------- little status bar + buttons ----------
  let stale = false;
  function markStale() { stale = true; updateStatus(); }
  function fmtTime(t) {
    const d = new Date(t), today = d.toDateString() === new Date().toDateString();
    return (today ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " ") + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function updateStatus() {
    const el = document.getElementById("pa-status");
    if (!el) return;
    const n = queue().length, last = LS.get("lastSync", 0);
    let text = "", color = "";
    if (!navigator.onLine) { text = "Offline" + (last ? " · data from " + fmtTime(last) : "") + (n ? " · " + n + " waiting" : ""); color = "#8a5a00"; }
    else if (flushing) { text = "Syncing " + n + " change" + (n === 1 ? "" : "s") + "…"; color = "#1f5fa8"; }
    else if (n) { text = n + " change" + (n === 1 ? "" : "s") + " waiting · tap to sync"; color = "#8a5a00"; }
    else if (warming) { text = "Updating offline copy…"; color = "#555"; }
    el.textContent = text; el.style.background = color || "transparent"; el.style.display = text ? "block" : "none";
  }
  function mountStatus() {
    if (document.getElementById("pa-status")) return;
    attachListeners();   // once per page; the page swap erased the earlier ones
    const st = document.createElement("div");
    st.id = "pa-status";
    st.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:99999;color:#fff;" +
      "font:600 13px system-ui,sans-serif;padding:7px 14px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25);" +
      "display:none;max-width:70vw;text-align:center";
    st.onclick = () => { if (navigator.onLine) flush().then(warm); };
    document.body.appendChild(st);
    const home = document.createElement("a");
    home.href = "./"; home.textContent = "⌂"; home.title = "Back to My Apps";
    home.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:99999;width:40px;height:40px;border-radius:50%;" +
      "background:#fff;color:#222;border:1px solid #ccc;font:22px/38px system-ui;text-align:center;text-decoration:none;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.2);opacity:.85";
    document.body.appendChild(home);
    updateStatus();
    warm();
  }
  // The page swap (document.open) erases listeners, so (re)attach them on every page.
  function attachListeners() {
    window.addEventListener("online", () => { updateStatus(); flush().then(warm); });
    window.addEventListener("offline", updateStatus);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && navigator.onLine) flush(); });
  }
  attachListeners();

  // ---------- opening an app ----------
  async function openApp() {
    if (document.readyState === "loading") await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
    await new Promise(r => setTimeout(r, 0));
    if (navigator.storage && navigator.storage.persist) try { navigator.storage.persist(); } catch (e) {}
    const msg = document.getElementById("pa-msg");
    let html = null;
    if (navigator.onLine) {
      try {
        if (queue().length) await flush();
        const data = await api({ fn: "__ui" }, LS.get("ui", null) ? 12000 : 60000);
        if (data.ok && data.result) { html = data.result; LS.set("ui", html); }
        else if (!data.ok && msg) msg.textContent = "Couldn't open: " + data.error;
      } catch (e) { if (e.auth) { if (msg) msg.textContent = e.message; return; } }
    }
    html = html || LS.get("ui", null);
    if (!html) { if (msg) msg.textContent = "Connect to the internet once so this app can download."; return; }
    const a = app();
    LS.set("opened", Date.now());
    const head = (/name=["']?viewport/i.test(html) ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">') +
      '<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icon-192.png">' +
      '<script src="app-types.js"><\/script><script src="shim.js"><\/script>';
    const tail = '<script>window.__pa && window.__pa.mountStatus();<\/script>';
    html = html.replace(/<base[^>]*>/i, "");
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + head) : head + html;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tail + "</body>") : html + tail;
    document.open(); document.write(html); document.close();
    if (a && !document.title) document.title = a.name;
  }

  window.__pa = { openApp, mountStatus, flush, warm, api, queueLength: () => queue().length };
})();
