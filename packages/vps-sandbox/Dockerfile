# Shadow VPS Sandbox Base Image
#
# Cost-optimized Docker image for VPS-based sandboxes.
# Includes OpenCode, Caddy, and all dependencies.
#
# Build:
#   docker build -t shadow-sandbox:latest .
#
# Usage:
#   This image is used by the VPS provider to create sandbox containers.

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    ca-certificates \
    build-essential \
    python3 \
    python3-pip \
    jq \
    openssh-server \
    caddy \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash user && \
    usermod -aG sudo user && \
    echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Install OpenCode
# OpenCode is the coding agent that runs inside the sandbox
RUN npm install -g opencode

# Install common development tools globally
RUN npm install -g \
    typescript \
    tsx \
    pnpm \
    @anthropic-ai/claude-cli

# Set up working directories
RUN mkdir -p /workspace && chown user:user /workspace
RUN mkdir -p /home/user/.config/opencode && chown -R user:user /home/user/.config
RUN mkdir -p /home/user/.proliferate && chown -R user:user /home/user/.proliferate

# Configure SSH
RUN mkdir -p /var/run/sshd
RUN echo 'PermitRootLogin no' >> /etc/ssh/sshd_config
RUN echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
RUN echo 'PubkeyAuthentication yes' >> /etc/ssh/sshd_config

# Sandbox MCP (sidecar HTTP server) - port 4000
# This provides the HTTP API and terminal WebSocket for the gateway
WORKDIR /app

# Copy and install sandbox-mcp
COPY --from=sandbox-mcp:latest /app /app/sandbox-mcp
RUN cd /app/sandbox-mcp && npm install --production

# Ports used by the sandbox
# 3000: OpenCode API
# 8080: Caddy preview proxy
# 4000: Sandbox MCP (sidecar)
EXPOSE 3000 8080 4000 22

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Switch to non-root user for main process
USER user

# Working directory
WORKDIR /workspace

# Default command - starts SSH and OpenCode
# The VPS provider will override this with specific startup commands
CMD ["bash", "-c", "sudo service ssh start && tail -f /dev/null"]
