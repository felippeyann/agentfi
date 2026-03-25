#!/usr/bin/env bash
# =============================================================================
# AgentFi Server Provisioning Script
# Ubuntu 22.04 LTS — sets up Docker, Foundry, Node.js 20, firewall, nginx,
# certbot, and the agentfi systemd service.
#
# Usage: sudo bash setup-server.sh
# Idempotent: safe to re-run.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Colors
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# -----------------------------------------------------------------------------
# Guard: must run as root
# -----------------------------------------------------------------------------
if [[ "$EUID" -ne 0 ]]; then
  error "Please run as root: sudo bash $0"
  exit 1
fi

# Capture the non-root user who invoked sudo (for docker group, foundryup, etc.)
SUDO_USER="${SUDO_USER:-$(logname 2>/dev/null || echo '')}"
if [[ -z "$SUDO_USER" || "$SUDO_USER" == "root" ]]; then
  warn "Could not detect a non-root invoking user. Docker group and Foundry will be set up for root only."
  REAL_USER="root"
  REAL_HOME="/root"
else
  REAL_USER="$SUDO_USER"
  REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
fi

info "Provisioning server for user: ${REAL_USER}"

# =============================================================================
# 1. SYSTEM UPDATES
# =============================================================================
info "==> Step 1: System updates"
apt-get update -y
apt-get upgrade -y
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  unzip \
  ufw

# =============================================================================
# 2. INSTALL DOCKER CE + DOCKER COMPOSE V2
# =============================================================================
info "==> Step 2: Installing Docker CE and Docker Compose v2"

if command -v docker &>/dev/null; then
  warn "Docker is already installed ($(docker --version)). Skipping Docker install."
else
  # Add Docker's official GPG key
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # Add Docker apt repository
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" \
    | tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

  info "Docker installed: $(docker --version)"
  info "Docker Compose installed: $(docker compose version)"
fi

# Enable and start Docker
systemctl enable docker
systemctl start docker

# Add real user to docker group (idempotent)
if id -nG "$REAL_USER" | grep -qw docker; then
  warn "User '${REAL_USER}' is already in the docker group."
else
  usermod -aG docker "$REAL_USER"
  info "Added '${REAL_USER}' to the docker group. Re-login required for it to take effect."
fi

# =============================================================================
# 3. INSTALL FOUNDRY (forge/cast/anvil for contract deployment)
# =============================================================================
info "==> Step 3: Installing Foundry"

if command -v forge &>/dev/null; then
  warn "Foundry (forge) is already installed. Skipping."
else
  # Run foundryup as the real user so it installs into their home directory
  su - "$REAL_USER" -c 'curl -L https://foundry.paradigm.xyz | bash'
  su - "$REAL_USER" -c "source ${REAL_HOME}/.bashrc 2>/dev/null || true; ${REAL_HOME}/.foundry/bin/foundryup"
  info "Foundry installed."
fi

# =============================================================================
# 4. INSTALL NODE.JS 20 (via NodeSource)
# =============================================================================
info "==> Step 4: Installing Node.js 20"

NODE_MAJOR=20
if node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}"; then
  warn "Node.js $(node --version) is already installed. Skipping."
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  info "Node.js installed: $(node --version)"
  info "npm installed: $(npm --version)"
fi

# =============================================================================
# 5. FIREWALL (ufw)
# =============================================================================
info "==> Step 5: Configuring UFW firewall"

# Set defaults
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Public services
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP'
ufw allow 443/tcp  comment 'HTTPS'

# Internal services — only accessible from localhost (nginx will proxy them)
ufw allow from 127.0.0.1 to any port 3000 proto tcp comment 'AgentFi API (internal)'
ufw allow from 127.0.0.1 to any port 3001 proto tcp comment 'AgentFi Admin (internal)'
ufw allow from 127.0.0.1 to any port 3002 proto tcp comment 'AgentFi MCP SSE (internal)'

ufw --force enable
info "UFW status:"
ufw status verbose

# =============================================================================
# 6. DIRECTORY SETUP
# =============================================================================
info "==> Step 6: Setting up /opt/agentfi"

DEPLOY_DIR="/opt/agentfi"
mkdir -p "$DEPLOY_DIR"

# Copy compose files if they exist next to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

for compose_file in docker-compose.yml docker-compose.prod.yml; do
  src="${PROJECT_ROOT}/${compose_file}"
  dst="${DEPLOY_DIR}/${compose_file}"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
    info "Copied ${compose_file} to ${DEPLOY_DIR}"
  else
    warn "${src} not found — you must copy ${compose_file} to ${DEPLOY_DIR} manually."
  fi
done

# Create .env placeholder if it doesn't exist yet
ENV_FILE="${DEPLOY_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  warn "${ENV_FILE} already exists. Not overwriting."
else
  cat > "$ENV_FILE" <<'EOF'
# =============================================================================
# AgentFi Production Environment Variables
# Fill in ALL values before starting the service.
# =============================================================================

# --- Database ---
DATABASE_URL=postgresql://agentfi:CHANGE_ME@localhost:5432/agentfi

# --- Redis ---
REDIS_URL=redis://localhost:6379

# --- JWT / Auth ---
JWT_SECRET=CHANGE_ME_to_a_long_random_secret
NEXTAUTH_SECRET=CHANGE_ME_to_another_long_random_secret
NEXTAUTH_URL=https://admin.agentfi.xyz

# --- Blockchain RPC ---
RPC_URL_MAINNET=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
RPC_URL_BASE=https://mainnet.base.org
RPC_URL_ARB=https://arb1.arbitrum.io/rpc

# --- Contract Addresses (populated after deployment) ---
VAULT_FACTORY_ADDRESS=
AGENT_REGISTRY_ADDRESS=

# --- AI / LLM ---
OPENAI_API_KEY=sk-CHANGE_ME
ANTHROPIC_API_KEY=CHANGE_ME

# --- Misc ---
NODE_ENV=production
LOG_LEVEL=info
EOF
  info "Created .env placeholder at ${ENV_FILE}"
  warn "IMPORTANT: Edit ${ENV_FILE} and fill in all secrets before starting AgentFi."
fi

chown -R "$REAL_USER:$REAL_USER" "$DEPLOY_DIR"

# =============================================================================
# 7. SYSTEMD SERVICE
# =============================================================================
info "==> Step 7: Installing agentfi systemd service"

SERVICE_FILE="/etc/systemd/system/agentfi.service"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AgentFi — AI-powered DeFi agent platform
Documentation=https://github.com/agentfi/agentfi
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
ExecStart=/usr/bin/docker compose \\
  -f ${DEPLOY_DIR}/docker-compose.yml \\
  -f ${DEPLOY_DIR}/docker-compose.prod.yml \\
  up -d --remove-orphans
ExecStop=/usr/bin/docker compose \\
  -f ${DEPLOY_DIR}/docker-compose.yml \\
  -f ${DEPLOY_DIR}/docker-compose.prod.yml \\
  down
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentfi
Restart=on-failure
RestartSec=10s
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable agentfi.service
info "agentfi.service installed and enabled."
warn "Do NOT start the service yet — fill in ${ENV_FILE} first."

# =============================================================================
# 8. INSTALL NGINX + CERTBOT
# =============================================================================
info "==> Step 8: Installing nginx and certbot"

apt-get install -y nginx certbot python3-certbot-nginx

# Copy nginx config if it exists
NGINX_CONF_SRC="${PROJECT_ROOT}/infra/nginx.conf"
NGINX_CONF_DST="/etc/nginx/sites-available/agentfi"

if [[ -f "$NGINX_CONF_SRC" ]]; then
  cp "$NGINX_CONF_SRC" "$NGINX_CONF_DST"
  # Enable site
  ln -sf "$NGINX_CONF_DST" /etc/nginx/sites-enabled/agentfi
  # Remove default site if still linked
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  info "nginx config installed and reloaded."
else
  warn "${NGINX_CONF_SRC} not found. Copy infra/nginx.conf to ${NGINX_CONF_DST} manually."
fi

systemctl enable nginx
systemctl start nginx

# =============================================================================
# FINAL INSTRUCTIONS
# =============================================================================
echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  AgentFi server provisioning complete!${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "  1. Fill in secrets:"
echo "       sudo nano ${ENV_FILE}"
echo "     Required: DATABASE_URL, REDIS_URL, JWT_SECRET, NEXTAUTH_SECRET,"
echo "               RPC_URL_*, OPENAI_API_KEY, ANTHROPIC_API_KEY"
echo ""
echo "  2. Point your DNS A records to this server's IP:"
echo "       api.agentfi.xyz   → $(curl -s ifconfig.me 2>/dev/null || echo '<this-server-ip>')"
echo "       admin.agentfi.xyz → same IP"
echo "       mcp.agentfi.xyz   → same IP"
echo ""
echo "  3. Obtain SSL certificates (nginx must be running, DNS must resolve):"
echo "       sudo certbot --nginx \\"
echo "         -d api.agentfi.xyz \\"
echo "         -d admin.agentfi.xyz \\"
echo "         -d mcp.agentfi.xyz"
echo ""
echo "  4. Deploy contracts with Foundry (as '${REAL_USER}'):"
echo "       cd <repo>/packages/contracts"
echo "       forge script script/Deploy.s.sol --rpc-url \$RPC_URL_BASE --broadcast"
echo "     Then update VAULT_FACTORY_ADDRESS and AGENT_REGISTRY_ADDRESS in ${ENV_FILE}"
echo ""
echo "  5. Start AgentFi:"
echo "       sudo systemctl start agentfi"
echo "       sudo journalctl -u agentfi -f"
echo ""
echo -e "${GREEN}Done.${NC}"
