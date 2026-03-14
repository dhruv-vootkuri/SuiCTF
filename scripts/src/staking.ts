import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { sleep } from './helpers.ts';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID = "0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03";
const POOL_ID    = "0x9cd5b5fe69a62761859536720b9b07c48a1e43b95d8c291855d9fc6779a3b494";
const CLOCK_ID   = "0x6";
const RECEIPT_TYPE = `${PACKAGE_ID}::staking::StakeReceipt`;

// 168 receipts × 1 hour each = 168 hours required
const NUM_RECEIPTS = 168;
const WAIT_MS = 3_600_000; // 1 hour in ms

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiJsonRpcClient({ url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' });
const address = keypair.getPublicKey().toSuiAddress();

async function getReceipts(): Promise<{ id: string; timestamp: number }[]> {
  const { data } = await suiClient.getOwnedObjects({
    owner: address,
    filter: { StructType: RECEIPT_TYPE },
    options: { showContent: true },
  });
  return data
    .filter(o => o.data?.content?.dataType === 'moveObject')
    .map(o => {
      const fields = (o.data!.content as any).fields;
      return { id: o.data!.objectId, timestamp: Number(fields.last_update_timestamp) };
    });
}

async function createReceipts() {
  console.log(`Staking ${NUM_RECEIPTS} receipts (1 SUI + ${NUM_RECEIPTS - 1} MIST)...`);

  const tx = new Transaction();

  // Split from gas coin: first split is 1 SUI, rest are 1 MIST each
  const amounts = [1_000_000_000n, ...Array(NUM_RECEIPTS - 1).fill(1n)];
  const splitCoins = tx.splitCoins(tx.gas, amounts.map(a => tx.pure.u64(a)));

  const receipts = [];
  for (let i = 0; i < NUM_RECEIPTS; i++) {
    const receipt = tx.moveCall({
      target: `${PACKAGE_ID}::staking::stake`,
      arguments: [tx.object(POOL_ID), splitCoins[i], tx.object(CLOCK_ID)],
    });
    receipts.push(receipt);
  }

  tx.transferObjects(receipts, address);

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Failed: ${result.effects?.status?.error}`);
  }
  console.log(`Created. Digest: ${result.digest}`);
}

async function claimFlag(receiptIds: string[]) {
  console.log(`Updating, merging ${receiptIds.length} receipts, and claiming flag...`);

  const tx = new Transaction();

  // Update each receipt then fold into a running merge
  let merged: any = null;
  for (const id of receiptIds) {
    const updated = tx.moveCall({
      target: `${PACKAGE_ID}::staking::update_receipt`,
      arguments: [tx.object(id), tx.object(CLOCK_ID)],
    });
    merged = merged === null
      ? updated
      : tx.moveCall({
          target: `${PACKAGE_ID}::staking::merge_receipts`,
          arguments: [merged, updated, tx.object(CLOCK_ID)],
        });
  }

  const claim = tx.moveCall({
    target: `${PACKAGE_ID}::staking::claim_flag`,
    arguments: [tx.object(POOL_ID), merged, tx.object(CLOCK_ID)],
  });

  // claim[0] = Flag, claim[1] = Coin<SUI>
  tx.transferObjects([claim[0], claim[1]], address);

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Claim failed: ${result.effects?.status?.error}`);
  }

  const flagObj = result.objectChanges
    ?.filter(c => c.type === 'created')
    .find(o => (o as any).objectType?.includes('flag::Flag'));

  console.log(`Flag claimed! Digest: ${result.digest}`);
  if (flagObj) console.log(`Flag object ID: ${(flagObj as any).objectId}`);
}

(async () => {
  console.log('Wallet:', address);
  let flagCount = 0;

  while (true) {
    let receipts = await getReceipts();

    if (receipts.length === 0) {
      await createReceipts();
      receipts = await getReceipts();
    }

    // Check how long ago receipts were staked
    const stakeTimestamp = Math.min(...receipts.map(r => r.timestamp));
    const remainingMs = WAIT_MS - (Date.now() - stakeTimestamp);

    if (remainingMs > 0) {
      const readyAt = new Date(Date.now() + remainingMs).toLocaleTimeString();
      console.log(`\nWaiting ${Math.ceil(remainingMs / 60000)} min for receipts to mature (ready at ${readyAt})...`);

      const start = Date.now();
      while (Date.now() - start < remainingMs) {
        await sleep(Math.min(60_000, remainingMs - (Date.now() - start)));
        const left = Math.ceil((remainingMs - (Date.now() - start)) / 60000);
        if (left > 0) console.log(`  ${left} min remaining...`);
      }
    }

    await claimFlag(receipts.map(r => r.id));
    flagCount++;
    console.log(`Total flags claimed: ${flagCount}\n`);
    // SUI is returned by claim_flag — loop immediately to restake
  }
})();
