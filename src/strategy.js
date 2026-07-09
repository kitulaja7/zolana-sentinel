// =============================
//  strategy.js – Auto‑Raid / Claim / Refill
//  (minimum power 13 500, team up to 6, always Dungeon 11)
// =============================

import { config } from './config.js';
import { logger } from './logger.js';

// ------------------------------------------------------------------
//  CONFIG & CONSTANTS
// ------------------------------------------------------------------
const MIN_RAID_POWER   = 13500;
const MAX_TEAM_SIZE    = 6;
const TARGET_DUNGEON   = 11;
const STAMINA_COST_11  = 10;
const REFILL_ZENKO     = config.ZOLANA_STAMINA_ZENKO_COST || 10;

// ------------------------------------------------------------------
//  HELPERS
// ------------------------------------------------------------------
function battlePower(creature) {
  const RARITY_BATTLE  = { Common: 1, Uncommon: 1.2, Rare: 1.5, Epic: 2, Legendary: 2.8, Mythical: 4 };
  const VARIANT_BATTLE = { Normal: 1, Shiny: 1.15, Golden: 1.35, Shadow: 1.5, Rainbow: 2 };
  const STAGE_BATTLE   = { Baby: 0.5, Juvenile: 0.75, Adult: 1, Elder: 1.5 };
  return (RARITY_BATTLE[creature?.rarity]   || 1) *
         (VARIANT_BATTLE[creature?.variant] || 1) *
         (STAGE_BATTLE[creature?.stage]     || 1) *
         (1 + 0.05 * (Math.max(1, Number(creature?.level) || 1) - 1));
}

function staminaNow(state) {
  const acct = state?.player?.account || state?.account || {};
  return Number(acct.stamina ?? acct.stamina_current ?? 0);
}

// ------------------------------------------------------------------
//  MAIN ENGINE
// ------------------------------------------------------------------
export class StrategyEngine {
  constructor(client, state) {
    this.client = client;
    this.state = state;
    this.actionsThisCycle = 0;
    this.state.data.toggles ||= {};
  }

  // ----------------------------------------------------------------
  //  Cek mode live / dry‑run (AMAN – tidak crash jika realRun tidak ada)
  // ----------------------------------------------------------------
  _isLiveRun() {
    if (typeof this.client.realRun === 'function') {
      return this.client.realRun();
    }
    if (typeof config.ZOLANA_DRY_RUN !== 'undefined') {
      return !config.ZOLANA_DRY_RUN;
    }
    return true;
  }

  toggle(key, def) {
    const stored = this.state.data.toggles?.[key];
    return stored === undefined ? def : Boolean(stored);
  }

  // ----------------------------------------------------------------
  //  Cycle
  // ----------------------------------------------------------------
  async cycle() {
    this.actionsThisCycle = 0;
    await this.client.ensureLogin();

    const player = await this.client.loadPlayer().catch(() => null);
    if (!player) return;

    await this.claimCompletedRaids(player);
    await this.raidOrRefill(player);

    this.state.save();
  }

  // ----------------------------------------------------------------
  //  CLAIM
  // ----------------------------------------------------------------
  async claimCompletedRaids(player) {
    const claimable = [];

    for (const run of (player?.dungeon?.runs || [])) {
      const runId = run.id || run.runId;
      if (!runId) continue;

      const readyAt = Date.parse(run.ready_at || run.ends_at || '');
      const done = ['completed', 'claimable', 'ready', 'done'].includes(run.status) ||
                   (Number.isFinite(readyAt) && readyAt <= Date.now());

      if (!done) continue;

      const res = await this.safeAct(`raidClaim:${runId}`, () => this.client.dungeonClaim(runId));
      if (res) {
        claimable.push({
          floor: run.dungeon_id ?? run.floor,
          power: Number(run.party_power) || null,
        });
      }
    }

    if (claimable.length) {
      const txt = this._raidSummary('🏆 RAID CLEARED', claimable);
      this._notify(txt);
      logger.info({ claimed: claimable }, 'raid runs claimed');
    }
  }

  // ----------------------------------------------------------------
  //  RAID / REFILL
  // ----------------------------------------------------------------
  async raidOrRefill(player) {
    const stamina = staminaNow({ player });

    if (stamina < STAMINA_COST_11) {
      await this._autoRefillStamina(player);
      return;
    }

    const all = (player?.creatures || [])
      .filter(c => c.id && !c.run_id)
      .map(c => ({ ...c, bp: battlePower(c) }))
      .sort((a, b) => b.bp - a.bp);

    if (!all.length) return;

    const team = [];
    let totalPower = 0;

    for (const c of all) {
      if (team.length >= MAX_TEAM_SIZE) break;
      team.push(c);
      totalPower += c.bp;
      if (totalPower >= MIN_RAID_POWER) break;
    }

    if (totalPower < MIN_RAID_POWER) {
      logger.info({ totalPower }, 'tidak ada tim yang cukup kuat (≥13 500)');
      return;
    }

    if (stamina < STAMINA_COST_11) {
      await this._autoRefillStamina(player);
      return;
    }

    const partyIds = team.map(c => c.id);
    try {
      const result = await this.client.dungeonStart(TARGET_DUNGEON, partyIds);
      this.actionsThisCycle++;

      const run = (result?.dungeonRuns || []).find(r =>
        Array.isArray(r.party) && r.party.includes(partyIds[0])
      );
      const pw = Number(run?.party_power) || null;

      if (pw) {
        this.state.data.maxPartyPower = Math.max(this.state.data.maxPartyPower || 0, pw);
      }

      const staminaAfter = stamina - STAMINA_COST_11;
      const txt = this._raidSummary('⚔️ RAID START', [{ floor: TARGET_DUNGEON, power: pw }]);
      this._notify(`${txt} · ⚡${staminaAfter} stamina left`);
      logger.info({ floor: TARGET_DUNGEON, teamSize: team.length, power: totalPower, pw }, 'raid launched');
    } catch (e) {
      logger.warn({ err: e.message }, 'gagal memulai raid');
    }
  }

  // ----------------------------------------------------------------
  //  AUTO‑REFILL STAMINA  (diperbaiki: pakai _isLiveRun)
  // ----------------------------------------------------------------
  async _autoRefillStamina(player) {
    if (!this.toggle('autoStamina', true)) return;
    if (!this._isLiveRun()) return;                        // ✅ FIX
    const acct = player?.account || {};
    if (Number(acct.zenko_balance || 0) < REFILL_ZENKO) return;

    const res = await this.safeAct('autoStaminaBuy', () => this.client.staminaRestore('full'));
    if (res) {
      const newStam = staminaNow({ player: res }) || 180;
      this.state.data.staminaMax = newStam;
      this._notify(`⚡ Auto‑bought full stamina (${REFILL_ZENKO} zenko) – siap raid!`);
      logger.info({ newStamina: newStam }, 'stamina auto‑refill');
    }
  }

  // ----------------------------------------------------------------
  //  SAFE wrapper  (diperbaiki: pakai _isLiveRun)
  // ----------------------------------------------------------------
  async safeAct(name, fn) {
    if (this.actionsThisCycle >= (config.ZOLANA_MAX_ACTIONS_PER_CYCLE || 50)) return null;
    this.actionsThisCycle++;

    if (!this._isLiveRun()) {                              // ✅ FIX
      logger.info({ action: name }, 'dry‑run – action ignored');
      return null;
    }

    try {
      const result = await fn();
      logger.info({ action: name }, 'action succeeded');
      return result;
    } catch (e) {
      logger.warn({ action: name, err: e.message }, 'action failed');
      return null;
    }
  }

  // ----------------------------------------------------------------
  //  HELPERS – formatting + notification
  // ----------------------------------------------------------------
  _raidSummary(title, entries) {
    const n = entries.length;
    const floors = entries.map(e => e.floor).filter(Number.isFinite);
    const floorStr = floors.length
      ? (Math.min(...floors) === Math.max(...floors) ? `${floors[0]}` : `${Math.min(...floors)}–${Math.max(...floors)}`)
      : '?';
    const powers = entries.map(e => e.power).filter(p => Number.isFinite(p) && p > 0);
    const pw = powers.length ? Math.max(...powers) : null;
    const pwStr = pw ? `~${Math.round(pw).toLocaleString()}` : '?';
    return `${title} — ${n} ${n===1?'party':'parties'} · floor ${floorStr} · power ${pwStr}`;
  }

  _notify(text) {
    if (typeof this.client.notify === 'function') {
      this.client.notify({ text });
    } else {
      console.log('NOTIFY →', text);
    }
  }
}
