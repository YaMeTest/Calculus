# Liquid Pool Tracker

## Run from GitHub (one-click style)

1. Open **Actions** tab in your GitHub repository.
2. Select **Run BSC Scraper** workflow.
3. Click **Run workflow**, enter wallet address, and confirm.

The workflow will run scraper and automatically commit updated `data/positions.json` when new cashflows are imported.

### Required secret

Add repository secret:
- `BSCSCAN_API_KEY` (optional but recommended to avoid rate limits)

