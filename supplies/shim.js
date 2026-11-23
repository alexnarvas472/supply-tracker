/*
 * Home Supply Tracker — phone app glue.
 * Replaces google.script.run so the normal app screens talk to Apps Script
 * over the internet, keep a copy of everything on the phone, and queue
 * changes while offline.
 */
if (!window.__pa) (function () {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn("storage full?", e); } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  const CFG_KEY = "pa_config";       // {url, key}
  const UI_KEY = "pa_ui_html";
  const CACHE_PREFIX = "pa_cache:";  // + fn|args -> {t, result}
  const QUEUE_KEY = "pa_queue";      // [{id, fn, args, t}]
  const SYNC_KEY = "pa_last_sync";

  const isRead = fn => /^get/.test(fn) || fn === "recalculateUsagePlanner";

  function config() { return LS.get(CFG_KEY, null); }

  class NetError extends Error {}

  async function api(payload, timeoutMs) {
    const cfg = config();
    if (!cfg) throw new Error("Phone app is not set up yet.");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 45000);
    let res;
    try {
      res = await fetch(cfg.url, {
        method: "POST",
        // text/plain avoids a CORS preflight, which Apps Script can't answer
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ key: cfg.key }, payload)),
        signal: ctrl.signal,
        redirect: "follow"
      });
    } catch (e) {
      throw new NetError("No connection");
    } finally {
      clearTimeout(timer);
    }
    let data;
    try { data = await res.json(); }
    catch (e) { throw new NetError("Unexpected reply from Google (" + res.status + ")"); }
    if (data && data.auth === false) {
      const err = new Error("The phone app key was rejected. Open Settings (⚙) and paste the current key.");
      err.auth = true;
      throw err;
    }
    return data;
  }

  async function callServer(fn, args) {
    const data = await api({ fn, args });
    if (!data.ok) throw new Error(data.error || "Something went wrong.");
    return data.result;
  }

  // ---------- cache ----------
  const cacheKey = (fn, args) => CACHE_PREFIX + fn + "|" + JSON.stringify(args || []);
  function readCache(fn, args) { return LS.get(cacheKey(fn, args), null); }
  function writeCache(fn, args, result) {
    LS.set(cacheKey(fn, args), { t: Date.now(), result });
    LS.set(SYNC_KEY, Date.now());
  }

  // ---------- queue ----------
  const queue = () => LS.get(QUEUE_KEY, []);
  function enqueue(fn, args) {
    const q = queue();
    q.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2), fn, args, t: Date.now() });
    LS.set(QUEUE_KEY, q);
    applyOptimistic(fn, args);
    updateStatus();
  }

  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const failed = [];
      let q = queue();
      while (q.length) {
        const job = q[0];
        try {
          await callServer(job.fn, job.args);
        } catch (e) {
          if (e instanceof NetError || e.auth) break; // try later
          failed.push(describe(job) + " — " + e.message);
        }
        q = queue().filter(j => j.id !== job.id);
        LS.set(QUEUE_KEY, q);
        updateStatus();
      }
      if (failed.length) {
        alert("Some changes made offline couldn't be saved:\n\n" + failed.join("\n"));
      }
    })().finally(() => { flushing = null; updateStatus(); });
    return flushing;
  }

  function describe(job) {
    const a = job.args || [];
    const item = typeof a[0] === "string" ? a[0] : "";
    return job.fn.replace(/([A-Z])/g, " $1").toLowerCase() + (item ? ": " + item : "");
  }

  // ---------- make offline changes show up right away ----------
  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  function patchCache(fn, mutate) {
    const k = cacheKey(fn, []);
    const c = LS.get(k, null);
    if (!c || !Array.isArray(c.result)) return;
    mutate(c.result);
    LS.set(k, c);
  }
  function addToShopping(item, qty, group, urgency) {
    patchCache("getShoppingList", list => {
      if (list.some(x => norm(x.item) === norm(item))) return;
      list.push({ item, reason: "manual need (added offline)", currentQty: "",
        suggested: qty || 1, estimatedUnitCost: "", estimatedCost: "",
        group: group || "", category: "", urgency: urgency || "normal" });
    });
  }
  function setInvQty(item, f, extra) {
    patchCache("getInventory", list => {
      let row = list.find(x => norm(x.item) === norm(item));
      if (!row) {
        row = Object.assign({ item, group: "", qty: 0, location: "", expiration: "",
          storage: "", lowLevel: 0, preferredLevel: 0 }, extra || {});
        list.push(row);
      }
      row.qty = Math.max(0, f(Number(row.qty) || 0));
    });
  }
  function applyOptimistic(fn, a) {
    try {
      if (fn === "addNeed") addToShopping(a[0], a[1], a[2], a[3]);
      if (fn === "addNewItem") {
        const o = a[1] || {};
        if (o.addToList) addToShopping(a[0], o.listQty, o.neededFor, o.urgency);
        setInvQty(a[0], q => (o.qty === "" || o.qty == null ? q : Number(o.qty)), { group: o.group || "", category: o.category || "" });
      }
      if (fn === "addPurchase") {
        patchCache("getShoppingList", list => {
          const i = list.findIndex(x => norm(x.item) === norm(a[0]));
          if (i !== -1) list.splice(i, 1);
        });
        setInvQty(a[0], q => q + (Number(a[1]) || 1));
      }
      if (fn === "useItem") setInvQty(a[0], q => q - (Number(a[1]) || 1));
      if (fn === "setItemCategory") {
        patchCache("getInventory", list => {
          const row = list.find(x => norm(x.item) === norm(a[0]));
          if (!row) return;
          row.category = a[1] || "";
          if (a[2] !== null && a[2] !== undefined) row.group = a[2];
        });
      }
      if (fn === "setInventoryCount" || fn === "updateInventoryItem") setInvQty(a[0], () => Number(a[1]) || 0);
    } catch (e) { console.warn(e); }
  }

  // What the screens get back when a change is saved offline.
  function offlineResult(fn, args) {
    const note = "saved on your phone, will sync when you're back online";
    switch (fn) {
      case "saveVoicePurpose": return args[3] || "";
      case "addChecklistShortagesToShopping":
        return { addedCount: "The", checklistName: "this checklist (" + note + ")" };
      case "addUsagePlanToShopping":
        return { message: "Added (" + note + ")." };
      case "addNewItem": return { item: args[0], isNewItem: true, offline: true };
      default: return true;
    }
  }

  // ---------- the google.script.run replacement ----------
  async function call(fn, args) {
    if (isRead(fn)) {
      if (navigator.onLine) {
        try {
          if (queue().length) await flush();
          const result = await callServer(fn, args);
          writeCache(fn, args, result);
          return result;
        } catch (e) {
          if (!(e instanceof NetError)) throw e;
        }
      }
      const c = readCache(fn, args);
      if (c) { markStale(c.t); return c.result; }
      throw new Error("You're offline and this screen hasn't been opened online yet.");
    }

    // a change
    if (navigator.onLine) {
      try {
        if (queue().length) await flush();
        const result = await callServer(fn, args);
        refreshSoon();
        return result;
      } catch (e) {
        if (!(e instanceof NetError)) throw e;
      }
    }
    enqueue(fn, args);
    toast("Saved offline — will sync later");
    return offlineResult(fn, args);
  }

  function runner(onOk, onFail, userObj) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === "withSuccessHandler") return f => runner(f, onFail, userObj);
        if (prop === "withFailureHandler") return f => runner(onOk, f, userObj);
        if (prop === "withUserObject") return o => runner(onOk, onFail, o);
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args) => {
          // copy args so later edits by the screen can't change queued data
          const clean = JSON.parse(JSON.stringify(args));
          call(prop, clean).then(
            r => onOk && onOk(r, userObj),
            e => { if (onFail) onFail(e, userObj); else alert(e.message); }
          );
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = runner();
  window.google.script.host = { close() {}, setHeight() {}, setWidth() {} };

  // ---------- background refresh: keep everything ready for offline ----------
  const WARM = ["getShoppingList", "getInventory", "getChecklists", "getPlanToBuy",
    "getVoiceList", "getBudgetDashboard", "recalculateUsagePlanner"];
  let warming = false;
  async function warm() {
    if (warming || !navigator.onLine || !config()) return;
    warming = true;
    updateStatus();
    try {
      if (queue().length) await flush();
      const data = await api({ batch: WARM.map(fn => ({ fn, args: [] })) }, 180000);
      (data.results || []).forEach((r, i) => { if (r.ok) writeCache(WARM[i], [], r.result); });
      const lists = (readCache("getChecklists", []) || {}).result || [];
      if (lists.length) {
        const calls = lists.map(c => ({ fn: "getChecklistDetails", args: [c.id] }));
        const d2 = await api({ batch: calls }, 180000);
        (d2.results || []).forEach((r, i) => { if (r.ok) writeCache("getChecklistDetails", calls[i].args, r.result); });
      }
      staleSince = 0;
    } catch (e) {
      console.warn("background refresh failed", e);
    } finally {
      warming = false;
      updateStatus();
    }
  }
  let refreshTimer;
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(warm, 4000); }

  // ---------- little status bar ----------
  let staleSince = 0;
  function markStale(t) { staleSince = t; updateStatus(); }
  function fmtTime(t) {
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    return (sameDay ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " ") +
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function updateStatus() {
    const el = document.getElementById("pa-status");
    if (!el) return;
    const n = queue().length;
    const online = navigator.onLine;
    let text, color;
    if (!online) {
      const last = LS.get(SYNC_KEY, 0);
      text = "Offline" + (last ? " · data from " + fmtTime(last) : "") + (n ? " · " + n + " waiting" : "");
      color = "#8a5a00";
    } else if (flushing) { text = "Syncing " + n + " change" + (n === 1 ? "" : "s") + "…"; color = "#1f5fa8"; }
    else if (n) { text = n + " change" + (n === 1 ? "" : "s") + " waiting · tap to sync"; color = "#8a5a00"; }
    else if (warming) { text = "Updating offline copy…"; color = "#555"; }
    else { text = ""; }
    el.textContent = text;
    el.style.background = color || "transparent";
    el.style.display = text ? "block" : "none";
  }
  function toast(msg) {
    if (typeof window.showToast === "function") { try { window.showToast(msg); return; } catch (e) {} }
  }
  function mountStatus() {
    if (document.getElementById("pa-status")) return;
    attachListeners();   // once per page; the page swap erased the earlier ones
    const st = document.createElement("div");
    st.id = "pa-status";
    st.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:99999;" +
      "color:#fff;font:600 13px system-ui,sans-serif;padding:7px 14px;border-radius:999px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.25);display:none;max-width:92vw;text-align:center";
    st.onclick = () => { if (navigator.onLine) flush().then(warm); };
    document.body.appendChild(st);

    const gear = document.createElement("button");
    gear.textContent = "⚙";
    gear.title = "Phone app settings";
    gear.style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;width:36px;height:36px;" +
      "border-radius:50%;border:1px solid #ccc;background:#fff;font-size:18px;padding:0;margin:0;opacity:.75";
    gear.onclick = showSettings;
    document.body.appendChild(gear);

    updateStatus();
    warm();
  }

  async function updateApp(box) {
    if (!navigator.onLine) { alert("You're offline. Connect to the internet to update."); return; }
    const b = box && box.querySelector("#pa-update");
    if (b) { b.disabled = true; b.textContent = "Updating…"; }
    try { await flush(); } catch (e) {}
    if (queue().length) {
      if (b) { b.disabled = false; b.textContent = "Update app"; }
      alert("Couldn't send your waiting changes yet, so the app wasn't reloaded. Try again in a moment.");
      return;
    }
    try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (e) {}
    location.reload();
  }

  function showSettings() {
    const cfg = config() || {};
    const n = queue().length;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;" +
      "align-items:center;justify-content:center;font-family:system-ui,sans-serif";
    box.innerHTML = `
      <div style="background:#fff;border-radius:14px;padding:18px;width:min(92vw,420px)">
        <h3 style="margin-top:0">Phone app settings</h3>
        <label style="font-size:13px">Apps Script web app URL</label>
        <input id="pa-url" style="width:100%;padding:9px;margin:4px 0 10px" value="${(cfg.url || "").replace(/"/g, "&quot;")}">
        <label style="font-size:13px">Key</label>
        <input id="pa-key" type="password" style="width:100%;padding:9px;margin:4px 0 10px" value="${(cfg.key || "").replace(/"/g, "&quot;")}">
        <p style="font-size:13px;color:#555">${n} change(s) waiting to sync.</p>
        <button id="pa-save" style="padding:10px 14px">Save</button>
        <button id="pa-sync" style="padding:10px 14px">Sync now</button>
        <button id="pa-update" style="padding:10px 14px">Update app</button>
        <button id="pa-close" style="padding:10px 14px">Close</button>
      </div>`;
    document.body.appendChild(box);
    box.querySelector("#pa-close").onclick = () => box.remove();
    box.querySelector("#pa-sync").onclick = () => { box.remove(); flush().then(warm); };
    box.querySelector("#pa-update").onclick = () => updateApp(box);
    box.querySelector("#pa-save").onclick = () => {
      const url = box.querySelector("#pa-url").value.trim();
      const key = box.querySelector("#pa-key").value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { alert("That doesn't look like an Apps Script web app URL."); return; }
      LS.set(CFG_KEY, { url, key });
      box.remove();
      location.reload();
    };
  }

  // The page swap (document.open) erases listeners, so (re)attach them on every page.
  function attachListeners() {
    window.addEventListener("online", () => { updateStatus(); flush().then(warm); });
    window.addEventListener("offline", updateStatus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && navigator.onLine) flush();
    });
  }
  attachListeners();

  // ---------- start-up (called by index.html) ----------
  async function boot() {
    // Wait until the start-up page has fully loaded before replacing it.
    if (document.readyState === "loading") {
      await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
    }
    await new Promise(r => setTimeout(r, 0));
    if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
    const cfg = config();
    if (!cfg) return showSetup();

    let html = null;
    if (navigator.onLine) {
      try {
        const data = await api({ fn: "__ui" }, 20000);
        if (data.ok && data.result) { html = data.result; LS.set(UI_KEY, html); }
      } catch (e) {
        if (e.auth) return showSetup(e.message);
      }
    }
    html = html || LS.get(UI_KEY, null);
    if (!html) {
      document.getElementById("pa-msg").textContent =
        "Connect to the internet once so the app can download your lists.";
      return;
    }
    render(html);
  }

  function render(html) {
    const head = (/name=["']?viewport/i.test(html) ? '' :
        '<meta name="viewport" content="width=device-width, initial-scale=1">') +
      '<link rel="manifest" href="manifest.webmanifest">' +
      '<meta name="theme-color" content="#2e7d32">' +
      '<link rel="icon" href="icon-192.png">' +
      '<script src="shim.js"><\/script>';
    const tail = '<script>window.__pa && window.__pa.mountStatus();<\/script>';
    html = html.replace(/<base[^>]*>/i, "");
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + head) : head + html;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tail + "</body>") : html + tail;
    document.open();
    document.write(html);
    document.close();
  }

  function showSetup(error) {
    document.getElementById("pa-loading").style.display = "none";
    const f = document.getElementById("pa-setup");
    f.style.display = "block";
    const cfg = config() || {};
    document.getElementById("pa-url").value = cfg.url || "";
    document.getElementById("pa-key").value = cfg.key || "";
    document.getElementById("pa-err").textContent = error || "";
    document.getElementById("pa-go").onclick = async () => {
      const url = document.getElementById("pa-url").value.trim();
      const key = document.getElementById("pa-key").value.trim();
      const err = document.getElementById("pa-err");
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { err.textContent = "Paste the web app URL from Apps Script (it ends in /exec)."; return; }
      if (!key) { err.textContent = "Paste the key."; return; }
      LS.set(CFG_KEY, { url, key });
      err.textContent = "Checking…";
      try {
        const data = await api({ fn: "__ui" }, 30000);
        if (!data.ok) throw new Error(data.error);
        LS.set(UI_KEY, data.result);
        render(data.result);
      } catch (e) {
        err.textContent = e.auth ? "That key was rejected." :
          (e instanceof NetError ? "Couldn't reach the script. Check the URL, and that the deployment's access is 'Anyone'." : e.message);
      }
    };
  }

  window.__pa = { boot, mountStatus, flush, warm, showSettings };
})();
