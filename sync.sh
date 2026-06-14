#!/bin/bash
VM_HOST="chip@192.168.122.68"
EXT_DIR="~/.local/share/gnome-shell/extensions/weather@chip"

echo "Syncing weather extension to VM..."
rsync -avz --delete --exclude venv --exclude '*.whl' --exclude .git --exclude '*.zip' --exclude sync.sh --exclude AGENTS.md --exclude opencode.json /home/chip/projects/weather-extension/ ${VM_HOST}:${EXT_DIR}/
ssh ${VM_HOST} "glib-compile-schemas ${EXT_DIR}/schemas" 2>/dev/null

echo "Restarting GNOME Shell in VM (GDM)..."
ssh ${VM_HOST} 'sudo systemctl restart gdm'

echo "Done! Wait ~15s for login, then test."
