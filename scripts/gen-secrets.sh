#!/usr/bin/env bash
# =============================================================================
# AgentFi — Secret Generator
# =============================================================================
# Generates all random secrets needed for AgentFi and prints them ready to
# paste into your .env file.
#
# Usage:
#   chmod +x scripts/gen-secrets.sh
#   ./scripts/gen-secrets.sh
#
# WARNING: These are one-time generated secrets. Store them safely —
#          you cannot recover them.
# =============================================================================

set -euo pipefail

echo ""
echo "# WARNING: These are one-time generated secrets. Store them safely —"
echo "# you cannot recover them."
echo ""
echo "# Generated secrets — paste into your .env file"
echo ""
echo "# Server"
echo "API_SECRET=$(openssl rand -hex 32)"
echo ""
echo "# Admin Dashboard"
echo "ADMIN_SECRET=$(openssl rand -hex 32)"
echo ""
echo "# NextAuth (admin frontend)"
echo "NEXTAUTH_SECRET=$(openssl rand -hex 32)"
echo ""
