# ops/ — what runs the hosted Chamber (copied from the live server, kept in sync by chamber-deploy)

| file | installed at | job |
|---|---|---|
| chamber-deploy | /usr/local/sbin | release a commit: stage, `node --check`, full `test_isolation.js`, swap, restart, smoke test, auto-rollback |
| chamber-rollback | /usr/local/sbin | return to the commit that was live before the last deploy |
| chamber-backup (+ .service/.timer) | /usr/local/sbin, systemd 03:40 UTC | consistent snapshot (tools/snapshot.js) → verified tar → S3 with sha256 metadata → status file, email on failure. Uploaded files are copied to the bucket once each, not inside every nightly archive. The destination is `CHAMBER_BACKUP_S3=s3://<bucket>/<folder>` in `/etc/chamber/chamber.env` |
| chamber-restore-drill (+ .service/.timer) | /usr/local/sbin, systemd Sun 04:30 UTC | restore the newest backup to a scratch dir, verify, boot it, require health; check every uploaded file has its copy and compare a few byte for byte |
| chamber-storage-setup | /usr/local/sbin | hosted product only: find or create the Stripe price for the storage add-on and write its two settings |
| chamber-admin | /usr/local/sbin | accounts: add / password / promote / list / transfer / remove |
| chamber.service | /etc/systemd/system | hardened unit: Restart=always, graceful stop (TimeoutStopSec=10), MemoryMax=1G, ProtectSystem=strict |

Secrets live in `/etc/chamber/chamber.env` (root:chamber 640) and are never in this repo.
