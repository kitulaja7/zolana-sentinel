# Zolana Bot

Autonomous farming, trading and progression bot for [play.zolana.gg](https://play.zolana.gg) — a Solana creature-collector MMO. Runs a smart autopilot (farming, dungeons/raids, evolve, breed, gacha, quests, crafting, market) and is fully controllable from Telegram.

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/rygroup-dev/zolana-bot/main/install.sh | bash
```

This installs Node.js (if missing), clones the repo, installs all dependencies, and creates `.env`.

Or manually:

```bash
git clone https://github.com/rygroup-dev/zolana-bot.git
cd zolana-bot
npm install
cp .env.example .env   # then edit .env
```

## Configure

Edit `.env` (see `.env.example` for every option):

| Key | Purpose |
| --- | --- |
| `ZOLANA_PRIVATE_KEY` | Wallet secret (base58 or JSON array). Used to sign login + token transfers. |
| `ZOLANA_TELEGRAM_BOT_TOKEN` | Telegram bot token (from @BotFather). |
| `ZOLANA_TELEGRAM_CHAT_ID` | Your Telegram chat id (owner-only control). |
| `ZOLANA_REAL_RUN` | `true` to act, `false` for dry-run. |
| `SOLANA_RPC_URL` | Solana RPC endpoint. |

Secrets are read from the environment only and never committed (`.env` is git-ignored).

## Run

```bash
node src/index.js          # long-running autopilot + Telegram control
node src/index.js --once   # run a single cycle and exit
```

### As a systemd service (Linux)

```ini
[Unit]
Description=Zolana Bot
After=network-online.target

[Service]
WorkingDirectory=/root/zolana-bot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now zolana-bot
journalctl -u zolana-bot -f
```

## Telegram

Message the bot and use the inline dashboard or slash commands: `/status`, `/wallet`, `/profit`, `/inventory`, `/creature`, `/dungeon`, `/gacha`, `/fund`, `/auto` (per-module toggles), and more. `/help` lists everything.

## Design

- **Autopilot** — the strategy cycle runs on an interval; Telegram is long-polled continuously so commands respond in ~1s.
- **Smart economy** — always farms the highest gold-per-hour creatures, climbs dungeon floors it can clear, keeps crafting reserves and sells only surplus, and never spends below safety reserves.
- **Resilient** — per-request timeouts, retry/backoff on network/rate-limit errors, auto re-auth, jittered pacing, and crash guards.

## Layout

```
src/
  index.js      main loop + Telegram command router
  strategy.js   autopilot brain (farming, dungeon, evolve, breed, gacha, market…)
  client.js     game API client (auth, requests, hardening)
  wallet.js     Solana wallet (sign, token transfers)
  telegram.js   Telegram bot (dashboard, formatters)
  config.js     env-validated configuration
  state.js      persisted runtime state
  logger.js     structured logging (secrets redacted)
  captcha.js    optional 2captcha fallback
```

## License

Private. All rights reserved.
