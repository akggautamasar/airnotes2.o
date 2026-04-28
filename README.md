# AirNotes 2.0

A Telegram-backed PDF & EPUB library — Samsung Notes–inspired, dark-first, distraction-free.

## Stack

| Layer    | Tech                                         |
|----------|----------------------------------------------|
| Frontend | React 18, Vite, Tailwind CSS, Framer Motion  |
| Readers  | pdfjs-dist (PDF), epub.js (EPUB)             |
| Backend  | FastAPI, Pyrogram (Telegram MTProto)         |
| Storage  | Telegram channel (files), IDB (progress)     |
| Deploy   | Render (backend) + Vercel (frontend)         |

---

## Quick Start

### 1 — Telegram Setup

1. Get API credentials → https://my.telegram.org/apps
2. Create a **private Telegram channel** and grab its ID
   - Forward any message from it to @userinfobot to see the ID
3. Create a bot via @BotFather — copy the token
4. Add the bot as an **admin** of your channel
5. Find your own Telegram user ID → @userinfobot

---

### 2 — Backend (Render)

```bash
cd backend
cp .env.example .env
# Fill in .env with your values
```

**Deploy on Render:**

1. Push repo to GitHub
2. Render → New Web Service → connect repo
3. Root directory: `backend`
4. Build: `pip install -r requirements.txt`
5. Start: `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1`
6. Add all env vars from `.env.example` in Render dashboard
7. Add a **Disk** mount at `/opt/render/project/src/backend/cache` (1 GB)
8. Deploy → copy the URL (e.g. `https://airnotes-backend.onrender.com`)

---

### 3 — Frontend (Vercel)

```bash
cd frontend
cp .env.example .env
# Set VITE_API_URL=https://your-backend.onrender.com/api
npm install
npm run dev        # local dev
npm run build      # production build
```

**Deploy on Vercel:**

1. Push repo to GitHub
2. Vercel → New Project → import repo
3. Root directory: `frontend`
4. Add env var: `VITE_API_URL = https://your-backend.onrender.com/api`
5. Deploy

---

### 4 — Upload Files

Send any PDF or EPUB to your bot in a **private DM** from your admin account.
The bot will auto-index it and it appears instantly in your library via SSE.

---

## Folder Locking

- Create a folder via the sidebar
- Hover the folder → ⋯ → **Lock folder**
- Set a password (hashed with SHA-256 + salt, never sent in plaintext)
- Locked folders show 🔒 and require the password each session

---

## Reading Progress

- PDF progress is saved per-page to IndexedDB automatically
- EPUB location (CFI) is saved on every page turn
- "Continue Reading" section shows in-progress files

---

## Environment Variables

### Backend (`backend/.env`)

| Variable               | Description                                        |
|------------------------|----------------------------------------------------|
| `API_ID`               | Telegram API ID from my.telegram.org               |
| `API_HASH`             | Telegram API hash                                  |
| `BOT_TOKENS`           | Comma-separated bot tokens                         |
| `STRING_SESSIONS`      | Optional Pyrogram string sessions (for >2GB files) |
| `STORAGE_CHANNEL`      | Channel ID (negative, e.g. -100123456789)          |
| `DATABASE_BACKUP_MSG_ID` | Message ID anchor for file scan               |
| `ADMIN_PASSWORD`       | Password for the web app login                     |
| `JWT_SECRET`           | Secret key for JWT tokens (use a long random str)  |
| `TELEGRAM_ADMIN_IDS`   | Your Telegram user ID(s), comma-separated          |
| `WEBSITE_URL`          | Your Render URL (for auto-ping)                    |
| `FRONTEND_URL`         | Your Vercel URL (for CORS)                         |

### Frontend (`frontend/.env`)

| Variable        | Description                    |
|-----------------|--------------------------------|
| `VITE_API_URL`  | `https://your-backend.onrender.com/api` |

---

## Features

- 📄 **PDF Viewer** — high-DPR canvas, smooth zoom, page nav, bookmarks, light/dark/sepia modes
- 📚 **EPUB Viewer** — epub.js, paginated, ToC, adjustable font size, dark/light toggle
- 📁 **Folder system** — create, rename, delete, lock with password
- 🔒 **Folder locking** — SHA-256 password hashing, session-scoped unlock
- 🔍 **Search** — instant local filter + backend search, keyboard navigation
- 🕐 **Recent files** — IndexedDB-backed, sorted by last opened
- 📖 **Continue Reading** — tracks progress per file
- 🖼 **PDF thumbnails** — auto-generated from page 1
- 📡 **Live updates** — SSE pushes new files as soon as bot receives them
- 🎨 **Premium UI** — Framer Motion animations, Samsung Notes–inspired layout
