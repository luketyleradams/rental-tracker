# Rental Tracker

A self-hosted web app for tracking rental income, expenses, staff, and payments.
All data stays on your computer in a SQLite database — no accounts, no cloud, no fees.

---

## Features

| Tab | What it does |
|-----|-------------|
| **Dashboard** | Monthly snapshot — rent collected, vacancies, balance owed per room |
| **Payments** | Log and delete tenant payments; view full payment history |
| **Expenses** | Track property expenses with date, amount, and description |
| **Rooms** | Manage units (building, room number, rent amount); add/end occupancies; record balance adjustments |
| **Staff** | Add staff members with salaries; pay one or all at once |
| **Reports** | Printable income/expense summary for any date range |

Automatic JSON backups are created daily and on every startup (`backups/` folder, last 60 kept).

---

## Starting the app

**Windows:** Double-click `start.bat`

Everything installs automatically on the first launch — no setup required.

**Mac / Linux:** Open a terminal in this folder and run:
```
sh start.sh
```
Node.js must be installed first on Mac/Linux: download from https://nodejs.org or run `brew install node`.

---

Your browser will open automatically when the app is ready. Leave the terminal window open while using the app — closing it stops the server.

---

## Your data

| What | Where |
|------|-------|
| Database | `data/rental.db` |
| Daily backups | `backups/` folder (JSON, last 60 kept) |

**Back up the `data/` folder** to a USB drive or cloud storage occasionally.
The JSON files in `backups/` contain all your data in plain text and can be used to restore if needed.

---

## Troubleshooting

**First launch takes a while** → Normal. It's downloading Node.js (~35 MB) and app dependencies once. Subsequent launches are instant.

**"Download failed"** → Check your internet connection and double-click `start.bat` again.

**"npm install failed"** → Check your internet connection and try again.

**Browser doesn't open automatically** → Navigate to http://localhost:3000 manually.

**Page won't load** → Make sure the terminal window is still open. Refresh the browser.

**Port already in use** → Another program is using port 3000. Edit `server.js`, change `const PORT = 3000` to `3001` (or any free port), then browse to `http://localhost:3001`.
