# Releasing 0.1.0

Top to bottom. Nothing here runs itself, and nothing here happens without being asked.

## 1. Before the first commit

No commits exist yet. `git status --porcelain` must read exactly this, nothing more:

```
?? .gitignore  ?? .vscode/  ?? CLAUDE.md  ?? LICENSE  ?? README.md  ?? RELEASE.md  ?? fixtures/
?? package-lock.json  ?? package.json  ?? scripts/  ?? src/  ?? tsconfig.build.json  ?? tsconfig.json
```

All of it gets tracked, lockfile included. `CLAUDE.md` is committed on purpose, it is the house rules
for anyone editing the repo and it never ships to npm. `node_modules`, `dist`, `*.tgz`, `*.tsbuildinfo`,
`.DS_Store`, `.env*`, `fixtures/*.png` are ignored. `.vscode/` is the one open call, commit it or add
it to `.gitignore` before `git add -A`.

`dist/` and `node_modules/` exist on disk. Their absence from that list is the proof they are ignored.

```
grep -rIn "_authToken\|BEGIN .* PRIVATE KEY\|sk-ant-" --exclude-dir=node_modules --exclude-dir=.git .
find . -name '.env*' -o -name '.npmrc' -not -path './node_modules/*'
# both print nothing. any hit stops the release
```

## 2. Create the GitHub repo

`homepage`, `repository`, `bugs` and every README link point at `github.com/alabsi91/layout-lens`,
which does not exist. They 404 until the repo is public and step 3 has pushed, so publish after that.

```
gh repo create layout-lens --public --source=. --remote=origin \
  --description "Turns a rendered web page into layout facts a model can reason about"
gh api repos/alabsi91/layout-lens --jq '.has_issues'   # true, or /issues stays dead
```

## 3. First commit and push

No attribution in the message, no `Co-Authored-By`, no tool name, no `--author`. Never set or
override `user.name` or `user.email`.

```
git add -A && git status --short
git commit -m "layout-lens 0.1.0"
git push -u origin main
git log -1 --format='%an <%ae>%n%B'   # plant <alabsi91@gmail.com>, message body only
```

## 4. Pre-publish gate — all of it, in order, any failure stops the release

```
node --version                    # >= 22.18, the scripts import .ts directly
npx playwright install chromium   # nothing measures without it
npx tsc -p tsconfig.json          # silent. an error means the build is a lie
npm test                          # "all 32 fixtures passed". a miss = a measurement regressed
npm run score                     # 24 pages, 12 bugs. recall >= 0.90, precision >= 0.90
npm run score -- adversarial2     # same gate
npm run score -- adversarial3     # same gate
npm run build                     # dist/ holds 7 .js files
head -1 dist/cli.js dist/mcp.js   # #!/usr/bin/env node on both, or the bins do not run
```

A score below 0.90 is missed planted bugs (recall) or a clean page being talked about (precision).
Check the manifest before the tool, never weaken a rule to move a number. Then the tarball:

```
npm pack && tar -tzf layout-lens-0.1.0.tgz   # only package/dist/*, package.json, README.md, LICENSE
mkdir -p /tmp/ll-tar && cd /tmp/ll-tar && npm init -y
npm i /Users/alabsi91/Documents/layout-lens/layout-lens-0.1.0.tgz
./node_modules/.bin/layout-lens ~/Documents/layout-lens/fixtures/cards.html --findings   # span.badge
# with "clipped top 6" and "contrast"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | ./node_modules/.bin/layout-lens-mcp
# ^ a tools/list naming inspect_layout, screenshot_layout, layout_legend
```

A file missing from the tarball means `files` is wrong. A crash in a bin means the emit broke.

## 5. Publish

No `--access public`, unscoped names are public already. Step 4 is the only gate before the registry.

```
npm whoami                  # a name, or log in first
npm view layout-lens        # 404 = name free. anything else stops the release
npm publish --dry-run       # last look at the file list
npm publish                 # prepublishOnly wipes dist and rebuilds. it runs no tests
mkdir -p /tmp/ll-reg && cd /tmp/ll-reg && npm init -y && npm i layout-lens@0.1.0
npm view layout-lens version repository.url
```

## 6. Smoke test the published package

```
npx -y -p layout-lens layout-lens --legend | head -3      # the legend's first lines
npx -y -p layout-lens layout-lens https://example.com --findings   # a short findings tree, or the
# one line "could not launch chromium, run: npx playwright install chromium", which is correct too
npx -y -p layout-lens layout-lens-mcp < /dev/null         # exits quietly, no stack trace
```

## 7. If it goes wrong

- Under 72 hours, nothing depending on it: `npm unpublish layout-lens@0.1.0`. After that npm refuses.
- Unpublishing burns the number forever, `0.1.0` can never be republished. Bump to `0.1.1` always.
- Past the window, or broken but usable: publish `0.1.1`, then `npm deprecate layout-lens@0.1.0 "use 0.1.1"`.
- `latest` follows the newest publish. Wrong one on top: `npm dist-tag add layout-lens@0.1.1 latest`.
- Never unpublish to hide a mistake someone already installed, deprecate and ship the fix.

## 8. What 0.1.0 promises

Promises: the two bins run, the three MCP tools answer, the numbers are the rendered ones.
Does not: a stable output format. `src/legend.ts` is the only spec and it moves, tool names and
arguments can change, a `0.x` minor bump may break your parsing, so pin the exact version if you parse
it. Known ceilings, on purpose: quadratic on long lists (200 rows ≈ 1.8s), repeated findings down a
list are not collapsed, a wrapped inline rect is a union and not real geometry, closed shadow roots
are guessed at. Chromium is a separate download, and layout follows the machine's installed fonts.
