import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { sleep } from './helpers.ts';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID = "0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03";
const CLOCK_ID   = "0x6";

const keypair   = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiJsonRpcClient({ url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' });
const address   = keypair.getPublicKey().toSuiAddress();

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

async function extractFlag(): Promise<boolean> {
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
    return result.effects?.status?.status === 'success';
  } catch {
    return false;
  }
}

(async () => {
  console.log('Wallet:', address);
  let totalFlags = 0;

  while (true) {
    const waitSecs = secondsUntilWindowOpen();
    if (waitSecs > 0) {
      const openAt = new Date(Date.now() + waitSecs * 1000).toLocaleTimeString();
      console.log(`Window closed. Next opens in ${waitSecs}s (at ${openAt}). Waiting...`);
      await sleep((waitSecs - 1) * 1000);
      while (secondsUntilWindowOpen() > 0) await sleep(50);
      console.log(`[${new Date().toLocaleTimeString()}] Window open!`);
    }

    while (secondsUntilWindowCloses() > 0) {
      const won = await extractFlag();
      if (won) totalFlags++;
      process.stdout.write(`  flags: ${totalFlags} (${secondsUntilWindowCloses()}s left)\r`);
    }

    console.log(`\nWindow closed. Total flags: ${totalFlags}`);
  }
})();
