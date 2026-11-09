# Northstar Private Portfolio

A Node.js web app where administrators create client accounts, publish and update projects, and control which clients can view each project. Client accounts can only see projects assigned to them and can change their own password.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

1. Install the dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env`. Generate a strong session secret:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Set `SESSION_SECRET` to the generated value and set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to the first administrator's credentials. Admin passwords must be 12-72 UTF-8 bytes.

3. Start the server:

   ```powershell
   npm start
   ```

4. Open [http://localhost:3000](http://localhost:3000).

The first start creates the SQLite database at `data/portfolio.db` and creates the initial administrator account if no administrator exists yet. The database and session store are local files and are excluded from Git.

## Features

- Administrator and client sign-in with hashed passwords and SQLite-backed sessions.
- Admin-managed client accounts and project create, edit, and delete operations.
- Project length recorded in whole months and annual investment rate recorded as a percentage (0-100).
- Project start date and expected finish date calculated from the start date and project length.
- Per-client, per-project USD investment amounts and access assignments.
- Per-client simple-interest estimates and project-value charts; estimates exclude fees and taxes and are not guaranteed returns.
- Administrator-managed news articles with draft and publish states; clients only see published news.
- Email notifications for assigned clients when projects are created or updated (requires SMTP configuration).
- Client dashboards limited to each client's assigned projects.
- Password changes, login rate limiting, secure session cookies, and security headers.

Existing databases receive the new project fields automatically. Existing project terms, dates, and investment amounts show “not set” until an administrator edits them and enters values.

## Project email notifications

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and optionally `SMTP_FROM` in `.env`, then restart the app. Gmail uses `smtp.gmail.com`, port `465`, and secure TLS; use a Google App Password rather than your regular account password. Set `PORTFOLIO_URL` to the public HTTPS address clients use to sign in. Notifications are sent individually to clients assigned to a project and include a summary of changed project fields, but do not include investment amounts. If delivery fails, the project is still saved; the administrator sees a warning in the dashboard and recipient-specific failures are written to the server log.

For production, use HTTPS, set a private random `SESSION_SECRET`, and set `NODE_ENV=production`. The app is designed as a project-information portal; it does not calculate returns or provide investment advice.
