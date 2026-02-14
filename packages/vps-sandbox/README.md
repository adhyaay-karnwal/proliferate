# VPS Sandbox Provider

Cost-optimized sandbox provider using Docker containers on VPS hosts. Ideal for commercial deployments where Modal/E2B costs are prohibitive.

## Cost Comparison

| Provider | Cost/Hour | Margin at $0.60/hour |
|----------|-----------|---------------------|
| Modal | $0.12-0.50 | 17-80% |
| E2B | $0.10-0.30 | 50-83% |
| **VPS (Hetzner)** | **$0.03-0.05** | **92-95%** |
| **VPS (AWS Spot)** | **$0.02-0.04** | **93-97%** |

## Quick Start

### 1. Set up VPS Host

**Hetzner Cloud (Recommended):**
```bash
# Create CPX31 instance (4 vCPU, 8GB RAM, 160GB NVMe)
# Cost: €23.39/month (~$0.032/hour)

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Create data directory
sudo mkdir -p /var/shadow/sandboxes
sudo chown -R $USER:$USER /var/shadow
```

### 2. Build Base Image

```bash
cd packages/vps-sandbox
docker build -t shadow-sandbox:latest .
```

### 3. Configure Environment

```bash
# Add to .env
DEFAULT_SANDBOX_PROVIDER=vps
VPS_HOST=your-vps-ip-or-hostname
VPS_SSH_USER=root
VPS_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----
...your key...
-----END OPENSSH PRIVATE KEY-----"
VPS_BASE_IMAGE=shadow-sandbox:latest
VPS_DATA_VOLUME=/var/shadow/sandboxes
```

### 4. Test

```bash
# Verify connection
node -e "
const { VPSProvider } = require('@proliferate/shared/providers');
const provider = new VPSProvider();
provider.health().then(ok => console.log('Health:', ok));
"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     VPS Host                                │
│                     (Hetzner/AWS/GCP)                       │
├─────────────────────────────────────────────────────────────┤
│  Docker Daemon                                              │
│  ├── Container: shadow-session-abc123 (OpenCode + MCP)     │
│  ├── Container: shadow-session-def456                      │
│  └── Volume: /var/shadow/sandboxes/abc123                  │
└─────────────────────────────────────────────────────────────┘
                              │
                    SSH Connection
                              │
┌─────────────────────────────────────────────────────────────┐
│                     Shadow Platform                         │
│  (Web + Gateway + Worker)                                   │
└─────────────────────────────────────────────────────────────┘
```

## Features

- ✅ **Pause/Resume**: Full support via Docker commit/run
- ✅ **SSH Access**: Direct SSH into sandboxes for debugging
- ✅ **File Sync**: Read/write files via Docker exec
- ✅ **Port Mapping**: Dynamic port allocation for previews
- ✅ **Multi-host**: Scale across multiple VPS instances

## Scaling

### Single Host
One VPS can run multiple sandboxes concurrently:
- CPX31 (4 vCPU, 8GB): 2 concurrent sandboxes
- CPX41 (8 vCPU, 16GB): 4 concurrent sandboxes
- CPX51 (16 vCPU, 32GB): 8 concurrent sandboxes

### Multi-Host (Future)
For larger deployments, extend `VPSProvider` to support multiple hosts:

```typescript
class VPSClusterProvider {
  private hosts: VPSProvider[];
  
  async createSandbox(opts) {
    // Load balance across hosts
    const host = this.selectLeastLoadedHost();
    return host.createSandbox(opts);
  }
}
```

## Security

- Containers run as non-root user
- SSH key authentication only
- Network isolation via Docker
- No persistent access between sessions

## Troubleshooting

```bash
# Check container status
ssh root@vps-host "docker ps"

# View container logs
ssh root@vps-host "docker logs shadow-session-id"

# Enter container for debugging
ssh root@vps-host "docker exec -it shadow-session-id bash"

# Clean up stopped containers
ssh root@vps-host "docker container prune -f"
```
