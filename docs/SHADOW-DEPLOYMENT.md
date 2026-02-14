# Shadow Commercial Deployment Guide

Complete guide for deploying Proliferate as "Shadow" - a cost-optimized AI employee platform.

## Overview

Shadow is a commercially-deployed version of Proliferate with:
- **Supabase** for managed PostgreSQL
- **VPS-based sandboxes** for 90%+ cost reduction
- **Profitable pricing** with 90%+ margins

## Cost Analysis

### Infrastructure Costs (per month)

| Component | Provider | Cost | Notes |
|-----------|----------|------|-------|
| Database | Supabase Pro | $25 | Managed Postgres + Auth |
| App Hosting | Railway/Render | $20 | Next.js + API |
| Redis | Upstash | $10 | Job queues |
| VPS Host | Hetzner CPX31 | $26 | 4 vCPU, 8GB RAM |
| **Total** | | **$81/month** | Base infrastructure |

### Revenue Model

| Plan | Price | Credits | Sessions | Margin |
|------|-------|---------|----------|--------|
| Free | $0 | 100 | 1 | N/A |
| Developer | $29/mo | 2,000 | 5 | ~95% |
| Team | $99/mo | 8,000 | 20 | ~97% |
| Enterprise | $499/mo | 50,000 | Unlimited | ~98% |

### Unit Economics

- **Compute cost**: $0.032/hour (VPS)
- **Compute price**: $0.60/hour (customer)
- **Compute margin**: 95%

**Break-even**: ~135 hours of sandbox usage/month

## Deployment Steps

### Phase 1: Database Setup

```bash
# 1. Create Supabase project
npx supabase projects create shadow-production \
  --org-id your-org-id \
  --region us-east-1

# 2. Get connection string
# Dashboard → Settings → Database → Connection String

# 3. Add to environment
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
```

### Phase 2: VPS Host Setup

```bash
# 1. Create Hetzner server
# Type: CPX31 (4 vCPU, 8GB RAM, 160GB NVMe)
# Cost: €23.39/month

# 2. SSH into server
ssh root@your-vps-ip

# 3. Install Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker root

# 4. Create directories
mkdir -p /var/shadow/sandboxes
mkdir -p /opt/shadow

# 5. Clone repository
cd /opt/shadow
git clone https://github.com/your-org/shadow.git
cd shadow

# 6. Build base image
cd packages/vps-sandbox
docker build -t shadow-sandbox:latest .
```

### Phase 3: Environment Configuration

```bash
# Create .env file
cat > .env << 'EOF'
# Deployment
DEPLOYMENT_PROFILE=self_host

# Database (Supabase)
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres

# Redis (Upstash)
REDIS_URL=rediss://default:[PASSWORD]@[HOST]:6379

# Core Secrets
BETTER_AUTH_SECRET=your-secret
SERVICE_TO_SERVICE_AUTH_TOKEN=your-token
GATEWAY_JWT_SECRET=your-jwt-secret
USER_SECRETS_ENCRYPTION_KEY=your-encryption-key

# Public URLs
NEXT_PUBLIC_APP_URL=https://shadow.yourdomain.com
NEXT_PUBLIC_API_URL=https://shadow.yourdomain.com
NEXT_PUBLIC_GATEWAY_URL=wss://gateway.shadow.yourdomain.com

# Sandbox Provider
DEFAULT_SANDBOX_PROVIDER=vps
VPS_HOST=your-vps-ip
VPS_SSH_USER=root
VPS_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----"
VPS_BASE_IMAGE=shadow-sandbox:latest
VPS_DATA_VOLUME=/var/shadow/sandboxes

# LLM
ANTHROPIC_API_KEY=sk-ant-...

# GitHub App
GITHUB_APP_ID=your-app-id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET=your-webhook-secret
NEXT_PUBLIC_GITHUB_APP_SLUG=shadow-app

# Billing (Autumn)
NEXT_PUBLIC_BILLING_ENABLED=true
AUTUMN_API_URL=https://api.autumn.com
AUTUMN_API_KEY=your-autumn-key
BILLING_JWT_SECRET=your-billing-jwt

# Email (Resend)
EMAIL_ENABLED=true
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@shadow.yourdomain.com
EOF
```

### Phase 4: Deploy Application

**Option A: Railway (Recommended)**
```bash
# 1. Install Railway CLI
npm i -g @railway/cli

# 2. Login
railway login

# 3. Initialize project
railway init

# 4. Deploy
railway up
```

**Option B: Render**
```bash
# 1. Create render.yaml
# 2. Deploy via Git integration
# Dashboard → New → Blueprint
```

**Option C: Self-hosted (Docker Compose)**
```bash
# On your VPS or separate server
docker compose -f docker-compose.prod.yml up -d
```

### Phase 5: Gateway Deployment

The Gateway needs to be accessible via WebSocket:

```bash
# Option A: Same as web app (Railway/Render handle this)

# Option B: Separate VPS
docker run -d \
  --name shadow-gateway \
  -p 8787:8787 \
  -e DATABASE_URL=... \
  -e REDIS_URL=... \
  -e GATEWAY_JWT_SECRET=... \
  shadow-gateway:latest
```

### Phase 6: DNS & SSL

```bash
# Cloudflare DNS Records
A     shadow.yourdomain.com    → Railway/Render IP
A     gateway.shadow.yourdomain.com → VPS IP
CNAME www.shadow.yourdomain.com → shadow.yourdomain.com
```

### Phase 7: Billing Setup

1. **Create Autumn Account**
   ```bash
   # Sign up at https://useautumn.com
   # Get API key from dashboard
   ```

2. **Configure Products**
   ```bash
   # Via Autumn Dashboard or API
   
   # Dev Plan: $20/month, 1,000 credits
   # Pro Plan: $500/month, 7,500 credits
   # Top-up: $5 for 500 credits
   ```

3. **Stripe Integration**
   - Connect Stripe account to Autumn
   - Configure webhooks
   - Set up checkout flows

### Phase 8: Monitoring

```bash
# Install Sentry for error tracking
npm install @sentry/nextjs

# Configure in next.config.js
const { withSentryConfig } = require("@sentry/nextjs");

# Add to environment
NEXT_PUBLIC_SENTRY_DSN=https://...@sentry.io/...
SENTRY_AUTH_TOKEN=...
```

## Scaling Strategy

### Vertical Scaling (Single VPS)

```
CPX31 (4 vCPU, 8GB)  → 2 concurrent sessions
CPX41 (8 vCPU, 16GB) → 4 concurrent sessions
CPX51 (16 vCPU, 32GB) → 8 concurrent sessions
```

### Horizontal Scaling (Multi-VPS)

```typescript
// Extend VPSProvider to support multiple hosts
class VPSClusterProvider {
  private hosts = [
    new VPSProvider("vps-1.yourdomain.com"),
    new VPSProvider("vps-2.yourdomain.com"),
    new VPSProvider("vps-3.yourdomain.com"),
  ];
  
  async createSandbox(opts) {
    const host = await this.selectLeastLoadedHost();
    return host.createSandbox(opts);
  }
}
```

### Auto-scaling with Kubernetes

For enterprise deployments, use the existing Helm charts with VPS nodes:

```yaml
# values.yaml for VPS deployment
sandbox:
  provider: vps
  vps:
    hosts:
      - host: vps-1.internal
        sshKeySecret: vps-ssh-key
      - host: vps-2.internal
        sshKeySecret: vps-ssh-key
```

## Security Checklist

- [ ] Rotate all secrets (not using defaults)
- [ ] Enable email verification
- [ ] Configure GitHub App webhook secret
- [ ] Set up Sentry for error tracking
- [ ] Enable database backups (Supabase)
- [ ] Configure Redis persistence (Upstash)
- [ ] Set up VPS firewall (allow only necessary ports)
- [ ] Enable SSH key-only authentication
- [ ] Configure log retention
- [ ] Set up billing limits/alerts

## Troubleshooting

### Database Connection Issues
```bash
# Test Supabase connection
psql $DATABASE_URL -c "SELECT 1"

# Check connection pool settings
# Supabase Dashboard → Database → Connection Pooling
```

### VPS Connection Issues
```bash
# Test SSH connection
ssh -i ~/.ssh/shadow_key root@your-vps-ip "docker ps"

# Check VPS provider logs
ssh root@your-vps-ip "docker logs shadow-session-id"
```

### Billing Issues
```bash
# Check Autumn integration
curl -H "Authorization: Bearer $AUTUMN_API_KEY" \
  https://api.useautumn.com/v1/customers
```

## Migration from Proliferate

1. **Database Migration**
   ```bash
   # Export from existing Postgres
   pg_dump $OLD_DATABASE_URL > backup.sql
   
   # Import to Supabase
   psql $DATABASE_URL < backup.sql
   ```

2. **Switch Providers**
   ```bash
   # Update .env
   DEFAULT_SANDBOX_PROVIDER=vps
   
   # Drain Modal/E2B sessions
   # Wait for completion
   # Deploy VPS provider
   ```

3. **Rebranding**
   - Update logo in `apps/web/public/`
   - Change app name in `apps/web/src/app/layout.tsx`
   - Update color scheme in `globals.css`

## Support

- **Documentation**: https://docs.shadow.dev
- **Community**: https://discord.gg/shadow
- **Enterprise**: enterprise@shadow.dev
