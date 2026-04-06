# How to deposit ETH to Base — Full Tutorial

Base is a network created by Coinbase that runs "on top" of Ethereum.
Same addresses, same wallets — but 100x cheaper transactions.

---

## What you will need

- A wallet (MetaMask, Coinbase Wallet, or any other)
- A bit of ETH (0.005 ETH is enough for all tests)

---

## OPTION A — You already have ETH on an exchange (Binance, Coinbase, etc.)

This is the simplest option if you already have ETH purchased.

### Step 1 — Add the Base network to your wallet

If using MetaMask:

1. Open MetaMask
2. Click on the network list at the top (where it says "Ethereum Mainnet")
3. Click "Add network"
4. Click "Add a network manually" and fill in:

   ```
   Network Name:    Base
   RPC URL:         https://mainnet.base.org
   Chain ID:        8453
   Symbol:          ETH
   Block explorer:  https://basescan.org
   ```

5. Save and switch to the Base network

> Shortcut: you can also add it automatically at https://chainlist.org — search for "Base" and click "Add to MetaMask"

---

### Step 2 — Withdraw ETH from the exchange directly to Base

On most major exchanges (Binance, Coinbase, Bybit, etc.):

1. Go to "Withdraw"
2. Select ETH
3. For the withdrawal network, choose **"Base"** (if available)
4. Paste the agent's wallet address:
   ```
   0x61fb281349dB2f4B790472679B65002BbbD90ea3
   ```
5. Amount: `0.005 ETH`
6. Confirm the withdrawal

⚠️ **Attention:** always choose the **Base** network, not "ERC-20" (which is Ethereum mainnet).
If you send via the wrong network, the funds will be on another network and won't arrive where they are needed.

Coinbase supports direct withdrawal to Base without extra fees.
Binance charges a small fee but works normally.

---

## OPTION B — You have ETH on Ethereum mainnet and want to move it to Base

In this case, you need a "bridge".

### Official Base Bridge (Safest)

1. Access https://bridge.base.org
2. Connect your wallet
3. Select:
   - From: Ethereum
   - To: Base
   - Token: ETH
   - Amount: 0.005 ETH
4. Click "Bridge"
5. Confirm the transaction in MetaMask

Time: ~10 minutes
Fee: ~$1-3 in Ethereum gas

---

## OPTION C — You have USDC or another stablecoin

If you prefer to test with USDC instead of ETH:

1. Use the bridge above but send USDC instead of ETH
2. Also send 0.001 ETH separately to pay for gas (ETH is always required for gas, even if the swap is in USDC)
3. Agent address: `0x61fb281349dB2f4B790472679B65002BbbD90ea3`

---

## How to verify it arrived

Access: https://basescan.org/address/0x61fb281349dB2f4B790472679B65002BbbD90ea3

You will see:
- ETH balance
- Transaction history
- Any ERC-20 tokens that are there

This is the address's public "bank statement". Anyone can see it, but only AgentFi (via Turnkey) can move the funds.

---

## Visual Summary

```
Your exchange / personal wallet
        |
        | direct withdrawal via Base network
        | (or bridge if coming from Ethereum)
        ↓
0x61fb281349dB2f4B790472679B65002BbbD90ea3
        (test-agent-1's wallet on Base)
        |
        | controlled by Turnkey MPC
        | signed by AgentFi backend
        ↓
   DeFi Transactions (Uniswap, Aave, etc.)
```

---

## FAQ

**Can I send it to the wrong address?**
If you send via the Base network, it arrives correctly. If you send via the Ethereum network, it goes to the same address but on the Ethereum network — the funds won't appear on Base. In this case, it is recoverable: you would just need to add the Ethereum network to the agent's wallet.

**How long does it take?**
- Exchange withdrawal to Base: 5-30 minutes (depends on the exchange)
- Ethereum → Base Bridge: ~10 minutes

**Does the address change according to the network?**
No. The address `0x61fb28...` is the same on Base, Ethereum, Arbitrum, and any EVM network. What changes is which network you use to send.

**Can I recover the funds if something goes wrong?**
Yes. The operator (you) has access to the kill switch and can pause the agent at any time through the admin panel at http://localhost:3001. Funds never leave without a transaction signed by Turnkey.

---

## When to confirm

When Basescan shows a balance, let us know and we'll execute the first real swap:
the agent will swap part of the ETH for USDC via Uniswap V3 on Base, all automatically.
