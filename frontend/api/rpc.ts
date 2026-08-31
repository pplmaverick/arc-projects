import type { VercelRequest, VercelResponse } from '@vercel/node'

// Server-side only — never VITE_-prefixed, so it's never bundled into client JS.
// Falls back to the public Arc testnet RPC when unset, mirroring hardhat.config.ts's
// own ARC_RPC_URL fallback, so preview/local deploys work (rate-limited) without the secret.
const UPSTREAM_RPC_URL = process.env.ALCHEMY_RPC_URL ?? 'https://rpc.testnet.arc.network'

// Read-only methods only. Nothing that moves funds or touches wallet/node state can reach
// Alchemy through this proxy — write transactions go through the user's injected wallet
// directly (see wagmiConfig's `injected()` connector), never through this transport.
const ALLOWED_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
  'net_version',
])

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

function methodNotAllowedError(req: JsonRpcRequest) {
  return {
    jsonrpc: '2.0' as const,
    id: req.id ?? null,
    error: { code: -32601, message: `Method not allowed: ${req.method ?? 'unknown'}` },
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body as JsonRpcRequest | JsonRpcRequest[]
  const requests = Array.isArray(body) ? body : [body]

  const hasDisallowed = requests.some((r) => !r?.method || !ALLOWED_METHODS.has(r.method))
  if (hasDisallowed) {
    // Fail the whole batch, but still return one response per id — a single unmatched id
    // would otherwise leave the caller's request for that id waiting forever.
    const errors = requests.map((r) =>
      r?.method && ALLOWED_METHODS.has(r.method)
        ? { jsonrpc: '2.0' as const, id: r.id ?? null, error: { code: -32000, message: 'Rejected: batch contains a disallowed method' } }
        : methodNotAllowedError(r)
    )
    return res.status(200).json(Array.isArray(body) ? errors : errors[0])
  }

  const upstream = await fetch(UPSTREAM_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await upstream.json()
  res.status(upstream.status).json(data)
}
