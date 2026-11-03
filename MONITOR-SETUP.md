# 24/7 phone alerts (optional)

Prop Desk sends alerts while it's open. To get them **even when your phone is locked or the app is closed**, you run your own free copy of the monitor on GitHub. It checks your positions every 15 minutes and only alerts when something changes. Takes about 10 minutes, once.

**What you need:** a free GitHub account (https://github.com/signup) and the ntfy app with your private channel from Prop Desk → Settings → Phone alerts.

## 1. Make your own private copy
1. Create a new empty repository named `prop-desk-monitor` and choose **Private**.
2. Copy the PDA branch into it with Git (desktop or command line): `git clone --branch pda/app-clone-today https://github.com/jbyerstemp-jpg/prop-desk-auto.git prop-desk-monitor`, then inside that folder set the `origin` remote to your new private repository and push the checked-out branch to `main` (`git push -u origin HEAD:main`). This copies the monitor code and its dependencies. The sample `monitor/watch.json` is blank; do not copy a populated watch file from another account.

## 2. Tell it where to send alerts
1. In your new repo: **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `NTFY_TOPIC_PROP`. Value: your channel name from Prop Desk (Settings → Phone alerts → Copy channel name). **Add secret**.

## 3. Let Prop Desk update it automatically
1. Make a key: https://github.com/settings/personal-access-tokens/new
   - Name `Prop Desk`, expiration 90 days.
   - Repository access: **Only select repositories → prop-desk-monitor**.
   - Repository permissions: **Contents → Read and write**. Everything else: no access.
   - **Generate token** and copy it (starts with `github_pat_`).
2. In Prop Desk → Settings → **24/7 monitor key**: monitor repo `your-github-name/prop-desk-monitor`, paste the key, **Save & test**. You should see "Works."

## 4. Done
Import your screenshots as usual. Each sync updates your monitor, and it starts watching within a minute. Your first alert is a "new trading day" summary.

**Privacy:** your positions go only to your own private repo. The key works only on that one repo and can only edit files. It can't touch your exchange or money. If your phone is lost, delete the key at https://github.com/settings/personal-access-tokens.

**Renew:** the key expires after 90 days. Prop Desk will say "GitHub refused the key"; make a new one the same way.

Not financial advice. Alerts are rule checks, not predictions.
