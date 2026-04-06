import { z } from 'zod';
import { api } from '../api-client.js';

export const agentTools = [
  {
    name: 'search_agents',
    description:
      'Finds other agents by name or wallet address. Use this to discover potential agent-to-agent (A2A) partners ' +
      'for collaboration or payment. Returns a list of agents with their safeAddress and active chains.',
    inputSchema: z.object({
      query: z.string().min(2).describe('Search query (name or address)'),
    }),
    handler: async (input: { query: string }) => {
      const result = await api.get<{ agents: any[] }>(`/v1/agents/search?q=${encodeURIComponent(input.query)}`);
      return result;
    },
  },

  {
    name: 'pay_agent',
    description:
      'Constructs and executes a direct payment to another agent. ' +
      'Use this to pay for services, data, or compute provided by another AI agent.',
    inputSchema: z.object({
      recipient_address: z.string().describe('The safeAddress of the recipient agent.'),
      amount: z.string().describe('Amount to pay in human-readable units (e.g. "0.01").'),
      token_symbol: z.string().default('ETH').describe('Token to pay with (ETH, USDC, etc.).'),
      chain_id: z.number().default(1).describe('Chain ID for the payment.'),
      reason: z.string().describe('The logical reason for this payment (for auditability).'),
    }),
    handler: async (input: {
      recipient_address: string;
      amount: string;
      token_symbol: string;
      chain_id: number;
      reason: string;
    }) => {
      // In a real implementation, this would call /v1/transactions/transfer
      // For now, we simulate the intent-aware construction
      const result = await api.post<{ transactionId: string; status: string }>('/v1/transactions/transfer', {
        recipient: input.recipient_address,
        amount: input.amount,
        token: input.token_symbol,
        chainId: input.chain_id,
        reason: input.reason,
      });

      return {
        ...result,
        message: `Payment of ${input.amount} ${input.token_symbol} to ${input.recipient_address} initiated.`,
        intent_audit: `Reason provided: ${input.reason}`,
      };
    },
  },

  {
    name: 'request_policy_update',
    description:
      'Autonomously requests a change to the agent\'s own operational policy. ' +
      'Use this when you need higher limits, more allowed tokens, or contract whitelisting to complete a mission. ' +
      'The request must be justified by your current goals.',
    inputSchema: z.object({
      max_value_per_tx_eth: z.string().optional().describe('Requested new max ETH per transaction.'),
      allowed_tokens: z.array(z.string()).optional().describe('New tokens to add to whitelist.'),
      allowed_contracts: z.array(z.string()).optional().describe('New contracts to add to whitelist.'),
      reason: z.string().describe('Detailed justification for why this policy change is needed.'),
    }),
    handler: async (input: {
      max_value_per_tx_eth?: string;
      allowed_tokens?: string[];
      allowed_contracts?: string[];
      reason: string;
    }) => {
      // Get current agent ID first
      const me = await api.get<{ id: string }>('/v1/agents/me');
      
      const result = await api.patch(`/v1/agents/${me.id}/policy`, {
        maxValuePerTxEth: input.max_value_per_tx_eth,
        allowedTokens: input.allowed_tokens,
        allowedContracts: input.allowed_contracts,
      });

      return {
        success: true,
        updatedPolicy: result,
        audit: `Policy update requested autonomously. Reason: ${input.reason}`,
      };
    },
  },

  {
    name: 'set_my_manifest',
    description:
      'Sets the agent\'s service manifest. Use this to broadcast your capabilities to other agents ' +
      '(e.g., "I provide risk analysis", "I offer liquidity data"). The manifest should be a structured JSON ' +
      'describing your services and their pricing/parameters.',
    inputSchema: z.object({
      manifest: z.record(z.any()).describe('JSON object describing provided services, tools, and pricing.'),
    }),
    handler: async (input: { manifest: Record<string, any> }) => {
      const result = await api.patch('/v1/agents/me/manifest', {
        manifest: input.manifest,
      });
      return result;
    },
  },

  {
    name: 'get_agent_manifest',
    description:
      'Fetches the service manifest of another agent by their ID. Use this to understand what ' +
      'services another agent provides before attempting a payment or collaboration.',
    inputSchema: z.object({
      agent_id: z.string().describe('The ID of the agent to query.'),
    }),
    handler: async (input: { agent_id: string }) => {
      const result = await api.get(`/v1/agents/${input.agent_id}/manifest`);
      return result;
    },
  },

  {
    name: 'get_agent_trust_report',
    description:
      'Fetches the reputation and trust metrics of another agent. Use this to evaluate a peer\'s ' +
      'reliability (transaction count, age, reputation score) before collaborating.',
    inputSchema: z.object({
      agent_id: z.string().describe('The ID of the agent to evaluate.'),
    }),
    handler: async (input: { agent_id: string }) => {
      const result = await api.get(`/v1/agents/${input.agent_id}/trust-report`);
      return result;
    },
  },

  {
    name: 'sign_handshake',
    description:
      'Signs a message with your agent wallet. Use this to prove your identity to other agents ' +
      'or to sign a service agreement/handshake.',
    inputSchema: z.object({
      message: z.string().describe('The message or agreement text to sign.'),
    }),
    handler: async (input: { message: string }) => {
      const result = await api.post('/v1/agents/me/sign-handshake', {
        message: input.message,
      });
      return result;
    },
  },

  {
    name: 'verify_handshake',
    description:
      'Verifies a signature provided by another agent. Use this to confirm that a peer ' +
      'truly controls the wallet address they claim to represent.',
    inputSchema: z.object({
      message: z.string().describe('The original message that was signed.'),
      signature: z.string().describe('The signature hex string provided by the peer.'),
      address: z.string().describe('The claimed safeAddress of the peer.'),
    }),
    handler: async (input: { message: string; signature: string; address: string }) => {
      const result = await api.post('/v1/agents/verify-handshake', {
        message: input.message,
        signature: input.signature,
        address: input.address,
      });
      return result;
    },
  },

  {
    name: 'post_job',
    description:
      'Submits a service request (job) to another agent. Use this to delegate tasks ' +
      'defined in the provider\'s manifest. You should sign the payload before posting.',
    inputSchema: z.object({
      provider_id: z.string().describe('The ID of the agent you are hiring.'),
      payload: z.record(z.any()).describe('The task details (e.g., input data, command).'),
      reward_amount: z.string().optional().describe('Amount you agree to pay upon completion.'),
      reward_token: z.string().default('ETH').optional().describe('Token for the reward.'),
      signature: z.string().optional().describe('Your signature of the payload (use sign_handshake).'),
    }),
    handler: async (input: {
      provider_id: string;
      payload: Record<string, any>;
      reward_amount?: string;
      reward_token?: string;
      signature?: string;
    }) => {
      const result = await api.post('/v1/jobs', {
        providerId: input.provider_id,
        payload: input.payload,
        reward: input.reward_amount ? {
          amount: input.reward_amount,
          token: input.reward_token,
        } : undefined,
        signature: input.signature,
      });
      return result;
    },
  },

  {
    name: 'check_inbox',
    description:
      'Checks for new service requests (jobs) assigned to you by other agents. ' +
      'Returns a list of PENDING and ACCEPTED jobs.',
    inputSchema: z.object({}),
    handler: async () => {
      const result = await api.get('/v1/jobs/inbox');
      return result;
    },
  },

  {
    name: 'update_job_status',
    description:
      'Updates the status of a job (Accept, Complete, Fail). Use this to manage ' +
      'your workflow as a service provider.',
    inputSchema: z.object({
      job_id: z.string().describe('The ID of the job to update.'),
      status: z.enum(['ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED']).describe('The new status.'),
      result: z.record(z.any()).optional().describe('The output or proof of work (if completed).'),
    }),
    handler: async (input: {
      job_id: string;
      status: 'ACCEPTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
      result?: Record<string, any>;
    }) => {
      const result = await api.patch(`/v1/jobs/${input.job_id}`, {
        status: input.status,
        result: input.result,
      });
      return result;
    },
  },
];
