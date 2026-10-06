# Precision Ingest Server Deployment (`precision.usask.ca`)

This guide explains how to set up the Canadian telemetry database and ingestion service on `precision.usask.ca` (University of Saskatchewan).

## 1. SSH into precision.usask.ca

```bash
ssh <your-username>@precision.usask.ca
```

## 2. PostgreSQL Setup

Ensure PostgreSQL is installed and running:
```bash
sudo apt update && sudo apt install -y postgresql postgresql-contrib
```

Create database and user:
```bash
sudo -u postgres psql
```
In psql:
```sql
CREATE DATABASE thumbview_study;
CREATE USER thumbview_user WITH ENCRYPTED PASSWORD 'choose_a_strong_password';
GRANT ALL PRIVILEGES ON DATABASE thumbview_study TO thumbview_user;
\c thumbview_study
GRANT ALL ON SCHEMA public TO thumbview_user;
\q
```

Initialize the relational schema and analysis views:
```bash
psql -U thumbview_user -d thumbview_study -h localhost -f ../schema.sql
psql -U thumbview_user -d thumbview_study -h localhost -f ../analysis.sql
```

## 3. Ingestion Service Setup

1. Copy the `study/server` files to `/opt/thumbview-study/server`:
```bash
sudo mkdir -p /opt/thumbview-study/server
sudo cp server.js package.json /opt/thumbview-study/server/
cd /opt/thumbview-study/server
sudo npm install --production
```

2. Configure systemd service:
Copy `thumbview-ingest.service` to `/etc/systemd/system/thumbview-ingest.service`:
```bash
sudo cp thumbview-ingest.service /etc/systemd/system/
```
Edit the environment variables (e.g. database password, port) in `/etc/systemd/system/thumbview-ingest.service`.

3. Enable and start service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable thumbview-ingest
sudo systemctl start thumbview-ingest
sudo systemctl status thumbview-ingest
```

Test health endpoint:
```bash
curl http://localhost:3000/health
# {"status":"ok","time":"..."}
```

## 4. HTTPS / Reverse Proxy Configuration (Nginx)

In `/etc/nginx/sites-available/precision.usask.ca` (or your reverse proxy):
```nginx
location /study/api/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
Reload nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

Verify externally:
```bash
curl https://precision.usask.ca/study/api/health
```

The extension in `src/study/study_config.ts` points to:
`ingestUrl: "https://precision.usask.ca/study/api"`
