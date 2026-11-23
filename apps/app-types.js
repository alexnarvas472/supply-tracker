// How each kind of app behaves offline inside My Apps.
//   reads          calls that only read data (cached for offline)
//   offlineWrites  changes that can be saved offline and synced later
//   warm           what to download in the background for offline use
//   prepareArgs / applyOffline / offlineRead / onResult  app-specific helpers
window.MYAPPS_TYPES = window.MYAPPS_TYPES || (function () {
  const pad = n => String(n).padStart(2, "0");
  const dateKey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const nowIso = () => new Date().toISOString();
  const newId = () => Math.random().toString(16).slice(2, 10);

  /* ---------------- Any app (installed; offline = view what was loaded) ---------------- */
  const generic = { label: "Other app", icon: "📱" };

  /* ---------------- My App Register (work orders work offline) ---------------- */
  function woSort(list) {
    return list.sort((a, b) => (!!a.done - !!b.done) ||
      (a.done ? String(b.done).localeCompare(a.done) : String(a.added).localeCompare(b.added)));
  }
  function regState(cache) { return cache.read("prLoad", []); }
  function regSave(cache, state) { cache.write("prLoad", [], state); }
  function regFind(state, id) {
    for (const key in (state.orders || {})) {
      const o = state.orders[key].find(x => x.id === id);
      if (o) return { key, o };
    }
    return null;
  }
  function regListFor(state, key) {
    const list = woSort((state.orders[key] = state.orders[key] || []));
    const p = (state.projects || []).find(x => x.key === key);
    if (p) p.openOrders = list.filter(o => !o.done).length;
    return JSON.parse(JSON.stringify(list));
  }
  const register = {
    label: "App Register", icon: "🗂",
    reads: ["prLoad", "prPcStatus", "prWorkOrders", "prAllOpenWorkOrders"],
    offlineWrites: ["prAddWorkOrder", "prSetWorkOrderDone", "prEditWorkOrder", "prDeleteWorkOrder"],
    warm: ["prLoad"],
    // Work orders get their ID and time stamp on the phone, so offline ones keep the real time.
    prepareArgs(fn, a) {
      if (fn === "prAddWorkOrder") return [a[0], a[1], a[2], a[3] || newId(), a[4] || nowIso()];
      if (fn === "prSetWorkOrderDone") return [a[0], a[1], a[2] || nowIso()];
      return a;
    },
    applyOffline(fn, a, cache) {
      const state = regState(cache);
      if (!state) return undefined;
      state.orders = state.orders || {};
      let key;
      if (fn === "prAddWorkOrder") {
        key = a[0];
        const list = (state.orders[key] = state.orders[key] || []);
        if (!list.some(o => o.id === a[3])) list.push({ id: a[3], key, project: a[1], text: String(a[2]).trim(), added: a[4], done: "" });
      } else {
        const hit = regFind(state, a[0]);
        if (!hit) return undefined;
        key = hit.key;
        if (fn === "prSetWorkOrderDone") hit.o.done = a[1] ? a[2] : "";
        if (fn === "prEditWorkOrder") hit.o.text = String(a[1]).trim();
        if (fn === "prDeleteWorkOrder") state.orders[key] = state.orders[key].filter(o => o.id !== a[0]);
      }
      const list = regListFor(state, key);
      regSave(cache, state);
      return list;
    },
    offlineRead(fn, a, cache) {
      const state = regState(cache);
      if (!state || !state.orders) return undefined;
      if (fn === "prWorkOrders") return regListFor(state, a[0]);
      if (fn === "prAllOpenWorkOrders") {
        return woSort([].concat(...Object.values(state.orders)).filter(o => !o.done));
      }
      return undefined;
    }
  };

  /* ---------------- Where My Time Went (categorize hours offline) ---------------- */
  function hoursStore(cache) { return cache.store("hours") || { days: {}, covered: {}, cats: [] }; }
  function eachDate(start, end, f) {
    const d = new Date(start + "T12:00:00"), last = new Date(end + "T12:00:00");
    for (; d <= last; d.setDate(d.getDate() + 1)) f(dateKey(d));
  }
  const hours = {
    label: "Time tracker", icon: "⏱",
    reads: ["getTimeDashboard"],
    offlineWrites: ["saveHourCategory"],
    // Keep the last 2 weeks on the phone.
    warm() {
      const end = new Date(), start = new Date();
      start.setDate(start.getDate() - 13);
      return [{ fn: "getTimeDashboard", args: [dateKey(start), dateKey(end)] }];
    },
    onResult(fn, a, data, cache) {
      if (fn !== "getTimeDashboard" || !data) return;
      const s = hoursStore(cache);
      eachDate(data.startDate || a[0], data.endDate || a[1], k => { s.covered[k] = true; delete s.days[k]; });
      (data.days || []).forEach(day => { s.days[day.date] = { day, unc: [] }; });
      (data.uncategorized || []).forEach(u => { if (s.days[u.date]) s.days[u.date].unc.push(u); });
      s.cats = Array.from(new Set([].concat(s.cats, data.categories || []))).sort();
      cache.store("hours", s);
    },
    offlineRead(fn, a, cache) {
      if (fn !== "getTimeDashboard") return undefined;
      const s = hoursStore(cache);
      let all = true;
      eachDate(a[0], a[1], k => { if (!s.covered[k]) all = false; });
      if (!all) return undefined;   // not downloaded: say so instead of showing gaps
      const days = [], unc = [], totals = {};
      Object.keys(s.days).sort().forEach(k => {
        if (k < a[0] || k > a[1]) return;
        const rec = s.days[k];
        days.push(rec.day);
        rec.unc.slice().sort((x, y) => x.hour - y.hour).forEach(u => unc.push(u));
        rec.day.categories.forEach(c => { totals[c.category] = (totals[c.category] || 0) + c.hours; });
      });
      const categoryTotals = Object.keys(totals).map(c => ({ category: c, hours: totals[c] })).sort((x, y) => y.hours - x.hours);
      return {
        startDate: a[0], endDate: a[1],
        totalCategorizedHours: categoryTotals.reduce((n, c) => n + c.hours, 0),
        totalUncategorizedHours: unc.length,
        days, categoryTotals, uncategorized: unc, categories: s.cats.slice()
      };
    },
    applyOffline(fn, a, cache) {
      if (fn !== "saveHourCategory") return undefined;
      const [date, hour, category] = [a[0], Number(a[1]), String(a[2] || "").trim()];
      const s = hoursStore(cache);
      const rec = s.days[date];
      if (rec) {
        const i = rec.unc.findIndex(u => Number(u.hour) === hour);
        if (i !== -1) { rec.unc.splice(i, 1); rec.day.loggedButUncategorized = Math.max(0, rec.day.loggedButUncategorized - 1); }
        else if (rec.day.blankHours > 0) rec.day.blankHours--;
        rec.day.categorizedHours++;
        const c = rec.day.categories.find(x => x.category === category);
        if (c) c.hours++; else rec.day.categories.push({ category, hours: 1 });
        rec.day.categories.sort((x, y) => y.hours - x.hours);
      }
      if (category && s.cats.indexOf(category) === -1) s.cats = s.cats.concat(category).sort();
      cache.store("hours", s);
      return { success: true, date, hour, category };
    }
  };

  return { generic, register, hours };
})();
