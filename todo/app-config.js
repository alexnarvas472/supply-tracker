// Settings for the To-Do Checklist phone app (used by shim.js).
window.PA_APP = window.PA_APP || {
  id: "todo",

  // Calls that only read data: cached for offline use.
  reads: ["getArray", "getonlypartofdatafromperpetual", "getVoiceTodoList", "loadAndRepairChecklist"],

  // Calls that need internet (they create/move lists on the server).
  onlineOnly: ["createRoutineList", "importGridToChecklist", "transferTask"],

  // Refreshed in the background whenever the app is online.
  warm: ["getVoiceTodoList"],

  // Offline: re-opening a list shows what's on screen, including offline edits.
  offlineRead(fn, args) {
    if (fn === "loadAndRepairChecklist" && typeof allTasks !== "undefined" && allTasks[args[0]]) {
      return { tasks: allTasks[args[0]], repaired: false };
    }
  },

  // Save the lists as they are on screen, so offline edits survive closing the app.
  snapshot() {
    if (typeof allTasks === "undefined" || typeof data1 === "undefined") return null;
    const sections = (data1.data1 || []).map(s => ({
      name: s.name, divLabel: s.divLabel, subSection: s.subSection,
      array: allTasks[s.name] || s.array
    }));
    Object.keys(allTasks).forEach(name => {
      if (!sections.some(s => s.name === name)) {
        sections.push({ name, divLabel: "", subSection: "", array: allTasks[name] });
      }
    });
    return { fn: "getArray", args: [], value: JSON.parse(JSON.stringify(sections)) };
  }
};
