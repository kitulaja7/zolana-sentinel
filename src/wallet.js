import fs from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getMint,
} from '@solana/spl-token';
import { config } from './config.js';

function uiToRawAmount(value, decimals) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Invalid token amount.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`Too many decimals; max ${decimals}.`);
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}

function rawToUiAmount(raw, decimals) {
  const sign = raw < 0n ? '-' : '';
  const digits = (raw < 0n ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals) || '0';
  const fraction = decimals > 0 ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function parseSecret(raw) {
  const value = raw.trim();
  if (!value) throw new Error('Missing ZOLANA_PRIVATE_KEY or ZOLANA_PRIVATE_KEY_FILE.');

  if (value.startsWith('[')) {
    return Uint8Array.from(JSON.parse(value));
  }

  if (value.includes(',')) {
    return Uint8Array.from(value.split(',').map((part) => Number(part.trim())));
  }

  return bs58.decode(value);
}

export function loadWallet() {
  const raw = config.ZOLANA_PRIVATE_KEY_FILE
    ? fs.readFileSync(config.ZOLANA_PRIVATE_KEY_FILE, 'utf8')
    : config.ZOLANA_PRIVATE_KEY;
  const secret = parseSecret(raw);
  const keypair = secret.length === 64
    ? Keypair.fromSecretKey(secret)
    : Keypair.fromSeed(secret.slice(0, 32));

  return {
    keypair,
    publicKey: keypair.publicKey.toBase58(),
    signMessage(message) {
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
      return bs58.encode(nacl.sign.detached(bytes, keypair.secretKey));
    },
    async solBalance() {
      const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
      const lamports = await connection.getBalance(keypair.publicKey, 'confirmed');
      return lamports / LAMPORTS_PER_SOL;
    },
    async tokenProgramForMint(mintAddress = config.ZOLANA_TOKEN_MINT) {
      const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
      const mint = new PublicKey(mintAddress);
      const account = await connection.getAccountInfo(mint, 'confirmed');
      if (!account) throw new Error(`Token mint not found: ${mintAddress}`);
      if (account.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
      if (account.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
      throw new Error(`Unsupported token program for mint ${mintAddress}: ${account.owner.toBase58()}`);
    },
    async tokenBalance(mintAddress = config.ZOLANA_TOKEN_MINT) {
      const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
      const mint = new PublicKey(mintAddress);
      const tokenProgram = await this.tokenProgramForMint(mintAddress);
      const account = await getAssociatedTokenAddress(mint, keypair.publicKey, false, tokenProgram);
      const parsed = await connection.getParsedAccountInfo(account, 'confirmed');
      const info = parsed.value?.data?.parsed?.info;
      return {
        mint: mint.toBase58(),
        tokenProgram: tokenProgram.toBase58(),
        account: account.toBase58(),
        raw: BigInt(info?.tokenAmount?.amount || '0'),
        decimals: Number(info?.tokenAmount?.decimals || 0),
        uiAmount: Number(info?.tokenAmount?.uiAmount || 0),
      };
    },
    async transferTokenSplit(legs, mintAddress = config.ZOLANA_TOKEN_MINT, decimals = undefined) {
      if (!Array.isArray(legs) || legs.length === 0) throw new Error('transferTokenSplit: no transfer legs.');
      const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
      const mint = new PublicKey(mintAddress);
      const tokenProgram = await this.tokenProgramForMint(mintAddress);
      const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
      const tokenDecimals = decimals ?? mintInfo.decimals;
      const source = await getAssociatedTokenAddress(mint, keypair.publicKey, false, tokenProgram);
      const tx = new Transaction();

      for (const leg of legs) {
        const amount = BigInt(leg.rawAmount);
        if (amount <= 0n) continue;
        const owner = new PublicKey(leg.toOwner);
        const destination = await getAssociatedTokenAddress(mint, owner, false, tokenProgram);
        if (!await connection.getAccountInfo(destination, 'confirmed')) {
          tx.add(createAssociatedTokenAccountInstruction(
            keypair.publicKey,
            destination,
            owner,
            mint,
            tokenProgram,
          ));
        }
        tx.add(createTransferCheckedInstruction(
          source,
          mint,
          destination,
          keypair.publicKey,
          amount,
          tokenDecimals,
          [],
          tokenProgram,
        ));
      }

      if (tx.instructions.length === 0) throw new Error('transferTokenSplit: no positive transfer legs.');
      return sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    },
    async transferToken(amountUi, destinationOwner, {
      mintAddress = config.ZOLANA_TOKEN_MINT,
      reserveUi = config.ZOLANA_MARKET_ZOLANA_RESERVE,
    } = {}) {
      const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
      const mint = new PublicKey(mintAddress);
      const tokenProgram = await this.tokenProgramForMint(mintAddress);
      const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
      const amount = uiToRawAmount(amountUi, mintInfo.decimals);
      if (amount <= 0n) throw new Error('Token amount must be positive.');

      const source = await getAssociatedTokenAddress(mint, keypair.publicKey, false, tokenProgram);
      const sourceInfo = await connection.getParsedAccountInfo(source, 'confirmed');
      const currentRaw = BigInt(sourceInfo.value?.data?.parsed?.info?.tokenAmount?.amount || '0');
      const reserveRaw = uiToRawAmount(reserveUi, mintInfo.decimals);
      if (currentRaw - amount < reserveRaw) {
        throw new Error(`Transfer blocked: reserve ${reserveUi} $ZOLANA required.`);
      }

      const owner = new PublicKey(destinationOwner);
      const destination = await getAssociatedTokenAddress(mint, owner, false, tokenProgram);
      const tx = new Transaction();
      if (!await connection.getAccountInfo(destination, 'confirmed')) {
        tx.add(createAssociatedTokenAccountInstruction(
          keypair.publicKey,
          destination,
          owner,
          mint,
          tokenProgram,
        ));
      }
      tx.add(createTransferCheckedInstruction(
        source,
        mint,
        destination,
        keypair.publicKey,
        amount,
        mintInfo.decimals,
        [],
        tokenProgram,
      ));
      return sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    },
    async sweepToken(destinationOwner, {
      mintAddress = config.ZOLANA_TOKEN_MINT,
      reserveUi = 0,
    } = {}) {
      const balance = await this.tokenBalance(mintAddress);
      const reserveRaw = uiToRawAmount(reserveUi, balance.decimals);
      const amount = balance.raw - reserveRaw;
      if (amount <= 0n) throw new Error('No sweepable $ZOLANA balance.');
      const amountUi = rawToUiAmount(amount, balance.decimals);
      return this.transferToken(String(amountUi), destinationOwner, { mintAddress, reserveUi });
    },
    async withdrawSol(amountSol, destination) {
      const amount = Number(amountSol);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid withdrawal amount.');
      if (amount > config.ZOLANA_MAX_WITHDRAW_SOL) {
        throw new Error(`Withdrawal exceeds max ${config.ZOLANA_MAX_WITHDRAW_SOL} SOL.`);
      }

      const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
      const balanceLamports = await connection.getBalance(keypair.publicKey, 'confirmed');
      const amountLamports = Math.round(amount * LAMPORTS_PER_SOL);
      const reserveLamports = Math.round(config.ZOLANA_WITHDRAW_MIN_SOL_RESERVE * LAMPORTS_PER_SOL);
      if (balanceLamports - amountLamports < reserveLamports) {
        throw new Error(`Withdrawal blocked: reserve ${config.ZOLANA_WITHDRAW_MIN_SOL_RESERVE} SOL required.`);
      }

      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(destination),
        lamports: amountLamports,
      }));
      return sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    },
  };
}

export function generateWallet() {
  const keypair = Keypair.generate();
  const secret = bs58.encode(keypair.secretKey);
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKey: secret,
    json: Array.from(keypair.secretKey),
  };
}

export function buildLoginMessage({ wallet, nonce, issuedAt, template }) {
  if (template && template !== 'auto') {
    return template
      .replaceAll('{wallet}', wallet)
      .replaceAll('{nonce}', nonce)
      .replaceAll('{issuedAt}', String(issuedAt));
  }

  return [
    'Zenko — sign in',
    'domain: zolana.gg',
    `wallet: ${wallet}`,
    `issuedAt: ${issuedAt}`,
    `nonce: ${nonce}`,
    '',
    'Signing once authorizes this device to act for 8h. No funds move.',
  ].join('\n');
}

export function loginMessageCandidates({ wallet, nonce, issuedAt, template }) {
  if (template && template !== 'auto') {
    return [buildLoginMessage({ wallet, nonce, issuedAt, template })];
  }

  return [
    buildLoginMessage({ wallet, nonce, issuedAt, template: 'auto' }),
    `${wallet}:${issuedAt}:${nonce}`,
    `${wallet}:${nonce}:${issuedAt}`,
    `Login to Zolana: ${wallet}:${issuedAt}:${nonce}`,
    `Sign in to Zolana\n${wallet}\n${nonce}\n${issuedAt}`,
    JSON.stringify({ wallet, issuedAt, nonce }),
    [
      'play.zolana.gg wants you to sign in with your Solana account:',
      wallet,
      '',
      'Version: 1',
      'URI: https://play.zolana.gg/',
      `Issued At: ${issuedAt}`,
      `Nonce: ${nonce}`,
    ].join('\n'),
  ];
}
