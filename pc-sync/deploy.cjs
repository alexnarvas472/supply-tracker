// Shared deploy tool. Each project's deploy.cmd calls this with its own folder.
//   0) backs up the project and checks Google hasn't got a newer version
//      (edited on another PC or online) - stops instead of overwriting it
//   1) clasp push
//   2) updates the /exec deployment (only the one in phone-deployment.txt, if that file exists)
//   3) records the deploy so the sync helper knows this PC and Google match
const { execSync, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), readline = require("readline");

module.exports = async function deploy(projectDir) {
  const run = (cmd, quiet) => execSync(cmd, { cwd: projectDir, stdio: quiet ? "pipe" : "inherit", shell: true, encoding: "utf8" });
  const helper = path.join(__dirname, "pc_sync.py");
  const py = ["py", "python"].find(p => spawnSync(p, ["--version"], { shell: true }).status === 0);
  const ask = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a.trim().toLowerCase()); }); });
  const fail = msg => { console.log("\n" + msg); process.exitCode = 1; };

  try {
    console.log("Deploying: " + path.basename(projectDir) + "\n");
    if (!py) return fail("Python wasn't found, so nothing was deployed (it's needed for the backup and safety check).");

    console.log("0) Backing up and checking Google for newer changes…");
    const check = spawnSync(py, [`"${helper}"`, "--before-deploy", `"${projectDir}"`], { stdio: "inherit", shell: true });
    if (check.status === 2) {
      const a = await ask("\nType OVERWRITE to replace Google's newer version anyway, or just press Enter to stop: ");
      if (a !== "overwrite") return fail("Stopped. Nothing was deployed.");
    } else if (check.status !== 0) {
      return fail("The backup/safety check didn't finish, so nothing was deployed.");
    }

    const version = run("clasp --version", true).trim();
    const major = parseInt((version.match(/\d+/) || ["2"])[0], 10);
    console.log("\n1) Sending your code to Google…");
    run("clasp push --force");

    console.log("\n2) Updating the deployment…");
    const list = run(major >= 3 ? "clasp list-deployments" : "clasp deployments", true);
    let ids = [...list.matchAll(/(AKfyc[\w-]+)\s+@(\d+)/g)].map(m => m[1]);
    const keepFile = path.join(projectDir, "phone-deployment.txt");
    if (fs.existsSync(keepFile)) {
      const keep = (fs.readFileSync(keepFile, "utf8").match(/AKfyc[\w-]+/) || [])[0];
      if (keep && ids.indexOf(keep) === -1) return fail("The deployment in phone-deployment.txt wasn't found:\n  " + keep);
      if (keep) ids = [keep];
    }
    if (!ids.length) console.log("No /exec deployments yet. Your code is pushed; /dev links already have it.");
    const desc = "update " + new Date().toLocaleString();
    ids.forEach(id => run(major >= 3
      ? `clasp update-deployment ${id} --description "${desc}"`
      : `clasp deploy --deploymentId ${id} --description "${desc}"`));

    spawnSync(py, [`"${helper}"`, "--mark-deployed", `"${projectDir}"`], { stdio: "inherit", shell: true });
    console.log("\nDone! Open the app with internet (or tap ⚙ > Update app) to get the new version.");
  } catch (e) {
    fail("Something went wrong (see above). You can still update by hand:\n" +
      "  Apps Script editor > Deploy > Manage deployments > pencil > Version: New version > Deploy");
  }
};

// Also works on its own:  node deploy.cjs "C:\path\to\project"
if (require.main === module) module.exports(path.resolve(process.argv[2] || process.cwd()));
