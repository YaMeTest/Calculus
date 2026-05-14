# Liquid Pool Tracker

## Run scraper from GitHub (one-click)

1. Open **Actions** in your GitHub repository.
2. Select **Run BSC Scraper**.
3. Click **Run workflow**, enter wallet address, and confirm.

The workflow runs the scraper and commits updated `data/positions.json` if new cashflows are imported.

## How to access the application after pipeline runs

GitHub Actions runners are temporary and not publicly exposed, so you cannot open the web app from a pipeline URL after the job finishes.

To open the UI, run the app in one of these ways:
- **Locally:** `npm start`, then open `http://localhost:3000`.
- **Deploy to a hosting platform** (Render/Railway/Fly.io/VM) and open that permanent URL.

The workflow is intended for **data sync**, not for hosting the UI.

### Required secret

Add repository secret:
- `BSCSCAN_API_KEY` (optional but recommended to reduce rate limits)
