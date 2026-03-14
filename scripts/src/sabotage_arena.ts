import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { sleep } from './helpers.ts';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID       = "0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03";
const ARENA_ID         = "0x7cf2ab748619f5f8e25a002aa2c60a85b7a6f61220f011358a32cb11c797a923";
const PLAYERS_TABLE_ID = "0x7bb1ad94f12ceef7d9622243be71747a76085529b5275d329f08008baa1c4c35";
const CLOCK_ID         = "0x6";
const COOLDOWN_MS      = 600_000;   // 10 minutes
const THRESHOLD        = 12;

const keypair   = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiJsonRpcClient({ url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' });
const address   = keypair.getPublicKey().toSuiAddress();

// Returns { shield, last_action_ms } or null if not registered
async function getPlayerState(): Promise<{ shield: number; last_action_ms: number } | null> {
  try {
    const result = await suiClient.getDynamicFieldObject({
      parentId: PLAYERS_TABLE_ID,
      name: { type: 'address', value: address },
    });
    if (!result.data) return null;
    const fields = (result.data.content as any)?.fields?.value?.fields
                ?? (result.data.content as any)?.fields;
    return {
      shield:         Number(fields.shield),
      last_action_ms: Number(fields.last_action_ms),
    };
  } catch {
    return null;
  }
}

async function sendTx(
  fn: `${string}::${string}::${string}`,
  extraArgs: any[] = [],
): Promise<any> {
  const tx = new Transaction();
  tx.moveCall({
    target: fn,
    arguments: [tx.object(ARENA_ID), ...extraArgs, tx.object(CLOCK_ID)],
  });
  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (result.effects?.status?.status !== 'success') {
    throw new Error(result.effects?.status?.error ?? 'unknown error');
  }
  return result;
}

(async () => {
  console.log('Wallet:', address);
  let flagCount = 0;

  while (true) {
    let player = await getPlayerState();

    // Register if not in arena
    if (!player) {
      console.log('Registering...');
      await sendTx(`${PACKAGE_ID}::sabotage_arena::register`);
      player = await getPlayerState();
      console.log(`Registered. Shield: ${player?.shield ?? 0}`);
    }

    console.log(`Shield: ${player!.shield}/${THRESHOLD}  last_action: ${player!.last_action_ms}`);

    // Claim flag if threshold reached
    if (player!.shield >= THRESHOLD) {
      console.log('Threshold reached! Claiming flag...');
      const result = await sendTx(`${PACKAGE_ID}::sabotage_arena::claim_flag`);
      const flagObj = result.objectChanges
        ?.filter((c: any) => c.type === 'created')
        .find((o: any) => o.objectType?.includes('flag::Flag'));
      flagCount++;
      console.log(`Flag #${flagCount} claimed! Digest: ${result.digest}`);
      if (flagObj) console.log(`Flag object ID: ${flagObj.objectId}`);
      // Re-register immediately for the next flag
      continue;
    }

    // Wait out cooldown if needed
    const readyAt   = player!.last_action_ms + COOLDOWN_MS;
    const waitMs    = Math.max(0, readyAt - Date.now());

    if (waitMs > 0) {
      console.log(`Cooldown: ${Math.ceil(waitMs / 1000)}s remaining (ready at ${new Date(readyAt).toLocaleTimeString()})`);
      await sleep(waitMs + 1_000); // +1s buffer for clock skew
    }

    // Build
    console.log(`Building (${player!.shield} → ${player!.shield + 1})...`);
    try {
      await sendTx(`${PACKAGE_ID}::sabotage_arena::build`);
    } catch (e: any) {
      console.log(`Build failed: ${e.message}. Retrying in 30s...`);
      await sleep(30_000);
    }
  }
})();
