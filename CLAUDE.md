# Rental Tracker — Claude Agent Notes

## Version bumping (REQUIRED before every push)

The app has a built-in updater (`updater.js`) that compares `package.json` version numbers between the local install and GitHub. It only downloads an update when the remote version is **strictly greater** than the local one.

**Rule: always bump the patch version in `package.json` before pushing**, so other machines pick up the changes automatically on next startup.

A git pre-push hook handles this automatically on machines where the repo was cloned locally. If you are pushing without the hook (e.g. on a fresh clone), bump the version manually:

```bash
node -e "
  const fs=require('fs');
  const p=JSON.parse(fs.readFileSync('package.json','utf8'));
  const [ma,mi,pa]=p.version.split('.').map(Number);
  p.version=ma+'.'+mi+'.'+(pa+1);
  fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
"
git add package.json
git commit -m "Bump version to <new>"
```

Never push without a version bump — the updater will silently skip the download on all other installs.
