#!/usr/bin/env python3
"""Generates the demo workspace used for Thumbview screenshots, the accessibility audit, and demos.

    python3 scripts/generate-demo-workspace.py            # (re)creates demo-workspace/ in the repo
    python3 scripts/generate-demo-workspace.py <dir>      # creates it in <dir>, which must be empty

demo-workspace/ is gitignored; this tracked script is the source of its content. The default target
is deleted and recreated; any other target must be empty or missing, so a mistyped path is never wiped.
"""
import os
import shutil
import struct
import sys
import zlib

DEFAULT_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "demo-workspace")
ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ROOT


def write(relpath, content):
    path = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def clean():
    os.makedirs(ROOT, exist_ok=True)
    if ROOT != DEFAULT_ROOT and os.listdir(ROOT):
        sys.exit(f"refusing to overwrite non-empty directory: {ROOT}")
    for name in os.listdir(ROOT):
        if name == "generate.py":
            continue
        path = os.path.join(ROOT, name)
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)


# ---------------------------------------------------------------- root files
PACKAGE_JSON = """{
  "name": "nimbus-shop",
  "version": "2.4.1",
  "description": "Demo storefront API used for Thumbview screenshots",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "seed": "tsx scripts/seed.ts"
  },
  "dependencies": {
    "express": "^4.19.2",
    "zod": "^3.23.8",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "tsx": "^4.16.2",
    "typescript": "^5.5.3",
    "vitest": "^2.0.3"
  }
}
"""

README_MD = """# Nimbus Shop

A small demo storefront API.

## Quick start

```bash
npm install
npm run seed
npm run dev
```

The API listens on http://localhost:3000.

## Structure

- `src/` — Express server, routes, middleware, models
- `web/` — static storefront assets
- `scripts/` — maintenance and data scripts
- `docs/` — API and architecture notes
- `generated/` — machine-generated client SDK (ignored in Thumbview)
"""

TSCONFIG = """{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
"""

GITIGNORE = "node_modules/\ndist/\nlogs/\n*.local\n"

LICENSE = "MIT License\n\nCopyright (c) 2026 Nimbus Demo\n"

# ------------------------------------------------------------------- src/
INDEX_TS = """import express from "express";
import { loadConfig } from "./config";
import { authMiddleware } from "./middleware/auth";
import { requestLogger } from "./middleware/logger";
import { userRouter } from "./routes/users";
import { orderRouter } from "./routes/orders";

const config = loadConfig();
const app = express();

app.use(express.json());
app.use(requestLogger);
app.use(authMiddleware);

app.use("/api/users", userRouter);
app.use("/api/orders", orderRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.listen(config.port, () => {
  console.log(`nimbus-shop listening on :${config.port}`);
});
"""

CONFIG_TS = """export interface AppConfig {
  port: number;
  jwtSecret: string;
  databaseUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret",
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost/nimbus",
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
  };
}
"""


def server_ts():
    """Tall file (~260 lines) so the spanning grid shows a tall tile."""
    out = ["""import { Router, Request, Response } from "express";
import { db } from "../models/db";
import { requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";

export const adminRouter = Router();

// ---------------------------------------------------------------------------
// Admin endpoints. Every handler follows the same shape:
//   1. parse + validate input
//   2. run the query
//   3. map the result to a response DTO
// ---------------------------------------------------------------------------
"""]
    for i, (name, table) in enumerate([
        ("Products", "products"), ("Categories", "categories"),
        ("Coupons", "coupons"), ("Shipments", "shipments"),
        ("Refunds", "refunds"), ("Invoices", "invoices"),
        ("Reviews", "reviews"), ("Warehouses", "warehouses"),
        ("Suppliers", "suppliers"), ("Campaigns", "campaigns"),
    ]):
        out.append(f"""export async function list{name}(req: Request, res: Response) {{
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Number(req.query.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const rows = await db.{table}.findMany({{
    skip: offset,
    take: pageSize,
    orderBy: {{ createdAt: "desc" }},
  }});
  const total = await db.{table}.count();

  res.json({{
    data: rows,
    pagination: {{ page, pageSize, total, pages: Math.ceil(total / pageSize) }},
  }});
}}

adminRouter.get("/{table}", requireRole("admin"), validate("query"), list{name});
""")
    return "\n".join(out)


AUTH_TS = """import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { loadConfig } from "../config";

const { jwtSecret } = loadConfig();

export interface AuthToken {
  userId: string;
  role: "customer" | "support" | "admin";
  issuedAt: number;
  expiresAt: number;
}

/** Verifies the Bearer token and attaches the decoded AuthToken to req.auth. */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing auth token" });
  }

  const token = header.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, jwtSecret) as AuthToken;
    if (decoded.expiresAt * 1000 < Date.now()) {
      return res.status(401).json({ error: "auth token expired" });
    }
    (req as any).auth = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "invalid auth token" });
  }
}

/** Restricts a route to the given role. Must run after authMiddleware. */
export function requireRole(role: AuthToken["role"]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as any).auth as AuthToken | undefined;
    if (!auth) return res.status(401).json({ error: "unauthenticated" });
    if (auth.role !== role && auth.role !== "admin") {
      return res.status(403).json({ error: `requires ${role} role` });
    }
    next();
  };
}

/** Issues a signed token for a user id + role, valid for 12 hours. */
export function issueToken(userId: string, role: AuthToken["role"]): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthToken = {
    userId,
    role,
    issuedAt: now,
    expiresAt: now + 12 * 60 * 60,
  };
  return jwt.sign(payload, jwtSecret);
}

/** Sliding-session refresh: returns a new token if less than 2h remain. */
export function maybeRefreshToken(auth: AuthToken): string | null {
  const secondsLeft = auth.expiresAt - Math.floor(Date.now() / 1000);
  if (secondsLeft > 2 * 60 * 60) return null;
  return issueToken(auth.userId, auth.role);
}
"""

LOGGER_TS = """import { Request, Response, NextFunction } from "express";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
}
"""

VALIDATE_TS = """import { Request, Response, NextFunction } from "express";

type Part = "body" | "query" | "params";

export function validate(part: Part) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req[part] == null) {
      return res.status(400).json({ error: `missing ${part}` });
    }
    next();
  };
}
"""

USERS_TS = """import { Router } from "express";
import { db } from "../models/db";
import { issueToken, requireRole } from "../middleware/auth";

export const userRouter = Router();

userRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await db.users.findByEmail(email);
  if (!user || !user.verifyPassword(password)) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  res.json({ token: issueToken(user.id, user.role) });
});

userRouter.get("/me", async (req, res) => {
  const auth = (req as any).auth;
  const user = await db.users.findById(auth.userId);
  res.json(user.toPublicJSON());
});

userRouter.get("/", requireRole("support"), async (_req, res) => {
  res.json(await db.users.findMany({ take: 50 }));
});
"""

ORDERS_TS = """import { Router } from "express";
import { db } from "../models/db";

export const orderRouter = Router();

orderRouter.post("/", async (req, res) => {
  const auth = (req as any).auth;
  const order = await db.orders.create({
    userId: auth.userId,
    items: req.body.items,
  });
  res.status(201).json(order);
});

orderRouter.get("/:id", async (req, res) => {
  const auth = (req as any).auth;
  const order = await db.orders.findById(req.params.id);
  if (!order || (order.userId !== auth.userId && auth.role !== "admin")) {
    return res.status(404).json({ error: "order not found" });
  }
  res.json(order);
});
"""

DB_TS = """// In-memory stand-in for a real database client.
// Keeps the demo runnable with zero external services.

export const db = {
  users: table("users"),
  orders: table("orders"),
  products: table("products"),
  categories: table("categories"),
  coupons: table("coupons"),
  shipments: table("shipments"),
  refunds: table("refunds"),
  invoices: table("invoices"),
  reviews: table("reviews"),
  warehouses: table("warehouses"),
  suppliers: table("suppliers"),
  campaigns: table("campaigns"),
};

function table(name: string): any {
  const rows: any[] = [];
  return {
    findMany: (opts: any = {}) => rows.slice(opts.skip ?? 0, (opts.skip ?? 0) + (opts.take ?? rows.length)),
    findById: (id: string) => rows.find((r) => r.id === id) ?? null,
    findByEmail: (email: string) => rows.find((r) => r.email === email) ?? null,
    create: (data: any) => { const row = { id: `${name}_${rows.length}`, ...data }; rows.push(row); return row; },
    count: () => rows.length,
  };
}
"""

# ------------------------------------------------------------------- web/
APP_JS = """const cart = [];

async function fetchProducts(page = 1) {
  const res = await fetch(`/api/admin/products?page=${page}`, {
    headers: { authorization: `Bearer ${sessionStorage.token}` },
  });
  if (!res.ok) throw new Error(`products failed: ${res.status}`);
  return res.json();
}

function renderProducts({ data, pagination }) {
  const grid = document.querySelector("#product-grid");
  grid.innerHTML = "";
  for (const p of data) {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `<h3>${p.name}</h3><p>$${p.price}</p>`;
    card.onclick = () => addToCart(p);
    grid.appendChild(card);
  }
  document.querySelector("#page-label").textContent =
    `Page ${pagination.page} of ${pagination.pages}`;
}

function addToCart(product) {
  cart.push(product);
  document.querySelector("#cart-count").textContent = cart.length;
}

fetchProducts().then(renderProducts).catch(console.error);
"""

STYLES_CSS = """:root {
  --bg: #0f172a;
  --panel: #1e293b;
  --accent: #a855f7;
  --accent-2: #f472b6;
  --text: #e2e8f0;
}

body {
  margin: 0;
  font-family: "Inter", system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
}

#product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  padding: 24px;
}

.product-card {
  background: var(--panel);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.product-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent-2);
}

#cart-count {
  background: var(--accent);
  border-radius: 999px;
  padding: 2px 10px;
  font-weight: 700;
}
"""

INDEX_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Nimbus Shop</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header>
      <h1>Nimbus Shop</h1>
      <span id="cart-count">0</span>
    </header>
    <main id="product-grid"></main>
    <footer><span id="page-label"></span></footer>
    <script src="app.js"></script>
  </body>
</html>
"""

# --------------------------------------------------------------- scripts/
BACKUP_PY = '''#!/usr/bin/env python3
"""Nightly backup: dumps each table to a timestamped JSONL archive."""
import json
import os
import time

TABLES = ["users", "orders", "products", "invoices", "shipments"]
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "backups")


def dump_table(table: str, out_dir: str) -> str:
    path = os.path.join(out_dir, f"{table}.jsonl")
    rows = fetch_all(table)
    with open(path, "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\\n")
    return path


def fetch_all(table: str) -> list:
    # Placeholder: in the real deployment this pages through the API.
    return [{"table": table, "seq": i} for i in range(100)]


def main() -> None:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(OUT_DIR, stamp)
    os.makedirs(out_dir, exist_ok=True)
    for table in TABLES:
        path = dump_table(table, out_dir)
        print(f"backed up {table:12s} -> {path}")


if __name__ == "__main__":
    main()
'''

ANALYZE_PY = '''#!/usr/bin/env python3
"""Weekly sales analysis: revenue, top products, refund rate."""
import json
import sys
from collections import Counter
from pathlib import Path


def load_jsonl(path: Path) -> list:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def top_products(orders: list, n: int = 5) -> list:
    counts = Counter()
    for order in orders:
        for item in order.get("items", []):
            counts[item["sku"]] += item.get("qty", 1)
    return counts.most_common(n)


def refund_rate(orders: list, refunds: list) -> float:
    if not orders:
        return 0.0
    return round(100.0 * len(refunds) / len(orders), 2)


def main(backup_dir: str) -> None:
    base = Path(backup_dir)
    orders = load_jsonl(base / "orders.jsonl")
    refunds = load_jsonl(base / "refunds.jsonl")
    print("top products:", top_products(orders))
    print("refund rate: ", refund_rate(orders, refunds), "%")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../backups/latest")
'''

SEED_TS = """import { db } from "../src/models/db";

const SKUS = ["mug", "tee", "hoodie", "cap", "sticker", "poster"];

async function main() {
  for (let i = 0; i < 40; i++) {
    await db.products.create({
      sku: `${SKUS[i % SKUS.length]}-${i}`,
      name: `Demo Product ${i}`,
      price: (5 + (i % 20)) * 1.99,
      stock: 100 - i,
    });
  }
  console.log("seeded 40 products");
}

main();
"""

# ------------------------------------------------------------------- docs/
API_MD = """# API Reference

Base URL: `/api`

## Auth

All endpoints require `Authorization: Bearer <token>` unless marked public.
Obtain a token via `POST /api/users/login`.

## Endpoints

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | /health | public | Liveness probe |
| POST | /api/users/login | public | Issue an auth token |
| GET | /api/users/me | any | Current user profile |
| GET | /api/users | support | List users (max 50) |
| POST | /api/orders | any | Place an order |
| GET | /api/orders/:id | owner/admin | Fetch one order |
| GET | /api/admin/* | admin | Paginated admin listings |

## Pagination

Admin listings accept `?page=` and `?pageSize=` (max 100) and return a
`pagination` envelope with `total` and `pages`.
"""

ARCH_MD = """# Architecture Notes

## Request pipeline

```
express.json -> requestLogger -> authMiddleware -> router
```

- `authMiddleware` verifies the Bearer JWT and attaches `req.auth`.
- `requireRole` gates admin/support routes.
- Every admin handler is generated from the same parse/query/respond shape.

## Why in-memory db?

The demo must run with zero external services, so `models/db.ts` implements
the same interface over arrays. Swap it for a real client later.
"""

# ------------------------------------------------------------- generated/
def generated_files():
    """35 tiny files -> triggers thumbview.autoIgnoreThreshold (default 30)."""
    for i in range(35):
        write(f"generated/sdk/client_{i:02d}.ts", f"""// AUTO-GENERATED by openapi-codegen. Do not edit.
export interface Client{i:02d}Options {{
  baseUrl: string;
  token?: string;
}}

export class Client{i:02d} {{
  constructor(private opts: Client{i:02d}Options) {{}}

  async get(path: string) {{
    const res = await fetch(this.opts.baseUrl + path, {{
      headers: {{ authorization: `Bearer ${{this.opts.token}}` }},
    }});
    return res.json();
  }}
}}
""")


# ----------------------------------------------------------------- build/
def build_files():
    """A handful of build artifacts to ignore manually during the demo."""
    write("build/bundle.js", "// minified bundle placeholder\n" + "\n".join(
        f"function m{i}(){{return {i};}}" for i in range(60)))
    write("build/bundle.js.map", '{"version":3,"sources":["../src/index.ts"],"mappings":""}\n')
    write("build/styles.min.css", STYLES_CSS.replace("\n", "").replace("  ", ""))


# ------------------------------------------------------------------- logs/
def log_files():
    lines = [
        "2026-08-04T09:00:01Z info  server starting on :3000",
        "2026-08-04T09:00:02Z info  connected to postgres://localhost/nimbus",
        "2026-08-04T09:01:15Z info  GET /health -> 200 (1ms)",
        "2026-08-04T09:02:44Z warn  POST /api/users/login -> 401 (12ms) invalid credentials",
        "2026-08-04T09:03:02Z info  POST /api/users/login -> 200 (45ms)",
        "2026-08-04T09:03:05Z info  GET /api/admin/products -> 200 (8ms)",
        "2026-08-04T09:04:51Z error GET /api/orders/ord_99 -> 500 (103ms) unhandled rejection",
        "2026-08-04T09:04:51Z error stack: Error: connection reset",
        "2026-08-04T09:05:00Z info  GET /api/orders/ord_99 -> 200 (22ms)",
    ]
    write("logs/app.log", "\n".join(lines) + "\n")
    write("logs/error.log", "\n".join(l for l in lines if "error" in l) + "\n")


# ----------------------------------------------------------------- assets/
def png(path, w, h, c1, c2):
    """Minimal gradient PNG writer (no dependencies)."""
    raw = b""
    for y in range(h):
        raw += b"\x00"
        for x in range(w):
            t = (x + y) / (w + h)
            raw += bytes(int(a + (b - a) * t) for a, b in zip(c1, c2))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    png_bytes = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                 + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png_bytes)


def asset_files():
    png(os.path.join(ROOT, "assets", "logo.png"), 128, 128, (168, 85, 247), (244, 114, 182))
    png(os.path.join(ROOT, "assets", "banner.png"), 480, 120, (15, 23, 42), (168, 85, 247))
    # A tiny single-page PDF (renders via thumbview.renderMediaThumbnails)
    pdf = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 78>>stream
BT /F1 24 Tf 40 90 Td (Nimbus Catalog) Tj 0 -34 Td /F1 12 Tf (Spring 2026 price list) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF"""
    path = os.path.join(ROOT, "assets", "catalog.pdf")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(pdf)


def main():
    clean()
    # root
    write("package.json", PACKAGE_JSON)
    write("README.md", README_MD)
    write("tsconfig.json", TSCONFIG)
    write(".gitignore", GITIGNORE)
    write("LICENSE", LICENSE)
    # src
    write("src/index.ts", INDEX_TS)
    write("src/config.ts", CONFIG_TS)
    write("src/server.ts", server_ts())
    write("src/middleware/auth.ts", AUTH_TS)
    write("src/middleware/logger.ts", LOGGER_TS)
    write("src/middleware/validate.ts", VALIDATE_TS)
    write("src/routes/users.ts", USERS_TS)
    write("src/routes/orders.ts", ORDERS_TS)
    write("src/models/db.ts", DB_TS)
    # web
    write("web/app.js", APP_JS)
    write("web/styles.css", STYLES_CSS)
    write("web/index.html", INDEX_HTML)
    # scripts
    write("scripts/backup.py", BACKUP_PY)
    write("scripts/analyze.py", ANALYZE_PY)
    write("scripts/seed.ts", SEED_TS)
    # docs
    write("docs/api.md", API_MD)
    write("docs/architecture.md", ARCH_MD)
    # feature-demo folders
    generated_files()
    build_files()
    log_files()
    asset_files()
    print("demo workspace generated")


if __name__ == "__main__":
    main()
