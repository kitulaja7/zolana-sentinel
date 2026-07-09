// =============================
//  strategy.js – Auto‑Raid / Claim / Refill
//  (minimum power 13 500, team up to 6, always Dungeon 11)
// =============================

import { config } from './config.js';
import { logger } from './logger.js';

// ------------------------------------------------------------------
//  CONFIG & CONSTANTS
// ------------------------------------------------------------------
const MIN_RAID_POWER   = 13500;               // power yang harus dicapai
const MAX_TEAM_SIZE   = 6;                   // tidak lebih dari 6 anggota
const TARGET_DUNGEON  = 11;                  // selalu menyerang floor 11
const STAMINA_COST_11 = 10;                  // stamina untuk floor 11 (region 2)
const REFILL_ZENKO    = config.ZOLANA_STAMINA_ZENKO_COST || 10; // biaya refill full stamina

// ------------------------------------------------------------------
//  HELPERS – battle power, stamina, floor‑requirements
// ------------------------------------------------------------------
function battlePower(creature) {
  const RARITY_BATTLE = { Common: 1, Uncommon: 1.2, Rare: 1.5, Epic: 2, Legendary: 2.8, Mythical: 4 };
  const VARIANT_BATTLE = { Normal: 1, Shiny: 1.15, Golden: 1.35, Shadow: 1.5, Rainbow: 2 };
  const STAGE_BATTLE   = { Baby: 0.5, Juvenile: 0.75, Adult: 1, Elder: 1.5 };
  return (RARITY_BATTLE[creature?.rarity]   || 1) *
         (VARIANT_BATTLE[creature?.variant] || 1) *
         (STAGE_BATTLE[creature?.stage]    || 1) *
         (1 + 0.05 * (Math.max(1, Number(creature?.level) || 1) - 1));
}

// stamina yang ada di payload player
function staminaNow(state) {
  const acct = state?.player?.account || state?.account || {};
  return Number(acct.stamina ?? acct.stamina_current ?? 0);
}

// ------------------------------------------------------------------
//  MAIN ENGINE
// ------------------------------------------------------------------
export class StrategyEngine {
  constructor(client, state) {
    this.client = client;          // API wrapper (must expose dungeonStart / dungeonClaim / staminaRestore)
    this.state = state;            // persisten engine‑state (cooldowns, maxPower, …)
    this.actionsThisCycle = 0;
    this.state.data.toggles ||= {};
  }

  // ----------------------------------------------------------------
  //  Simple toggle helper (kept for future config switches)
  // ----------------------------------------------------------------
  toggle(key, def) {
    const stored = this.state.data.toggles?.[key];
    return stored === undefined ? def : Boolean(stored);
  }

  // ----------------------------------------------------------------
  //  Cycle – dipanggil tiap loop utama
  // ----------------------------------------------------------------
  async cycle() {
    this.actionsThisCycle = 0;
    await this.client.ensureLogin();

    const player = await this.client.loadPlayer().catch(() => null);
    if (!player) return;

    // 1️⃣ Claim raid yang sudah selesai
    await this.claimCompletedRaids(player);

    // 2️⃣ Raid / Refill
    await this.raidOrRefill(player);

    // persist state
    this.state.save();
  }

  // ----------------------------------------------------------------
  //  CLAIM semua dungeon run yang sudah selesai
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
  //  RAID (atau REFILL bila stamina tidak cukup)
  // ----------------------------------------------------------------
  async raidOrRefill(player) {
    const stamina = staminaNow({ player });

    // ----------------------------------------------------------------
    //  REFILL: stamina < biaya dungeon 11 → beli stamina penuh dengan Zenko
    // ----------------------------------------------------------------
    if (stamina < STAMINA_COST_11) {
      await this._autoRefillStamina(player);
      return;
    }

    // ----------------------------------------------------------------
    //  BUILD TEAM – ambil creature terkuat dulu, tambahkan sampai
    //  total power >= MIN_RAID_POWER atau tim sudah 6 anggota.
    // ----------------------------------------------------------------
    const all = (player?.creatures || [])
      .filter(c => c.id && !c.run_id)           // tidak sedang raid
      .map(c => ({ ...c, bp: battlePower(c) }))
      .sort((a, b) => b.bp - a.bp);            // terkuat dulu

    if (!all.length) return;                   // tidak ada creature

    const team = [];
    let totalPower = 0;

    for (const c of all) {
      if (team.length >= MAX_TEAM_SIZE) break;
      team.push(c);
      totalPower += c.bp;
      if (totalPower >= MIN_RAID_POWER) break;
    }

    if (totalPower < MIN_RAID_POWER) {
      logger.info({ totalPower }, 'tidak ada tim yang cukup kuat (≥13 500)');
      return;                                 // tunggu stamina / growth
    }

    // ----------------------------------------------------------------
    //  START RAID – selalu Dungeon 11 (jika stamina cukup)
    // ----------------------------------------------------------------
    if (stamina < STAMINA_COST_11) {
      // sudah dicek di atas, tapi kalau stamina berkurang setelah loop
      // (misalnya ada raid lain) tetap abort.
      await this._autoRefillStamina(player);
      return;
    }

    const partyIds = team.map(c => c.id);
    try {
      const result = await this.client.dungeonStart(TARGET_DUNGEON, partyIds);
      this.actionsThisCycle++;

      // optional: ambil power dari run yang baru dibuat
      const run = (result?.dungeonRuns || []).find(r =>
        Array.isArray(r.party) && r.party.includes(partyIds[0])
      );
      const pw = Number(run?.party_power) || null;

      // update best‑ever power (untuk estimasi floor di siklus berikut)
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
  //  AUTO‑REFILL STAMINA (full refill) menggunakan Zenko
  // ----------------------------------------------------------------
  async _autoRefillStamina(player) {
    if (!this.toggle('autoStamina', true)) return;
    if (!this.client.realRun()) return;                     // dry‑run disabled
    const acct = player?.account || {};
    if (Number(acct.zenko_balance || 0) < REFILL_ZENKO) return; // tidak cukup zenko

    const res = await this.safeAct('autoStaminaBuy', () => this.client.staminaRestore('full'));
    if (res) {
      const newStam = staminaNow({ player: res }) || 180;   // fallback typical max
      this.state.data.staminaMax = newStam;
      this._notify(`⚡ Auto‑bought full stamina (${REFILL_ZENKO} zenko) – siap raid!`);
      logger.info({ newStamina: newStam }, 'stamina auto‑refill');
    }
  }

  // ----------------------------------------------------------------
  //  SAFE wrapper – menghormati action‑budget & dry‑run mode
  // ----------------------------------------------------------------
  async safeAct(name, fn) {
    if (this.actionsThisCycle >= (config.ZOLANA_MAX_ACTIONS_PER_CYCLE || 50)) return null;
    this.actionsThisCycle++;

    if (!this.client.realRun()) {
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
  //  HELPERS – formatting + notification (sync with UI of original bot)
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
    // Bot‑original menggunakan `client.notify` untuk mengirim ke Telegram.
    // Jika client Anda tidak punya method ini, ganti dengan cara Anda men‑push pesan.
    if (typeof this.client.notify === 'function') {
      this.client.notify({ text });
    } else {
      console.log('NOTIFY →', text);
    }
  }
}
