const fs = require('node:fs');
const path = require('node:path');

// Windows does not permit replacing a loaded kernel driver. Flowseal often
// ships the *same* WinDivert64.sys in consecutive releases; copying it anyway
// causes EBUSY and can leave the installation only partly updated.
function filesAreEqual(source, destination) {
  if (!fs.existsSync(destination)) return false;
  const a = fs.statSync(source);
  const b = fs.statSync(destination);
  if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
  return fs.readFileSync(source).equals(fs.readFileSync(destination));
}

function copyFileIfDifferent(source, destination) {
  if (filesAreEqual(source, destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
}

function copyDirFiltered(source, target, filter = () => true) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!filter(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirFiltered(from, to, filter);
    else if (entry.isFile()) copyFileIfDifferent(from, to);
  }
}

module.exports = { filesAreEqual, copyFileIfDifferent, copyDirFiltered };
