# Rental Tracker — Claude Agent Notes

## Version bumping (REQUIRED before every push)

The app has a built-in updater (`updater.js`) that compares `package.json` version numbers between the local install and GitHub. It only downloads an update when the remote version is **strictly greater** than the local one.

**Every commit automatically bumps the patch version** — the pre-commit git hook increments the patch version in `package.json` and stages it as part of every commit. This means every pushed commit is guaranteed to have a higher version than the previous one, so the updater always detects changes.

If you are on a machine without the hook (fresh clone), bump manually before committing:

```bash
node -e "
  const fs=require('fs');
  const p=JSON.parse(fs.readFileSync('package.json','utf8'));
  const [ma,mi,pa]=p.version.split('.').map(Number);
  p.version=ma+'.'+mi+'.'+(pa+1);
  fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
"
git add package.json
```

Then include it in your commit before pushing. Never push without a version bump — the updater will silently skip the download on all other installs.
