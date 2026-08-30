#!/usr/bin/env bash
set -e

echo "=== 1. Pulling latest codebase ==="
cd /home/ubuntu/skhynix
git pull

echo "=== 2. Deploying frontend bundle to /var/www/skhynix ==="
sudo mkdir -p /var/www/skhynix
sudo cp /home/ubuntu/skhynix/index.html /var/www/skhynix/index.html
sudo chown -R caddy:caddy /var/www/skhynix

echo "=== 3. Installing dependencies in /home/ubuntu/myenv ==="
/home/ubuntu/myenv/bin/pip install -q -r /home/ubuntu/skhynix/backend/requirements.txt

echo "=== 4. Setting up systemd service for trading daemon ==="
sudo tee /etc/systemd/system/skhynix-daemon.service > /dev/null << 'EOF'
[Unit]
Description=SK Hynix Quant Trading & Telemetry Daemon
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/skhynix
ExecStart=/home/ubuntu/myenv/bin/python -m backend.server
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable skhynix-daemon
sudo systemctl restart skhynix-daemon

echo "=== 5. Updating Caddy Reverse Proxy ==="
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
https://control.jiwonova.com {
    encode gzip zstd

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Content-Security-Policy "frame-ancestors https://www.youtube.com https://youtube.com"
    }

    # --- SK Hynix Perp Spread Monitor & Quant Engine ---
    redir /skhynix /skhynix/ 308

    handle /skhynix/api/* {
        uri strip_prefix /skhynix
        reverse_proxy 127.0.0.1:8000
    }

    handle /skhynix/ws/* {
        uri strip_prefix /skhynix
        reverse_proxy 127.0.0.1:8000
    }

    handle_path /skhynix/* {
        root * /var/www/skhynix
        file_server
        try_files {path} /index.html
    }

    # --- Vision Memory Bridge ---
    @vmb path /vmb /vmb/*
    handle @vmb {
        uri strip_prefix /vmb
        reverse_proxy 127.0.0.1:8767
    }

    handle {
        respond "Vision Memory control plane is up." 200
    }
}
EOF

sudo systemctl reload caddy

echo "=== Deployment and systemd service setup completed successfully! ==="
