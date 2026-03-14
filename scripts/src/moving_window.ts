import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { sleep } from './helpers.ts';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID = "0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03";
const CLOCK_ID = "0x6";

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiJsonRpcClient({ url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' });
const address = keypair.getPublicKey().toSuiAddress();

// Returns seconds until the next window opens (0 if currently open).
// Windows: [0, 300) and [1800, 2100) within each 3600s hour.
function secondsUntilWindowOpen(): number {
  const t = Math.floor(Date.now() / 1000) % 3600;
  if (t < 300 || (t >= 1800 && t < 2100)) return 0;
  if (t < 1800) return 1800 - t;
  return 3600 - t;
}

// Returns seconds until the current window closes.
function secondsUntilWindowCloses(): number {
  const t = Math.floor(Date.now() / 1000) % 3600;
  if (t < 300) return 300 - t;
  if (t >= 1800 && t < 2100) return 2100 - t;
  return 0; // not in a window
}

async function extractFlag(): Promise<boolean> {
  const tx = new Transaction();
  const flag = tx.moveCall({
    target: `${PACKAGE_ID}::moving_window::extract_flag`,
    arguments: [tx.object(CLOCK_ID)],
  });
  tx.transferObjects([flag], address);

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });

  const status = result.effects?.status?.status;
  if (status !== 'success') {
    console.log(`  TX failed: ${result.effects?.status?.error} (digest: ${result.digest})`);
    return false;
  }

  const flagObj = result.objectChanges
    ?.filter(c => c.type === 'created')
    .find(o => (o as any).objectType?.includes('flag::Flag'));

  console.log(`  Flag extracted! Digest: ${result.digest}`);
  if (flagObj) console.log(`  Flag object ID: ${(flagObj as any).objectId}`);
  return true;
}

(async () => {
  console.log(`Wallet: ${address}`);
  let flagCount = 0;

  while (true) {
    const waitSecs = secondsUntilWindowOpen();

    if (waitSecs > 0) {
      const openAt = new Date(Date.now() + waitSecs * 1000).toLocaleTimeString();
      console.log(`Window closed. Next opens in ${waitSecs}s (at ${openAt}). Sleeping...`);
      // Sleep until 1s before window opens to avoid overshooting
      await sleep((waitSecs - 1) * 1000);
      // Spin-wait the final second for precision
      while (secondsUntilWindowOpen() > 0) {
        await sleep(100);
      }
    }

    console.log(`[${new Date().toLocaleTimeString()}] Window open! Farming flags...`);

    // Keep extracting as fast as possible while the window is open
    while (secondsUntilWindowCloses() > 0) {
      try {
        const success = await extractFlag();
        if (success) flagCount++;
      } catch (e) {
        console.log(`  Error: ${e}`);
      }
    }
  }
})();
