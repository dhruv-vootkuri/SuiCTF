import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID = "0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03";
const USDC_TYPE = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const COST = 3_849_000n;

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiJsonRpcClient({ url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' });

(async () => {
  const address = keypair.getPublicKey().toSuiAddress();
  console.log("Wallet:", address);

  // Get all USDC coins
  const { data: usdcCoins } = await suiClient.getCoins({ owner: address, coinType: USDC_TYPE });

  const totalBalance = usdcCoins.reduce((sum, c) => sum + BigInt(c.balance), 0n);
  console.log(`USDC balance: ${totalBalance} (need ${COST})`);

  if (totalBalance < COST) {
    console.error(`Insufficient USDC. Get testnet USDC from: https://faucet.circle.com/`);
    console.error(`Select "Sui Testnet" and enter your wallet address: ${address}`);
    process.exit(1);
  }

  const tx = new Transaction();

  // Merge all USDC coins into the first if there are multiple
  const primaryCoin = tx.object(usdcCoins[0].coinObjectId);
  if (usdcCoins.length > 1) {
    tx.mergeCoins(primaryCoin, usdcCoins.slice(1).map(c => tx.object(c.coinObjectId)));
  }

  // Split exactly COST from the primary coin
  const [paymentCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(COST)]);

  // Buy the flag
  const flag = tx.moveCall({
    target: `${PACKAGE_ID}::merchant::buy_flag`,
    arguments: [paymentCoin],
  });

  tx.transferObjects([flag], address);

  console.log("Submitting transaction...");
  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });

  console.log("Transaction digest:", result.digest);

  const created = result.objectChanges?.filter(c => c.type === 'created') ?? [];
  const flagObj = created.find(o => o.type === 'created' && (o as any).objectType?.includes('flag::Flag'));

  if (flagObj && flagObj.type === 'created') {
    const details = await suiClient.getObject({
      id: (flagObj as any).objectId,
      options: { showContent: true, showDisplay: true },
    });
    console.log("Flag object:", JSON.stringify(details.data, null, 2));
  } else {
    console.log("Effects status:", result.effects?.status);
    console.log("Created objects:", JSON.stringify(created, null, 2));
  }
})();
