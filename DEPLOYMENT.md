# OpusMax Proxy Deployment Guide

## Architecture

```
Internet
   |
   v
DNS: opusmax.pro
   |
   v
nginx :443 (HTTPS)
   |
   v
Node.js/Express :3000 (localhost only)
   |
   +-- SQLite: ./data/opusmax.db
   +-- Anthropic API: https://api.anthropic.com
```

## Prerequisites

- AWS EC2 instance (t2.micro or t3.micro, Ubuntu 22.04 LTS recommended)
- Domain `opusmax.pro` with DNS access
- SSH key pair for instance access

## Step 1: Launch EC2 Instance

```bash
# Using AWS CLI (adjust as needed)
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \  # Ubuntu 22.04 LTS (us-east-1)
  --instance-type t2.micro \
  --key-name your-key-pair \
  --security-group-ids sg-xxxxxxxxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=opusmax-proxy}]'
```

## Step 2: Configure Security Group

Allow only:
- SSH (port 22) — your IP only
- HTTP (port 80) — 0.0.0.0/0
- HTTPS (port 443) — 0.0.0.0/0

**Do NOT open port 3000 to the internet.** Node.js only binds to localhost.

## Step 3: SSH and Setup

```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>
```

## Step 4: Install Dependencies

```bash
# Update
sudo apt update && sudo apt upgrade -y

# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install nginx
sudo apt install -y nginx

# Install PM2
sudo npm install -g pm2

# Install certbot for Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx

# Verify
node --version  # should be >= 20.0.0
npm --version
nginx -v
pm2 --version
```

## Step 5: Deploy Application

```bash
# Clone or copy the application
cd /opt
sudo git clone <your-repo-url> opusmax-proxy
cd opusmax-proxy

# Create data directory
mkdir -p data

# Install dependencies
npm install

# Create .env file
sudo nano .env
```

.env contents:
```
ANTHROPIC_API_KEY=sk-ant-your-actual-key
ADMIN_SECRET=your-strong-admin-secret
DATABASE_PATH=./data/opusmax.db
PORT=3000
NODE_ENV=production
```

## Step 6: Test Server Startup

```bash
# Test the server starts correctly
sudo -E NODE_ENV=production ANTHROPIC_API_KEY=your-key ADMIN_SECRET=your-secret node src/index.js

# Ctrl+C to stop, then verify it works
curl http://localhost:3000/health
```

## Step 7: Configure nginx

Copy the nginx config:
```bash
sudo cp nginx/opusmax.conf /etc/nginx/sites-available/opusmax.conf
sudo ln -sf /etc/nginx/sites-available/opusmax.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

Edit `/etc/nginx/sites-available/opusmax.conf` and replace `opusmax.pro` with your actual domain if different.

Test and reload nginx:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Step 8: Obtain TLS Certificate

```bash
sudo certbot --nginx -d opusmax.pro -d www.opusmax.pro

# Test auto-renewal
sudo certbot renew --dry-run
```

## Step 9: Start Application with PM2

```bash
cd /opt/opusmax-proxy
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow the printed instructions to enable on boot
```

Verify:
```bash
pm2 status
pm2 logs opusmax-proxy  # should show "OpusMax Proxy listening..."
curl https://opusmax.pro/health
```

## Step 10: Configure DNS

Point `opusmax.pro` to your EC2 instance's public IP:

- **A record**: `opusmax.pro` → `<EC2_PUBLIC_IP>`
- **A record**: `www.opusmax.pro` → `<EC2_PUBLIC_IP>` (optional)

## Step 11: Verify Everything

```bash
# Health check
curl https://opusmax.pro/health

# Admin dashboard
# Visit https://opusmax.pro in browser (should redirect to /dashboard.html)

# Test admin API
curl -H "Authorization: Bearer YOUR_ADMIN_SECRET" https://opusmax.pro/admin/keys

# Test proxy endpoint (should return 401 without key)
curl -X POST https://opusmax.pro/v1/messages
```

## Updating

```bash
cd /opt/opusmax-proxy
git pull origin main
npm install
pm2 restart opusmax-proxy
```

## Rollback

```bash
cd /opt/opusmax-proxy
git log --oneline -5  # find the previous commit
git revert HEAD
pm2 restart opusmax-proxy
```
