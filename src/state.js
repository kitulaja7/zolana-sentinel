import fs from 'node:fs';
import path from 'node:path';

const STATE_PATH = path.resolve('data/state.json');

export class BotState {
  constructor(data = {}) {
    this.data = {
      cooldowns: {},
      counters: {},
      lastPlayer: null,
      market: {},
      ...data,
    };
  }

  static load() {
    if (!fs.existsSync(STATE_PATH)) return new BotState();
    return new BotState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  }

  save() {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(this.data, null, 2));
  }

  ready(key) {
    return Date.now() >= (this.data.cooldowns[key] || 0);
  }

  cooldown(key, ms) {
    this.data.cooldowns[key] = Date.now() + ms;
  }

  count(key) {
    this.data.counters[key] = (this.data.counters[key] || 0) + 1;
  }
}
