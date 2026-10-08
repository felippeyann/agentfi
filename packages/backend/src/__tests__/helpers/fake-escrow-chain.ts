/**
 * In-memory EVM stand-in for the C3c regression suite: just enough of a node,
 * `AgentJobEscrow`, USDC and the ERC-8004 Identity Registry to run the real
 * orchestrator, the real transaction processor and the real SubmitterService
 * against it.
 *
 * What it models (because the bugs live there):
 *  - per-sender nonces, a mempool, `pending` vs `latest` transaction counts,
 *    and "nonce too low" for a second transaction signed with a used nonce;
 *  - signed raw transactions (real ECDSA, sender recovered from the
 *    signature), receipts, `getTransaction` for pending/mined hashes;
 *  - the escrow state machine with the contract's own guards (status, caller,
 *    expectedBudget, funding window, allowance + balance on `fund`, expiry on
 *    `claimRefund`), so a second `fund` reverts once the first mined and a
 *    short allowance makes `fund` revert, exactly as on-chain;
 *  - failure knobs: mine automatically or on demand, drop a broadcast's
 *    response while keeping the transaction, hide a hash from the RPC.
 *
 * What it does not model: gas, blocks with more than one sender interleaving
 * semantics beyond nonce order, hooks (no ReputationHook — feedback is
 * covered by the fork suite).
 */

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { IDENTITY_REGISTRY_ABI } from '../../abi/IdentityRegistry.abi.js';

export const SIM_CHAIN_ID = 84532;
export const SIM_ESCROW = getAddress('0x00000000000000000000000000000000000e5c20');
export const SIM_USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
export const SIM_REGISTRY = getAddress('0x8004a818bfb912233c491871b3d84c89a494bd9e');
export const SIM_HOOK = getAddress('0x000000000000000000000000000000000000400c');

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const JobStatus = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 } as const;

export interface SimJob {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
  providerAgentId: bigint;
  deliverable: Hex | null;
}

interface PendingTx {
  hash: Hex;
  from: Address;
  nonce: number;
  to: Address;
  data: Hex;
}

class Revert extends Error {}

function lower(a: string): string {
  return a.toLowerCase();
}

function makeLog(abi: Abi, eventName: string, args: Record<string, unknown>, address: Address, txHash: Hex): Log {
  const item = getAbiItem({ abi, name: eventName }) as unknown as { inputs: Array<{ name: string; type: string; indexed?: boolean }> };
  const topics = encodeEventTopics({ abi, eventName, args } as never);
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length
    ? encodeAbiParameters(
        nonIndexed.map((i) => ({ name: i.name, type: i.type })),
        nonIndexed.map((i) => args[i.name]),
      )
    : '0x';
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: 1n,
    blockHash: '0x00' as Hex,
    transactionHash: txHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

export class FakeEscrowChain {
  /** Seconds since epoch as the chain sees it. */
  time = BigInt(Math.floor(Date.now() / 1000));
  /** Execute each accepted transaction immediately (one block per transaction). */
  autoMine = true;

  readonly jobs = new Map<bigint, SimJob>();
  private nextJobId = 1n;
  private nextAgentId = 1n;
  readonly identityOwners = new Map<bigint, Address>();
  readonly usdc = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  readonly nativeBalances = new Map<string, bigint>();

  private readonly latestNonce = new Map<string, number>();
  private mempool: PendingTx[] = [];
  private readonly receipts = new Map<Hex, TransactionReceipt>();
  private readonly known = new Map<Hex, PendingTx>();
  private readonly hidden = new Set<Hex>();
  private evaluatorTxSeq = 0n;

  /**
   * Broadcasts whose RPC answer is lost (the node keeps the tx, the caller
   * gets an error). With `hide`, the RPC also stops returning the hash (a
   * load-balanced node that never saw it), so the submitter cannot find out.
   */
  dropResponse: ((tx: { from: Address; functionName: string }) => boolean) | null = null;
  dropResponseHide = false;
  /** Broadcasts the node refused (nonce collisions and the like). */
  readonly rejectedBroadcasts: string[] = [];
  /** Transactions that stay in the mempool (not mined) until `release`d — a stuck or slow transaction. */
  hold: ((tx: { from: Address; functionName: string }) => boolean) | null = null;
  private readonly held = new Set<Hex>();
  /** Every accepted broadcast, in order (from, nonce, function). */
  readonly broadcasts: Array<{ from: Address; nonce: number; functionName: string; hash: Hex }> = [];
  /** Evaluator calls, in order. */
  readonly evaluatorCalls: Array<{ functionName: string; jobId: bigint; reason?: Hex }> = [];

  // ── accounts ────────────────────────────────────────────────────────────

  mintUsdc(owner: Address, amount: bigint): void {
    this.usdc.set(lower(owner), (this.usdc.get(lower(owner)) ?? 0n) + amount);
  }

  usdcOf(owner: Address): bigint {
    return this.usdc.get(lower(owner)) ?? 0n;
  }

  allowance(owner: Address, spender: Address): bigint {
    return this.allowances.get(`${lower(owner)}:${lower(spender)}`) ?? 0n;
  }

  // ── node ────────────────────────────────────────────────────────────────

  private pendingCount(address: string): number {
    return this.mempool.filter((tx) => lower(tx.from) === lower(address)).length;
  }

  getTransactionCount(address: string, blockTag: 'latest' | 'pending' = 'latest'): number {
    const latest = this.latestNonce.get(lower(address)) ?? 0;
    return blockTag === 'pending' ? latest + this.pendingCount(address) : latest;
  }

  async sendRawTransaction(serialized: Hex): Promise<Hex> {
    const parsed = parseTransaction(serialized);
    const from = getAddress(await recoverTransactionAddress({ serializedTransaction: serialized as never }));
    const hash = keccak256(serialized);
    const nonce = Number(parsed.nonce ?? 0);
    const reject = (message: string): never => {
      this.rejectedBroadcasts.push(`${from}:${nonce}: ${message}`);
      throw new Error(message);
    };
    if (this.known.has(hash)) reject('already known');
    const expected = this.getTransactionCount(from, 'pending');
    if (nonce < expected) reject(`nonce too low: next nonce ${expected}, tx nonce ${nonce}`);
    if (nonce > expected) reject(`nonce too high: next nonce ${expected}, tx nonce ${nonce}`);
    const tx: PendingTx = { hash, from, nonce, to: getAddress(parsed.to!), data: (parsed.data ?? '0x') as Hex };
    this.mempool.push(tx);
    this.known.set(hash, tx);
    const functionName = this.functionNameOf(tx.to, tx.data);
    this.broadcasts.push({ from, nonce, functionName, hash });
    if (this.hold?.({ from, functionName })) this.held.add(hash);
    if (this.autoMine) this.mine();
    if (this.dropResponse?.({ from, functionName })) {
      this.dropResponse = null;
      if (this.dropResponseHide) this.hidden.add(hash);
      throw new Error('socket hang up (the node took the transaction, the answer was lost)');
    }
    return hash;
  }

  /**
   * Executes pending transactions in arrival order. A held transaction stays
   * pending, and so does every later transaction of its sender (nonce order).
   */
  mine(): number {
    const remaining: PendingTx[] = [];
    const blocked = new Set<string>();
    let mined = 0;
    for (const tx of this.mempool) {
      if (this.held.has(tx.hash) || blocked.has(lower(tx.from))) {
        blocked.add(lower(tx.from));
        remaining.push(tx);
        continue;
      }
      const { status, logs } = this.execute(tx.from, tx.to, tx.data, tx.hash);
      this.latestNonce.set(lower(tx.from), tx.nonce + 1);
      this.receipts.set(tx.hash, this.receipt(tx.hash, status, logs));
      mined++;
    }
    this.mempool = remaining;
    return mined;
  }

  /** Lets a held transaction be mined (and mines). */
  release(hash: Hex): void {
    this.held.delete(hash);
    this.mine();
  }

  /** The RPC no longer returns this hash (load-balanced node behind, mempool eviction). */
  hideFromRpc(hash: Hex): void {
    this.hidden.add(hash);
  }

  unhide(hash: Hex): void {
    this.hidden.delete(hash);
  }

  /** Forgets a pending transaction (evicted from every mempool). */
  evict(hash: Hex): void {
    this.mempool = this.mempool.filter((tx) => tx.hash !== hash);
    this.held.delete(hash);
  }

  /** Re-injects an evicted transaction (somebody re-broadcast it) and mines it. */
  reinject(hash: Hex): void {
    const tx = this.known.get(hash);
    if (!tx || this.receipts.has(hash)) return;
    this.mempool.push(tx);
    this.mine();
  }

  getReceipt(hash: Hex): TransactionReceipt {
    const receipt = this.receipts.get(hash);
    if (!receipt || this.hidden.has(hash)) throw new TransactionReceiptNotFoundError({ hash });
    return receipt;
  }

  getTransaction(hash: Hex): { hash: Hex; nonce: number } {
    const tx = this.known.get(hash);
    const pending = this.mempool.some((p) => p.hash === hash);
    if (!tx || this.hidden.has(hash) || (!pending && !this.receipts.has(hash))) {
      throw new TransactionNotFoundError({ hash });
    }
    return { hash, nonce: tx.nonce };
  }

  private receipt(hash: Hex, status: 'success' | 'reverted', logs: Log[]): TransactionReceipt {
    return {
      status,
      logs,
      gasUsed: 21_000n,
      effectiveGasPrice: 1n,
      transactionHash: hash,
      blockNumber: 1n,
    } as unknown as TransactionReceipt;
  }

  /** viem-shaped read client used by the orchestrator and the re-poll. */
  get publicClient() {
    return {
      readContract: async (params: { address: Address; functionName: string; args?: readonly unknown[] }) => this.read(params),
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => this.getReceipt(hash),
      getTransaction: async ({ hash }: { hash: Hex }) => this.getTransaction(hash),
      getBalance: async ({ address }: { address: Address }) => this.nativeBalances.get(lower(address)) ?? 10n ** 18n,
    };
  }

  /** viem-shaped client for SubmitterService (`client` dep). */
  get rpcClient() {
    return {
      estimateGas: async () => 100_000n,
      getTransactionCount: async ({ address, blockTag }: { address: Address; blockTag?: 'latest' | 'pending' }) =>
        this.getTransactionCount(address, blockTag === 'pending' ? 'pending' : 'latest'),
      getGasPrice: async () => 1_000_000_000n,
      getChainId: async () => SIM_CHAIN_ID,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => this.sendRawTransaction(serializedTransaction),
      getTransaction: async ({ hash }: { hash: Hex }) => this.getTransaction(hash),
    };
  }

  /** The evaluator signer (operator key): executes directly, one receipt per call. */
  evaluatorSigner(evaluator: Address) {
    return {
      address: evaluator,
      chainId: SIM_CHAIN_ID,
      writeContract: async (params: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => {
        const data = encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args } as never);
        const hash = `0x${(++this.evaluatorTxSeq).toString(16).padStart(64, 'e')}` as Hex;
        // A real evaluator simulates first: a revert surfaces before sending.
        const snapshot = this.snapshot();
        const { status, logs } = this.execute(evaluator, params.address, data, hash);
        if (status !== 'success') {
          this.restore(snapshot);
          throw new Error(`simulation reverted: ${params.functionName}`);
        }
        this.evaluatorCalls.push({
          functionName: params.functionName,
          jobId: params.args[0] as bigint,
          ...(params.functionName === 'reject' || params.functionName === 'complete' ? { reason: params.args[1] as Hex } : {}),
        });
        this.receipts.set(hash, this.receipt(hash, status, logs));
        return hash;
      },
      waitForTransactionReceipt: async (hash: Hex) => this.getReceipt(hash),
    };
  }

  private snapshot() {
    return {
      jobs: new Map([...this.jobs].map(([k, v]) => [k, { ...v }])),
      usdc: new Map(this.usdc),
      allowances: new Map(this.allowances),
    };
  }

  private restore(s: ReturnType<FakeEscrowChain['snapshot']>) {
    this.jobs.clear();
    for (const [k, v] of s.jobs) this.jobs.set(k, v);
    this.usdc.clear();
    for (const [k, v] of s.usdc) this.usdc.set(k, v);
    this.allowances.clear();
    for (const [k, v] of s.allowances) this.allowances.set(k, v);
  }

  // ── contracts ───────────────────────────────────────────────────────────

  private functionNameOf(to: Address, data: Hex): string {
    try {
      if (lower(to) === lower(SIM_ESCROW)) return decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data }).functionName;
      if (lower(to) === lower(SIM_USDC)) return decodeFunctionData({ abi: ERC20_ABI, data }).functionName;
      if (lower(to) === lower(SIM_REGISTRY)) return decodeFunctionData({ abi: IDENTITY_REGISTRY_ABI, data }).functionName;
    } catch {
      return 'unknown';
    }
    return 'unknown';
  }

  private read(params: { address: Address; functionName: string; args?: readonly unknown[] }): unknown {
    if (params.functionName === 'token') return SIM_USDC;
    if (params.functionName === 'getJob') {
      const job = this.jobs.get(params.args![0] as bigint);
      if (!job) {
        return { id: 0n, client: '0x0000000000000000000000000000000000000000', provider: '0x0000000000000000000000000000000000000000', evaluator: '0x0000000000000000000000000000000000000000', description: '', budget: 0n, expiredAt: 0n, status: 0, hook: '0x0000000000000000000000000000000000000000' };
      }
      return { ...job };
    }
    if (params.functionName === 'allowance') return this.allowance(params.args![0] as Address, params.args![1] as Address);
    throw new Error(`FakeEscrowChain: unexpected read ${params.functionName}`);
  }

  private execute(from: Address, to: Address, data: Hex, hash: Hex): { status: 'success' | 'reverted'; logs: Log[] } {
    const snapshot = this.snapshot();
    try {
      const logs = this.call(from, to, data, hash);
      return { status: 'success', logs };
    } catch (err) {
      if (!(err instanceof Revert)) throw err;
      this.restore(snapshot);
      return { status: 'reverted', logs: [] };
    }
  }

  private job(id: bigint): SimJob {
    const job = this.jobs.get(id);
    if (!job) throw new Revert('unknown job');
    return job;
  }

  private call(from: Address, to: Address, data: Hex, hash: Hex): Log[] {
    if (lower(to) === lower(SIM_USDC)) {
      const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data });
      if (functionName !== 'approve') throw new Revert('usdc: unsupported');
      const [spender, amount] = args as readonly [Address, bigint];
      this.allowances.set(`${lower(from)}:${lower(spender)}`, amount);
      return [];
    }
    if (lower(to) === lower(SIM_REGISTRY)) {
      const { functionName, args } = decodeFunctionData({ abi: IDENTITY_REGISTRY_ABI, data });
      if (functionName !== 'register') throw new Revert('registry: unsupported');
      const agentId = this.nextAgentId++;
      const agentURI = (args?.[0] as string | undefined) ?? '';
      this.identityOwners.set(agentId, from);
      return [makeLog(IDENTITY_REGISTRY_ABI as unknown as Abi, 'Registered', { agentId, agentURI, owner: from }, SIM_REGISTRY, hash)];
    }
    if (lower(to) !== lower(SIM_ESCROW)) throw new Revert('no code');

    const { functionName, args } = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data });
    const a = args as readonly unknown[];
    const escrowLog = (eventName: string, eventArgs: Record<string, unknown>) =>
      makeLog(AGENT_JOB_ESCROW_ABI as unknown as Abi, eventName, eventArgs, SIM_ESCROW, hash);

    switch (functionName) {
      case 'createJob': {
        const [provider, evaluator, expiredAt, description, hook] = a as [Address, Address, bigint, string, Address];
        if (expiredAt <= this.time) throw new Revert('InvalidExpiry');
        const id = this.nextJobId++;
        this.jobs.set(id, {
          id, client: from, provider, evaluator, description, budget: 0n, expiredAt, status: JobStatus.Open, hook,
          providerAgentId: 0n, deliverable: null,
        });
        return [escrowLog('JobCreated', { jobId: id, client: from, provider, evaluator, expiredAt, hook })];
      }
      case 'setBudget': {
        const [id, amount] = a as [bigint, bigint];
        const job = this.job(id);
        if (job.status !== JobStatus.Open) throw new Revert('InvalidStatus');
        if (lower(from) !== lower(job.client) && lower(from) !== lower(job.provider)) throw new Revert('Unauthorized');
        job.budget = amount;
        return [];
      }
      case 'fund': {
        const [id, expected] = a as [bigint, bigint];
        const job = this.job(id);
        if (job.status !== JobStatus.Open) throw new Revert('InvalidStatus');
        if (lower(from) !== lower(job.client)) throw new Revert('Unauthorized');
        if (job.budget !== expected || job.budget === 0n) throw new Revert('BudgetMismatch');
        if (this.time >= job.expiredAt) throw new Revert('FundingWindowClosed');
        const key = `${lower(from)}:${lower(SIM_ESCROW)}`;
        const allowance = this.allowances.get(key) ?? 0n;
        if (allowance < job.budget) throw new Revert('ERC20InsufficientAllowance');
        if (this.usdcOf(from) < job.budget) throw new Revert('ERC20InsufficientBalance');
        this.allowances.set(key, allowance - job.budget);
        this.usdc.set(lower(from), this.usdcOf(from) - job.budget);
        this.usdc.set(lower(SIM_ESCROW), this.usdcOf(SIM_ESCROW) + job.budget);
        job.status = JobStatus.Funded;
        return [];
      }
      case 'setProviderAgentId': {
        const [id, agentId] = a as [bigint, bigint];
        const job = this.job(id);
        if (job.status !== JobStatus.Open && job.status !== JobStatus.Funded) throw new Revert('InvalidStatus');
        if (lower(from) !== lower(job.client) && lower(from) !== lower(job.provider)) throw new Revert('Unauthorized');
        job.providerAgentId = agentId;
        return [];
      }
      case 'submit': {
        const [id, deliverable] = a as [bigint, Hex];
        const job = this.job(id);
        if (job.status !== JobStatus.Funded) throw new Revert('InvalidStatus');
        if (lower(from) !== lower(job.provider)) throw new Revert('Unauthorized');
        job.status = JobStatus.Submitted;
        job.deliverable = deliverable;
        return [];
      }
      case 'complete': {
        const [id, reason] = a as [bigint, Hex];
        const job = this.job(id);
        if (job.status !== JobStatus.Submitted) throw new Revert('InvalidStatus');
        if (lower(from) !== lower(job.evaluator)) throw new Revert('Unauthorized');
        const fee = (job.budget * 30n) / 10_000n;
        job.status = JobStatus.Completed;
        this.usdc.set(lower(SIM_ESCROW), this.usdcOf(SIM_ESCROW) - job.budget);
        this.usdc.set(lower(job.provider), this.usdcOf(job.provider) + job.budget - fee);
        return [
          escrowLog('JobCompleted', { jobId: id, evaluator: from, reason }),
          escrowLog('PaymentReleased', { jobId: id, provider: job.provider, amount: job.budget - fee }),
          escrowLog('PlatformFeeAccrued', { jobId: id, amount: fee }),
        ];
      }
      case 'reject': {
        const [id, reason] = a as [bigint, Hex];
        const job = this.job(id);
        const status = job.status;
        if (status === JobStatus.Open) {
          if (lower(from) !== lower(job.client)) throw new Revert('Unauthorized');
        } else if (status === JobStatus.Funded || status === JobStatus.Submitted) {
          if (lower(from) !== lower(job.evaluator)) throw new Revert('Unauthorized');
        } else {
          throw new Revert('InvalidStatus');
        }
        job.status = JobStatus.Rejected;
        const logs = [escrowLog('JobRejected', { jobId: id, rejector: from, reason })];
        if (status !== JobStatus.Open) {
          this.usdc.set(lower(SIM_ESCROW), this.usdcOf(SIM_ESCROW) - job.budget);
          this.usdc.set(lower(job.client), this.usdcOf(job.client) + job.budget);
          logs.push(escrowLog('Refunded', { jobId: id, client: job.client, amount: job.budget }));
        }
        return logs;
      }
      case 'claimRefund': {
        const [id] = a as [bigint];
        const job = this.job(id);
        if (job.status !== JobStatus.Funded && job.status !== JobStatus.Submitted) throw new Revert('InvalidStatus');
        if (this.time < job.expiredAt) throw new Revert('NotExpired');
        job.status = JobStatus.Expired;
        this.usdc.set(lower(SIM_ESCROW), this.usdcOf(SIM_ESCROW) - job.budget);
        this.usdc.set(lower(job.client), this.usdcOf(job.client) + job.budget);
        return [escrowLog('JobExpired', { jobId: id }), escrowLog('Refunded', { jobId: id, client: job.client, amount: job.budget })];
      }
      default:
        throw new Revert(`escrow: unsupported ${functionName}`);
    }
  }
}

/** Wallet service stand-in: one real secp256k1 key per walletId (signs like LocalWalletService). */
export class FakeWallets {
  private readonly accounts = new Map<string, PrivateKeyAccount>();

  create(walletId: string): Address {
    const account = privateKeyToAccount(generatePrivateKey());
    this.accounts.set(walletId, account);
    return account.address;
  }

  async signTransaction(params: { walletId: string; unsignedTx: string; chainId: number }): Promise<string> {
    const account = this.accounts.get(params.walletId);
    if (!account) throw new Error(`FakeWallets: unknown wallet ${params.walletId}`);
    return account.signTransaction(parseTransaction(params.unsignedTx as Hex) as never);
  }
}
