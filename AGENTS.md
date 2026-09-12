# Project workflow

The user wants implementation changes committed, pushed, and deployed by default.
After completing the appropriate checks, commit the changes, push to origin, deploy
both affected frontend and backend files, and verify the live site. Do not stop at
local changes or request the same authorization again.

Production: https://control.jiwonova.com/skhynix/
SSH host: thejiwon2025
Frontend: /var/www/skhynix/index.html
Backend checkout: /home/ubuntu/skhynix
Backend service: skhynix-daemon

Inspect the remote checkout and service before deploying. Preserve credentials,
runtime state (especially backend/auto_tranche_state.json), and unrelated changes.
Restart the backend service when backend code changes. Verify HTTP 200 text/html
for the frontend and check affected read-only API endpoints after deployment.
Never place test orders as part of deployment verification.
