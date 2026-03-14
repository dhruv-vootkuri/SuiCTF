import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { sleep } from './helpers.ts';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID   = "0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03";
const CLOCK_ID     = "0x6";
const GAS_PER_COIN = 5_000_000n;    // 0.005 SUI per coin
const RESERVE_SUI  = 5_000_000_000n; // keep 5 SUI untouched
const SETUP_BATCH  = 500;            // max coins per setup transaction

const keypair   = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiJsonRpcClient({ url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' });
const address   = keypair.getPublicKey().toSuiAddress();

interface CoinRef { objectId: string; version: string; digest: string; }
interface SignedTx { bytes: string; signature: string; }

function secondsUntilWindowOpen(): number {
  const t = Math.floor(Date.now() / 1000) % 3600;
  if (t < 300 || (t >= 1800 && t < 2100)) return 0;
  if (t < 1800) return 1800 - t;
  return 3600 - t;
}

function secondsUntilWindowCloses(): number {
  const t = Math.floor(Date.now() / 1000) % 3600;
  if (t < 300) return 300 - t;
  if (t >= 1800 && t < 2100) return 2100 - t;
  return 0;
}

// Query spendable SUI balance
async function getBalance(): Promise<bigint> {
  const { totalBalance } = await suiClient.getBalance({ owner: address });
  return BigInt(totalBalance);
}

// Split gas coin into numCoins smaller coins, batched to stay within PTB limits
async function setupGasCoins(numCoins: number): Promise<string[]> {
  console.log(`Splitting gas into ${numCoins} coins (batches of ${SETUP_BATCH})...`);
  const allIds: string[] = [];

  for (let i = 0; i < numCoins; i += SETUP_BATCH) {
    const count = Math.min(SETUP_BATCH, numCoins - i);
    const tx = new Transaction();
    const splitResult = tx.splitCoins(tx.gas, Array(count).fill(tx.pure.u64(GAS_PER_COIN)));
    tx.transferObjects(Array.from({ length: count }, (_, j) => splitResult[j]), address);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true },
    });

    const ids = result.objectChanges
      ?.filter(c => c.type === 'created' && (c as any).objectType === '0x2::coin::Coin<0x2::sui::SUI>')
      .map(c => (c as any).objectId) ?? [];

    allIds.push(...ids);
    console.log(`  Batch ${Math.floor(i / SETUP_BATCH) + 1}: +${ids.length} coins (total: ${allIds.length})`);
  }

  console.log(`Setup complete. ${allIds.length} gas coins ready.`);
  return allIds;
}

// Batch fetch refs in chunks of 50 (RPC limit)
async function fetchCoinRefs(coinIds: string[]): Promise<CoinRef[]> {
  const all: CoinRef[] = [];
  for (let i = 0; i < coinIds.length; i += 50) {
    const results = await suiClient.multiGetObjects({ ids: coinIds.slice(i, i + 50), options: { showOwner: true } });
    for (const r of results) {
      if (r.data) all.push({ objectId: r.data.objectId, version: r.data.version, digest: r.data.digest });
    }
  }
  return all;
}

// Build and sign one transaction using a specific gas coin
async function buildAndSign(gasRef: CoinRef): Promise<SignedTx> {
  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasBudget(4_000_000n);
  tx.setGasPayment([gasRef]);
  const flag = tx.moveCall({
    target: `${PACKAGE_ID}::moving_window::extract_flag`,
    arguments: [tx.object(CLOCK_ID)],
  });
  tx.transferObjects([flag], address);
  const txBytes = await tx.build({ client: suiClient });
  const { bytes, signature } = await keypair.signTransaction(txBytes);
  return { bytes, signature };
}

// Sign all coins serially with retry backoff, stopping at deadline
async function buildAndSignAll(coinRefs: CoinRef[], deadlineMs: number): Promise<SignedTx[]> {
  const results: SignedTx[] = [];
  for (const ref of coinRefs) {
    if (Date.now() >= deadlineMs) {
      console.log(`\n  Time limit reached — pre-signed ${results.length}/${coinRefs.length} txs`);
      break;
    }
    let delay = 200;
    while (true) {
      try {
        results.push(await buildAndSign(ref));
        break;
      } catch (e: any) {
        if (e?.status === 429 || e?.message?.includes('429')) {
          await sleep(delay);
          delay = Math.min(delay * 2, 5000);
        } else {
          throw e;
        }
      }
    }
  }
  return results;
}

// Submit all signed transactions simultaneously
async function submitBatch(signed: SignedTx[]): Promise<number> {
  const results = await Promise.all(
    signed.map(({ bytes, signature }) =>
      suiClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: { showEffects: true },
      }).catch(() => null)
    )
  );
  return results.filter(r => r?.effects?.status?.status === 'success').length;
}

(async () => {
  console.log('Wallet:', address);

  // One-time setup: create as many gas coins as balance allows (keeping RESERVE_SUI)
  const balance = await getBalance();
  const numCoins = Number((balance - RESERVE_SUI) / GAS_PER_COIN);
  console.log(`Balance: ${balance / 1_000_000_000n} SUI → creating ${numCoins} gas coins`);
  let coinIds = await setupGasCoins(numCoins);
  let totalFlags = 0;

  while (true) {
    const waitSecs = secondsUntilWindowOpen();
    if (waitSecs > 0) {
      const openAt = new Date(Date.now() + waitSecs * 1000).toLocaleTimeString();
      const signingTimeSecs = waitSecs - 5;
      const estimatedSignable = Math.min(coinIds.length, Math.floor(signingTimeSecs / 0.4));
      console.log(`\nWindow closed. Next opens in ${waitSecs}s (at ${openAt}).`);
      console.log(`  Gas coins: ${coinIds.length} | Signing time: ${signingTimeSecs}s | Est. pre-signable: ~${estimatedSignable} txs`);

      // Sign everything we can, stopping 5s before the window opens
      const deadline = Date.now() + (waitSecs - 5) * 1000;
      const coinRefs = await fetchCoinRefs(coinIds);
      const presigned = await buildAndSignAll(coinRefs, deadline);

      // Spin-wait for window
      while (secondsUntilWindowOpen() > 0) await sleep(50);

      // Blast everything at once
      console.log(`[${new Date().toLocaleTimeString()}] Window open! Firing ${presigned.length} pre-signed txs...`);
      const won = await submitBatch(presigned);
      totalFlags += won;
      console.log(`  +${won} flags (total: ${totalFlags})`);
    }

    // Fire single transactions for the rest of the window
    while (secondsUntilWindowCloses() > 0) {
      try {
        const tx = new Transaction();
        const flag = tx.moveCall({
          target: `${PACKAGE_ID}::moving_window::extract_flag`,
          arguments: [tx.object(CLOCK_ID)],
        });
        tx.transferObjects([flag], address);
        const result = await suiClient.signAndExecuteTransaction({
          signer: keypair,
          transaction: tx,
          options: { showEffects: true },
        });
        if (result.effects?.status?.status === 'success') totalFlags++;
      } catch { /* ignore */ }
      process.stdout.write(`  flags: ${totalFlags} (${secondsUntilWindowCloses()}s left)\r`);
    }

    console.log(`\nWindow closed. Total flags: ${totalFlags}`);
  }
})();
